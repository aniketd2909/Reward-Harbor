import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('recovers exact server order context when the content bridge and opener are missing', async () => {
  let listener; const stored = {};
  const context = vm.createContext({ AbortSignal,
    fetch: async url => {
      assert.equal(url, 'http://localhost:3000/api/checkout-context/ORDERNEW');
      return Response.json({ orderId: 'ORDERNEW', state: 'active', purchase: {
        merchantName: 'Harbor Market', amount: '63.00', currency: 'USD', category: 'drugstores', source: 'server-order',
      } });
    },
    chrome: {
      sidePanel: { setPanelBehavior: async () => {} },
      storage: { session: { get: async key => ({ [key]: stored[key] }), set: async values => Object.assign(stored, values) } },
      tabs: { query: async () => [{ id: 2 }] },
      scripting: { executeScript: async () => [{ result: { checkoutOrderId: 'ORDERNEW', cards: [{ localCardId: 'Visa:6302', network: 'Visa', last4: '6302' }],
        purchase: { amount: '', currency: 'USD', category: 'unknown', source: 'unavailable' }, page: 'sandbox-checkout' } }] },
      runtime: { onMessage: { addListener(fn) { listener = fn; } } },
    },
  });
  vm.runInContext(await readFile(new URL('../extension/background.js', import.meta.url), 'utf8'), context);
  const result = await new Promise(resolve => listener({ type: 'SCAN_ACTIVE_TAB' }, {}, resolve));
  assert.equal(result.ok, true); assert.equal(result.snapshot.purchase.category, 'drugstores');
  assert.equal(result.snapshot.purchase.amount, '63.00'); assert.equal(result.snapshot.purchase.merchantName, 'Harbor Market');
  assert.equal(stored['checkout:ORDERNEW'].purchase.source, 'server-order');
});
