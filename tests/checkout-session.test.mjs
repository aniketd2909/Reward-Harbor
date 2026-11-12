import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

async function harness({ completed = false } = {}) {
  let listener;
  const stored = {};
  const requests = [], receipts = [];
  let orderId = 'ORDER123', amount = '';
  const chrome = {
    sidePanel: { setPanelBehavior: async () => {} },
    storage: { local: { get: async () => ({ rewardHistoryToken: 'a'.repeat(64) }) }, session: {
      get: async key => ({ [key]: stored[key] }),
      set: async data => { Object.assign(stored, data); },
      remove: async key => { delete stored[key]; },
    } },
    tabs: { query: async () => [{ id: 2 }], sendMessage: async (tabId, message) => { receipts.push(message); } }, // SDK popup without openerTabId.
    scripting: { executeScript: async () => [{ result: { cards: [], checkoutOrderId: orderId, purchase: { amount, currency: 'USD', category: 'unknown', source: 'unavailable' } } }] },
    runtime: { onMessage: { addListener(fn) { listener = fn; } }, sendMessage: async () => {} },
  };
  vm.runInContext(await readFile(new URL('../extension/background.js', import.meta.url), 'utf8'), vm.createContext({ URL, chrome, AbortSignal,
    fetch: async (url, options) => { if (url.includes('/api/checkout-context/')) return Response.json({ orderId: 'ORDER123', state: completed ? 'completed' : 'active' }); requests.push(JSON.parse(options.body)); return Response.json({ transaction: { estimatedSavingsCents: 192 }, totals: { estimatedSavingsCents: 192 } }); },
  }));
  const send = (message, sender = {}) => new Promise(resolve => listener(message, sender, resolve));
  const sender = { frameId: 0, tab: { id: 1 }, url: 'http://localhost:3000/' };
  const purchase = { merchantName: 'Harbor Market', amount: '48.00', currency: 'USD', category: 'grocery' };
  return { stored, send, sender, purchase, requests, receipts, order: value => { orderId = value; }, amount: value => { amount = value; } };
}
test('session context survives popup focus without an opener and is isolated by order', async () => {
  const h = await harness();
  await h.send({ type: 'CHECKOUT_CONTEXT', payment: { orderId: 'ORDER123', state: 'active', purchase: h.purchase } }, h.sender);
  const result = await h.send({ type: 'SCAN_ACTIVE_TAB' });
  assert.equal(result.snapshot.purchase.category, 'grocery');
  assert.equal(result.snapshot.purchase.merchantName, 'Harbor Market');
  assert.equal(result.snapshot.purchase.source, 'order-session');
  h.order('OTHER456');
  const other = await h.send({ type: 'SCAN_ACTIVE_TAB' });
  assert.equal(other.snapshot.purchase.category, 'unknown');
});
test('completion forwards the observed paid card and delivers a receipt after clearing session context', async () => {
  const h = await harness();
  await h.send({ type: 'CHECKOUT_CONTEXT', payment: { orderId: 'ORDER123', state: 'active', purchase: h.purchase } }, h.sender);
  const paypalSender = { url: 'https://sandbox.paypal.com/pay/checkout?token=ORDER123', tab: { id: 2 } };
  await h.send({ type: 'FUNDING_OBSERVATION', orderId: 'ORDER123', selection: { kind: 'bank', last4: '6206' } }, paypalSender);
  await h.send({ type: 'FUNDING_OBSERVATION', orderId: 'ORDER123', selection: { kind: 'card', network: 'Amex', last4: '2402', localCardId: 'Amex:2402' }, final: true }, paypalSender);
  assert.equal(h.stored['checkout:ORDER123'].baselineSelection.kind, 'bank');
  await h.send({ type: 'CHECKOUT_CONTEXT', payment: { orderId: 'ORDER123', state: 'completed' } }, h.sender);
  assert.equal(h.requests[0].selectedFundingSource.last4, '2402');
  assert.equal(h.requests[0].selectionEvidence, 'checkout-pay-click');
  assert.equal(h.receipts.length, 0, 'Savings receipt is not injected into the merchant page');
  assert.equal(h.stored.lastRewardReceipt.totals.estimatedSavingsCents, 192);
});
test('terminal checkout states remove purchase information and prevent stale reuse', async () => {
  for (const state of ['completed', 'cancelled', 'changed', 'failed']) {
    const h = await harness();
    await h.send({ type: 'CHECKOUT_CONTEXT', payment: { orderId: 'ORDER123', state: 'active', purchase: h.purchase } }, h.sender);
    await h.send({ type: 'CHECKOUT_CONTEXT', payment: { orderId: 'ORDER123', state } }, h.sender);
    assert.equal(h.stored['checkout:ORDER123'].purchase, undefined);
    assert.equal((await h.send({ type: 'SCAN_ACTIVE_TAB' })).snapshot.purchase.source, 'checkout-ended');
  }
});
test('rejects foreign context messages and mismatched or expired context', async () => {
  const h = await harness();
  const message = { type: 'CHECKOUT_CONTEXT', payment: { orderId: 'ORDER123', state: 'active', purchase: h.purchase } };
  assert.equal((await h.send(message, { ...h.sender, url: 'https://unrelated.example/' })).ok, false);
  await h.send(message, h.sender);
  h.amount('99.00');
  assert.equal((await h.send({ type: 'SCAN_ACTIVE_TAB' })).snapshot.purchase.category, 'unknown');
  h.amount(''); await h.send(message, h.sender);
  h.stored['checkout:ORDER123'].savedAt = 0;
  assert.equal((await h.send({ type: 'SCAN_ACTIVE_TAB' })).snapshot.purchase.category, 'unknown');
});

test('polling recovers completion without a merchant completion event and finalizes only once', async () => {
  const h = await harness({ completed: true });
  await h.send({ type: 'CHECKOUT_CONTEXT', payment: { orderId: 'ORDER123', state: 'active', purchase: h.purchase } }, h.sender);
  const paypal = { url: 'https://sandbox.paypal.com/pay/checkout?token=ORDER123' };
  await h.send({ type: 'FUNDING_OBSERVATION', orderId: 'ORDER123', selection: { kind: 'card', network: 'Amex', last4: '2402' }, final: true }, paypal);
  const result = await h.send({ type: 'CHECK_COMPLETION', orderId: 'ORDER123' });
  assert.equal(result.receipt.transaction.estimatedSavingsCents, 192);
  assert.equal(h.requests[0].selectedFundingSource.last4, '2402');
  assert.equal(h.stored['checkout:ORDER123'].state, 'completed');
  await h.send({ type: 'CHECK_COMPLETION', orderId: 'ORDER123' });
  assert.equal(h.requests.length, 1);
});
