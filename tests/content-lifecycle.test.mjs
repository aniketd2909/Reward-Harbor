import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
for (const mode of ['missing-id', 'sync-throw', 'async-reject']) {
  test(`content script stops cleanly after reload: ${mode}`, async () => {
    let callback, disconnected = false, calls = 0;
    const window = new EventTarget(), document = new EventTarget();
    document.documentElement = { dataset: {} };
    const runtime = { id: 'extension', sendMessage() {
      calls++;
      if (mode === 'sync-throw') throw new Error('Extension context invalidated.');
      return Promise.reject(new Error('Extension context invalidated.'));
    } };
    vm.runInNewContext(source, {
      window, top: window, document, location: { hostname: 'sandbox.paypal.com' },
      chrome: { runtime },
      RewardExtractor: { extract: () => ({ cards: [], checkoutOrderId: 'ORDER123' }) },
      MutationObserver: class { observe() {} disconnect() { disconnected = true; } },
      setTimeout(fn) { callback = fn; return 1; }, clearTimeout() {},
    });
    if (mode === 'missing-id') runtime.id = undefined;
    callback();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(disconnected, true);
    const previousCalls = calls;
    window.dispatchEvent(new Event('reward-checkout-changed'));
    document.dispatchEvent(new Event('click'));
    assert.equal(calls, previousCalls, 'Detached listeners cannot send more messages');
    if (mode === 'missing-id') assert.equal(calls, 0);
  });
}
