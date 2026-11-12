import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const fail = (status, message) => Object.assign(new Error(message), { status });
function owner(req) {
  const token = req.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
  if (!token) throw fail(401, 'A private extension history token is required.');
  return createHash('sha256').update(token).digest('hex');
}
function estimate(selection, quote) {
  if (!selection) return null;
  if (selection.kind === 'bank') return { valueCents: 0, label: 'Bank account', basis: 'Bank funding assumed to earn no card rewards' };
  const option = quote.options.find(c => c.localCardId === selection.localCardId || (c.network === selection.network && c.last4 === selection.last4));
  return option?.estimatedValue != null ? { valueCents: Math.round(Number(option.estimatedValue) * 100), label: option.productName, localCardId: option.localCardId } : null;
}
export function createSavings({ store, file = ':memory:' }) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS reward_quotes (owner TEXT NOT NULL, order_id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(owner,order_id));
    CREATE TABLE IF NOT EXISTS reward_transactions (
      capture_id TEXT PRIMARY KEY, owner TEXT NOT NULL, order_id TEXT NOT NULL,
      completed_at TEXT NOT NULL, status TEXT NOT NULL, reward_cents INTEGER, savings_cents INTEGER,
      payload TEXT NOT NULL, UNIQUE(owner,order_id));
    CREATE INDEX IF NOT EXISTS reward_owner ON reward_transactions(owner);`);
  function summary(id) {
    const row = db.prepare(`SELECT COUNT(*) AS completedPayments, COALESCE(SUM(reward_cents),0) AS estimatedRewardsCents,
      COALESCE(SUM(savings_cents),0) AS estimatedSavingsCents,
      SUM(CASE WHEN savings_cents IS NULL THEN 1 ELSE 0 END) AS unquantifiedPayments
      FROM reward_transactions WHERE owner=?`).get(id);
    const latest = db.prepare('SELECT payload FROM reward_transactions WHERE owner=? ORDER BY completed_at DESC LIMIT 1').get(id);
    const transaction = latest ? JSON.parse(latest.payload) : null;
    return { ...row, unquantifiedPayments: row.unquantifiedPayments || 0, currency: 'USD',
      lastTransaction: transaction ? { orderId: transaction.orderId, purchase: transaction.purchase, selectedCard: transaction.selectedCard,
        estimatedSavingsCents: transaction.estimatedSavingsCents, estimatedRewardCents: transaction.estimatedRewardCents } : null,
      basis: 'Estimated reward improvement versus the first observed funding selection; issuer rewards are not confirmed.' };
  }
  function recordQuote(req, input, recommendation) {
    if (!input.orderId) return;
    const id = owner(req), order = store.data.orders[input.orderId];
    if (!order || order.result) throw fail(409, 'A current, unpaid demo order is required to track savings.');
    for (const key of ['amount', 'currency', 'merchantName', 'category']) {
      if (input.purchase[key] !== order.purchase[key]) throw fail(400, 'Savings context must match the server-owned purchase.');
    }
    const existing = db.prepare('SELECT payload FROM reward_quotes WHERE owner=? AND order_id=?').get(id, input.orderId);
    const old = existing ? JSON.parse(existing.payload) : null;
    const payload = { ...recommendation, orderId: input.orderId, quotedAt: new Date().toISOString(),
      baselineSelection: old?.baselineSelection || input.baselineSelection || null };
    db.prepare('INSERT INTO reward_quotes VALUES (?,?,?) ON CONFLICT(owner,order_id) DO UPDATE SET payload=excluded.payload').run(id, input.orderId, JSON.stringify(payload));
  }
  async function routes(req, res, url, readBody, send) {
    if (!url.pathname.startsWith('/api/savings/')) return false;
    const id = owner(req);
    if (req.method === 'GET' && url.pathname === '/api/savings/summary') { send(200, summary(id)); return true; }
    if (req.method !== 'POST' || url.pathname !== '/api/savings/finalize') throw fail(404, 'Not found.');
    const input = await readBody(req);
    if (!/^[A-Z0-9]{5,40}$/.test(input?.orderId || '')) throw fail(400, 'A valid order ID is required.');
    const record = store.data.orders[input.orderId];
    if (!record?.result || record.result.status !== 'COMPLETED') throw fail(409, 'Payment has not been verified as completed.');
    const row = db.prepare('SELECT payload FROM reward_quotes WHERE owner=? AND order_id=?').get(id, input.orderId);
    const quote = row ? JSON.parse(row.payload) : { options: [], baselineSelection: null, bestCard: null,
      assumptions: ['No recommendation snapshot was recorded before payment.'] };
    const existing = db.prepare('SELECT payload FROM reward_transactions WHERE owner=? AND order_id=?').get(id, input.orderId);
    if (existing) { send(200, { transaction: JSON.parse(existing.payload), totals: summary(id) }); return true; }
    const selected = input.selectionEvidence === 'checkout-pay-click' ? estimate(input.selectedFundingSource, quote) : null;
    const baseline = estimate(quote.baselineSelection, quote);
    const rewardCents = selected?.valueCents ?? null;
    const savingsCents = selected && baseline ? selected.valueCents - baseline.valueCents : null;
    const transaction = {
      orderId: input.orderId, captureId: record.result.captureId, completedAt: record.result.confirmedAt || new Date().toISOString(),
      purchase: record.purchase, recommendedCard: quote.bestCard?.productName || null,
      selectedCard: selected?.label || null, selectionEvidence: selected ? input.selectionEvidence : 'unknown',
      selectedFundingSource: selected ? { kind: input.selectedFundingSource.kind || 'card', network: input.selectedFundingSource.network || null,
        last4: input.selectedFundingSource.last4 || null, localCardId: input.selectedFundingSource.localCardId || null } : null,
      baselineCard: baseline?.label || null, estimatedRewardCents: rewardCents, estimatedSavingsCents: savingsCents,
      status: selected ? 'estimated' : 'selection_unknown',
      recommendationSnapshot: quote,
      note: 'Payment completion is verified. Card selection is observed in the browser; rewards and incremental savings remain estimates.',
    };
    db.prepare('INSERT INTO reward_transactions VALUES (?,?,?,?,?,?,?,?)').run(record.result.captureId, id, input.orderId,
      transaction.completedAt, transaction.status, rewardCents, savingsCents, JSON.stringify(transaction));
    send(200, { transaction, totals: summary(id) }); return true;
  }
  return { recordQuote, routes, close: () => db.close() };
}
