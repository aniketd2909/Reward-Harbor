import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const config = await readFile(new URL('../extension/config.js', import.meta.url), 'utf8');
const background = await readFile(new URL('../extension/background.js', import.meta.url), 'utf8');
const hosted = 'https://reward-harbor.onrender.com';

test('hosted permissions and shared config cover the deployed store without wildcard domains', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.ok(manifest.host_permissions.includes(hosted + '/*'));
  assert.ok(manifest.content_scripts[0].matches.includes(hosted + '/*'));
  assert.equal(manifest.content_scripts[0].js[0], 'config.js');
  assert.ok(manifest.web_accessible_resources[0].resources.includes('config.js'));
  const context = vm.createContext({ URL }); vm.runInContext(config, context);
  assert.equal(context.RewardHarborConfig.defaultApi, hosted);
  assert.equal(context.RewardHarborConfig.storeOrigin(hosted + '.evil.example/'), null);
  assert.equal(context.RewardHarborConfig.storeOrigin('http://reward-harbor.onrender.com/'), null);
});

for (const apiBase of [hosted, 'http://localhost:3000']) {
  test(`checkout context, completion polling and finalization stay on ${apiBase}`, async () => {
    let listener; const stored = {}; const calls = [];
    const purchase = { merchantName: 'Harbor Market', amount: '48.00', currency: 'USD', category: 'grocery' };
    const context = vm.createContext({ URL, AbortSignal,
      fetch: async (url, options) => {
        calls.push(url); assert.equal(new URL(url).origin, apiBase);
        if (url.includes('/checkout-context/')) return Response.json({ orderId: 'ORDERHOST', state: 'completed', purchase });
        assert.equal(JSON.parse(options.body).orderId, 'ORDERHOST');
        return Response.json({ transaction: { orderId: 'ORDERHOST', estimatedSavingsCents: 192 }, totals: { estimatedSavingsCents: 192 } });
      },
      chrome: {
        storage: { local: { get: async () => ({ rewardHistoryToken: 'a'.repeat(64) }) }, session: {
          get: async key => ({ [key]: stored[key] }), set: async values => Object.assign(stored, values),
        } },
        tabs: { query: async () => [{ id: 2, url: 'https://sandbox.paypal.com/pay/checkout' }] },
        scripting: { executeScript: async () => [{ result: { cards: [], checkoutOrderId: 'ORDERHOST', purchase: { currency: 'USD', category: 'unknown' }, page: 'https://sandbox.paypal.com/pay/checkout' } }] },
        runtime: { onMessage: { addListener(fn) { listener = fn; } }, sendMessage: async () => {} },
      },
    });
    vm.runInContext(config, context); vm.runInContext(background, context);
    const send = (message, sender = {}) => new Promise(resolve => listener(message, sender, resolve));
    const result = await send({ type: 'CHECKOUT_CONTEXT', payment: { orderId: 'ORDERHOST', state: 'active', purchase } }, { frameId: 0, tab: { id: 1 }, url: apiBase + '/' });
    assert.equal(result.ok, true);
    assert.equal(stored['checkout:ORDERHOST'].apiBase, apiBase);
    const receipt = await send({ type: 'CHECK_COMPLETION', orderId: 'ORDERHOST' });
    assert.equal(receipt.receipt.transaction.orderId, 'ORDERHOST');
    assert.equal(calls.length, 2);
    await send({ type: 'CHECK_COMPLETION', orderId: 'ORDERHOST' });
    assert.equal(calls.length, 2, 'Receipt recovery does not duplicate finalization');
  });
}
