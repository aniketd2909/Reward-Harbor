import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSavings } from '../server/savings.mjs';
import { bestCardForPurchase } from '../server/best-card.mjs';
const { cards: profiles } = JSON.parse(await readFile(new URL('../data/issuer-cards.json', import.meta.url), 'utf8'));
const purchase = { merchantName: 'Harbor Market', amount: '48.00', currency: 'USD', category: 'grocery' };
const cards = [{ network: 'Amex', last4: '2402', localCardId: 'Amex:2402' }, { network: 'Visa', last4: '6302', localCardId: 'Visa:6302' }];
const req = { headers: { authorization: `Bearer ${'a'.repeat(64)}` } };
const bank = { kind: 'bank', localCardId: 'bank:6206' };
function quoted(service, store, orderId, baselineSelection = bank) {
  store.data.orders[orderId] = { purchase };
  const input = { purchase, cards, orderId, baselineSelection };
  service.recordQuote(req, input, bestCardForPurchase(input, profiles));
}
function completed(store, orderId) {
  store.data.orders[orderId].result = { status: 'COMPLETED', captureId: `CAP${orderId}`, confirmedAt: '2026-11-12T12:00:00Z' };
}
async function call(service, path, input, request = req) {
  let result;
  await service.routes({ ...request, method: input ? 'POST' : 'GET' }, null, new URL(`http://localhost${path}`), async () => input, (status, body) => { result = { status, ...body }; });
  return result;
}
const finalize = (service, orderId, selectedFundingSource = cards[0], selectionEvidence = 'checkout-pay-click') => call(service, '/api/savings/finalize', { orderId, selectedFundingSource, selectionEvidence });

test('counts only verified completed payments and is idempotent on repeated finalization', async t => {
  const store = { data: { orders: {} } }; const service = createSavings({ store }); t.after(service.close);
  quoted(service, store, 'ORDER123');
  await assert.rejects(finalize(service, 'ORDER123'), /not been verified/);
  completed(store, 'ORDER123');
  const first = await finalize(service, 'ORDER123');
  assert.equal(first.transaction.estimatedRewardCents, 192);
  assert.equal(first.transaction.estimatedSavingsCents, 192);
  assert.equal(first.totals.completedPayments, 1);
  const retry = await finalize(service, 'ORDER123');
  assert.equal(retry.totals.completedPayments, 1); assert.equal(retry.totals.estimatedSavingsCents, 192);
});
test('savings are incremental rewards versus the frozen baseline, not total rewards', async t => {
  const store = { data: { orders: {} } }; const service = createSavings({ store }); t.after(service.close);
  quoted(service, store, 'ORDER456', cards[1]);
  // A later quote must not replace the initial Visa baseline with the recommended Amex.
  service.recordQuote(req, { purchase, cards, orderId: 'ORDER456', baselineSelection: cards[0] }, bestCardForPurchase({ purchase, cards }, profiles));
  completed(store, 'ORDER456');
  const result = await finalize(service, 'ORDER456');
  assert.equal(result.transaction.estimatedRewardCents, 192);
  assert.equal(result.transaction.estimatedSavingsCents, 120);
  assert.equal(result.transaction.baselineCard, 'Chase Freedom Unlimited');
});
test('unknown paid card or baseline does not fabricate savings', async t => {
  const store = { data: { orders: {} } }; const service = createSavings({ store }); t.after(service.close);
  quoted(service, store, 'ORDER789', null); completed(store, 'ORDER789');
  const result = await finalize(service, 'ORDER789', null, null);
  assert.equal(result.transaction.estimatedSavingsCents, null);
  assert.equal(result.transaction.estimatedRewardCents, null);
  assert.equal(result.totals.unquantifiedPayments, 1);
});
test('history survives database reopening and is isolated by installation token', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'reward-history-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'history.sqlite'); const store = { data: { orders: {} } };
  let service = createSavings({ store, file });
  quoted(service, store, 'ORDERABC'); completed(store, 'ORDERABC'); await finalize(service, 'ORDERABC'); service.close();
  service = createSavings({ store, file }); t.after(service.close);
  assert.equal((await call(service, '/api/savings/summary')).estimatedSavingsCents, 192);
  const other = await call(service, '/api/savings/summary', null, { headers: { authorization: `Bearer ${'b'.repeat(64)}` } });
  assert.equal(other.completedPayments, 0);
});
test('quote tracking rejects untrusted price changes and history requires a token', async t => {
  const store = { data: { orders: { ORDER123: { purchase } } } }; const service = createSavings({ store }); t.after(service.close);
  assert.throws(() => service.recordQuote(req, { orderId: 'ORDER123', purchase: { ...purchase, amount: '0.01' } }, {}), /server-owned purchase/);
  await assert.rejects(call(service, '/api/savings/summary', null, { headers: {} }), /token/);
});
test('cumulative savings sum independent verified captures, preserving negative differences', async t => {
  const store = { data: { orders: {} } }; const service = createSavings({ store }); t.after(service.close);
  quoted(service, store, 'ORDERONE', bank); completed(store, 'ORDERONE'); await finalize(service, 'ORDERONE');
  quoted(service, store, 'ORDERTWO', cards[0]); completed(store, 'ORDERTWO');
  const result = await finalize(service, 'ORDERTWO', cards[1]);
  assert.equal(result.transaction.estimatedSavingsCents, -120);
  assert.equal(result.totals.estimatedSavingsCents, 72);
  assert.equal(result.totals.estimatedRewardsCents, 264);
  assert.equal(result.totals.completedPayments, 2);
});
