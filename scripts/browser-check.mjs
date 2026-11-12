import { chromium } from 'playwright';
import { once } from 'node:events';
import { readFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createApp } from '../server/app.mjs';
import { rewardService } from '../server/rewards.mjs';
import { cardCatalogService } from '../server/card-catalog.mjs';
import { storefrontService } from '../server/storefront.mjs';

const rewardRoutes = rewardService();
const catalogRoutes = cardCatalogService();
const productClient = { products: {
  search: async () => ({ data: [{ id: 'coffee' }] }),
  retrieve: async () => ({ id: 'coffee', title: 'Whole bean coffee', images: [{ url: 'https://images.example/coffee.png' }], offers: [{ domain: 'merchant.example',
    price: { price: 48, currency: 'USD' }, availability: 'InStock', url: 'https://merchant.example/buy?affiliate=fresh' }] }),
} };
const storefront = storefrontService({ client: productClient });
const server = createApp({ purchaseResolver: storefront.resolvePurchase,
  recommendation: async (...args) => await storefront(...args) || await catalogRoutes(...args) || await rewardRoutes(...args) });
let browser;
let paymentServer;
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('https://images.example/**', async route => route.fulfill({ contentType: 'image/png', body: await readFile(new URL('../extension/icon.png', import.meta.url)) }));
  await page.goto(base);
  await page.locator('[data-buy]').first().waitFor();
  await page.locator('.product-card').first().scrollIntoViewIfNeeded();
  await page.waitForFunction(() => [...document.querySelectorAll('.product-visual img')].some(img => img.complete && img.naturalWidth > 0 && !img.hidden));
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/storefront.png', fullPage: true });
  await page.locator('[data-buy]').first().click();
  await page.locator('#setup:not([hidden])').waitFor();
  assert.match(await page.locator('#total').innerText(), /48\.00/);
  await page.fill('#quantity', '2'); await page.locator('#quantity').blur();
  await page.waitForFunction(() => document.querySelector('#total').textContent.includes('96.00'));
  const context = JSON.parse(await page.locator('html').getAttribute('data-reward-checkout'));
  assert.equal(context.amount, '96.00'); assert.equal(context.category, 'grocery');
  await page.screenshot({ path: 'artifacts/demo-checkout.png', fullPage: true });
  await page.locator('#close-checkout').click();
  await page.locator('[data-department="drugstores"]').click();
  await page.locator('[data-buy]').first().waitFor();
  await page.locator('[data-buy]').first().click();
  await page.waitForFunction(() => document.querySelector('#checkout-category').textContent === 'drugstores');
  await page.locator('#close-checkout').click();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

  await page.setContent(`<main>
    <button>Visa<br>Credit ••6302</button>
    <button>American Express<br>Credit ••••1234</button>
    <li>Checking account <a>••6206</a></li>
    <button hidden>Mastercard ••9999</button>
    <section><button>Visa ••6302</button><button>American Express ••1234</button></section>
  </main>`);
  await page.addScriptTag({ content: await readFile(new URL('../extension/extractor.js', import.meta.url), 'utf8') });
  const snapshot = await page.evaluate(() => RewardExtractor.extract(document, location));
  assert.equal(snapshot.cards.length, 2);
  assert.deepEqual(snapshot.cards.map(c => `${c.network}:${c.last4}`).sort(), ['Amex:1234', 'Visa:6302']);
  await page.setContent('<a href="/myaccount/money/cards/CC-ONE">Visa ••6302</a><a href="/myaccount/money/cards/CC-TWO">Visa ••6302</a>');
  const collision = await page.evaluate(() => RewardExtractor.extract(document, location));
  assert.equal(collision.cards.length, 2, 'Distinct page references preserve cards with matching suffixes');
  await page.setContent(`<main><label><input type="radio" name="plan" checked>Pay in full $142.89 today</label>
    <label><input type="radio" name="funding">Checking ••6206</label>
    <label><input type="radio" name="funding" checked>American Express Account ••2402</label>
    <label><input type="radio" name="funding">Visa Credit ••6302</label></main>`);
  const selected = await page.evaluate(() => RewardExtractor.extract(document, location).selectedFundingSource);
  assert.equal(selected.last4, '2402', 'Payment-plan radio must not be mistaken for bank funding');
  assert.equal(selected.kind, 'card');
  assert.equal(await page.evaluate(() => RewardExtractor.extract(document, new URL('https://sandbox.paypal.com/pay/checkout?token=ORDER123')).purchase.amount), '142.89');

  // Exercise our frontend callbacks and real local HTTP routes with a fake SDK/provider.
  // This does not substitute for an authenticated sandbox transaction.
  const paymentCatalog = storefrontService({ client: productClient });
  paymentServer = createApp({ configured: true, clientId: 'test-client', purchaseResolver: paymentCatalog.resolvePurchase, recommendation: paymentCatalog, paypal: {
    async create() { return { id: 'ORDER123' }; },
    async capture() { return { id: 'ORDER123', status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAP123', status: 'COMPLETED', amount: { currency_code: 'USD', value: '48.00' } }] } }] }; },
  } });
  paymentServer.listen(0, '127.0.0.1'); await once(paymentServer, 'listening');
  const paymentBase = `http://127.0.0.1:${paymentServer.address().port}`;
  await page.route('https://www.sandbox.paypal.com/web-sdk/v6/core', route => route.fulfill({ contentType: 'text/javascript', body: `
    window.paypal = { async createInstance() { return {
      async findEligibleMethods() { return { isEligible: () => true }; },
      async createPayPalOneTimePaymentSession(callbacks) { return {
        async start(options, promise) { const order = await promise;
          if (window.cancelNext) { window.cancelNext = false; callbacks.onCancel(); }
          else await callbacks.onApprove(order);
        }
      }; }
    }; } };
  ` }));
  await page.goto(paymentBase);
  await page.locator('[data-buy]').first().click();
  await page.locator('paypal-button').waitFor({ state: 'attached' });
  await page.evaluate(() => {
    window.paymentEvents = [];
    window.addEventListener('reward-payment-changed', () => window.paymentEvents.push(JSON.parse(document.documentElement.dataset.rewardPayment)));
  });
  await page.evaluate(() => { window.cancelNext = true; document.querySelector('paypal-button').click(); });
  await page.waitForFunction(() => document.querySelector('#status').textContent.includes('cancelled'));
  assert.equal(await page.locator('#quantity').isEnabled(), true);
  await page.evaluate(() => document.querySelector('paypal-button').click());
  await page.locator('#status[data-state="success"]').waitFor();
  assert.equal(await page.locator('#status').innerText(), 'Sandbox payment completed · USD 48.00');
  assert.doesNotMatch(await page.locator('#payment-success-info').innerText(), /CAP123|Capture/);
  assert.equal(await page.locator('#payment-success').isVisible(), true);
  assert.match(await page.locator('#payment-success-info').innerText(), /USD 48.00/);
  await page.locator('#payment-success').evaluate(dialog => dialog.close());
  assert.equal(await page.locator('#quantity').isDisabled(), true);
  const events = await page.evaluate(() => window.paymentEvents);
  assert.deepEqual(events.map(e => e.state), ['active', 'cancelled', 'active', 'completed']);
  assert.equal(events[0].purchase.category, 'grocery');
  assert.equal(events[0].orderId, 'ORDER123');

  // Run the actual side-panel UI with simulated Chrome APIs and the real reward API.
  // Loading an unpacked extension into a user's Chrome still needs manual verification.
  const panel = await browser.newPage({ viewport: { width: 390, height: 900 } });
  panel.on('pageerror', e => errors.push(e.message));
  await panel.route(`${base}/__panel**`, async route => {
    const path = new URL(route.request().url()).pathname;
    const file = path === '/__panel' ? 'panel.html' : path.replace('/__panel/', '');
    if (!['panel.html', 'panel.js', 'panel.css', 'config.js'].includes(file)) return route.abort();
    let source = await readFile(new URL(`../extension/${file}`, import.meta.url), 'utf8');
    if (file === 'panel.html') source = source.replace('href="panel.css"', 'href="/__panel/panel.css"').replace('src="panel.js"', 'src="/__panel/panel.js"').replace('src="config.js"', 'src="/__panel/config.js"');
    await route.fulfill({ body: source, contentType: file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html' });
  });
  await panel.route('**/api/**', async route => {
    const request = route.request();
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const url = new URL(request.url());
    const response = await fetch(base + url.pathname + url.search, { method: request.method(), ...(request.postData() ? { body: request.postData(), headers: { 'Content-Type': 'application/json' } } : {}) });
    await route.fulfill({ status: response.status, body: await response.text(), contentType: 'application/json', headers });
  });
  await panel.addInitScript(() => {
    const stored = {};
    globalThis.chrome = {
      storage: { local: { async get() { return stored; }, async set(value) { Object.assign(stored, value); } } },
      tabs: { onActivated: { addListener() {} } },
      runtime: { onMessage: { addListener(fn) { (window.extensionListeners ||= []).push(fn); } }, async sendMessage() { return { ok: true, snapshot: structuredClone(window.panelSnapshot || {
        tabId: 9, page: 'https://sandbox.paypal.com/checkoutnow', note: 'Fixture cards; visible labels only.',
        cards: [{ localCardId: 'Visa:6302', network: 'Visa', last4: '6302' }, { localCardId: 'Amex:2402', network: 'Amex', last4: '2402' }],
        purchase: { merchantName: 'Harbor Market', amount: '120.00', currency: 'USD', category: 'grocery' },
      }) }; } },
    };
  });
  await panel.goto(`${base}/__panel`);
  await panel.locator('.result.best').waitFor();
  assert.equal(await panel.locator('.result.best').count(), 1);
  assert.equal(await panel.locator('.result').count(), 2);
  assert.equal(await panel.locator('.alternatives').getAttribute('open'), null);
  await panel.locator('.alternatives > summary').click();
  assert.match(await panel.locator('.result:not(.best)').innerText(), /Chase Freedom Unlimited/);
  assert.equal(await panel.getByText('Assumptions and source', { exact: true }).count(), 0);
  assert.equal(await panel.locator('.result.best a').innerText(), 'Official issuer reward details');
  assert.match(await panel.locator('.result:not(.best) .value').innerText(), /\$1\.80/);
  await panel.locator('.result:not(.best) details').first().locator('summary').click();
  assert.match(await panel.locator('.result:not(.best)').innerText(), /dining: 3% cashback/);
  assert.match(await panel.locator('.result.best').innerText(), /American Express Gold Card/);
  assert.match(await panel.locator('.result.best').innerText(), /\$4\.80/);
  assert.equal(await panel.locator('input,select').count(), 0, 'No manual purchase editing forms');
  await panel.screenshot({ path: 'artifacts/extension-panel.png', fullPage: true });
  await panel.evaluate(() => {
    window.panelSnapshot = { tabId: 9, page: 'https://sandbox.paypal.com/checkoutnow', cards: [{ localCardId: 'Visa:6302', network: 'Visa', last4: '6302' }, { localCardId: 'Amex:2402', network: 'Amex', last4: '2402' }], purchase: { merchantName: 'Harbor Market', amount: '100.00', currency: 'USD', category: 'grocery' } };
    for (const listener of window.extensionListeners) listener({ type: 'PAGE_CHANGED' });
  });
  await panel.waitForFunction(() => document.querySelector('.result.best .value')?.textContent === '$4.00');
  assert.equal(await panel.locator('.result').count(), 2);
  await panel.locator('.alternatives > summary').click();
  assert.match(await panel.locator('.result:not(.best) .value').innerText(), /\$1\.50/);
  await panel.evaluate(() => {
    window.panelSnapshot.purchase = { merchantName: '', amount: '142.89', currency: 'USD', category: 'unknown' };
    for (const listener of window.extensionListeners) listener({ type: 'PAGE_CHANGED' });
  });
  await panel.waitForFunction(() => document.querySelector('.result .tag')?.textContent === 'DETECTED CARD');
  assert.equal(await panel.locator('.result').count(), 2);
  assert.equal(await panel.locator('.result.best,.result .value').count(), 0, 'Unknown category does not generate a best-card estimate');
  assert.match(await panel.locator('#results').innerText(), /American Express Gold Card/);

  await panel.evaluate(() => {
    for (const listener of window.extensionListeners) listener({ type: 'SAVINGS_UPDATED', receipt: {
      transaction: { estimatedSavingsCents: 120, estimatedRewardCents: 192, selectedCard: 'American Express Gold Card' },
      totals: { estimatedSavingsCents: 312, completedPayments: 2 },
    } });
  });
  assert.equal((await panel.locator('header #savings').innerText()).replace(/\s+/g, ' '), 'Estimated savings: $3.12');
  assert.match(await panel.locator('#savings').innerText(), /Estimated savings:\s+\$3\.12/);
  assert.equal(await panel.locator('#purchase-details').isHidden(), true);
  assert.equal(await panel.locator('.result').count(), 0);
  assert.equal(await panel.locator('main').isHidden(), true);
  assert.equal(await panel.locator('#status').textContent(), '');
  assert.equal(await panel.locator('#receipt-dialog').isVisible(), true);
  assert.match(await panel.locator('#receipt-content').innerText(), /Estimated savings this payment: \$1\.20/);
  await panel.screenshot({ path: 'artifacts/savings-summary.png', fullPage: true });
  await panel.locator('#close-receipt').click();
  assert.equal(await panel.locator('#receipt-dialog').isVisible(), false);
  assert.equal(await panel.locator('#savings').isVisible(), true);
  await panel.evaluate(() => {
    window.panelSnapshot = { tabId: 9, cards: [], page: 'http://localhost:3000/', purchase: { currency: 'USD', category: 'unknown' } };
    for (const listener of window.extensionListeners) listener({ type: 'PAGE_CHANGED' });
  });
  await panel.waitForFunction(() => document.querySelector('#purchase-summary').textContent.includes('Merchant unavailable'));
  assert.equal(await panel.locator('main').isHidden(), true, 'Idle storefront shows only advisor branding and savings');
  assert.equal(await panel.locator('header').isVisible(), true);
  assert.equal(await panel.locator('.banner').isVisible(), true);

  assert.equal(await panel.locator('#shopping').count(), 0, 'Shopping belongs to the main store, not the extension');
  // Use an open shadow root only in the test to inspect the isolated floating UI.
  const floating = await browser.newPage({ viewport: { width: 600, height: 800 } });
  floating.on('pageerror', e => errors.push(e.message));
  await floating.route('https://sandbox.paypal.com/**', route => route.fulfill({ body: '<html><body>PayPal fixture</body></html>', contentType: 'text/html' }));
  await floating.goto('https://sandbox.paypal.com/signin');
  await floating.evaluate(() => {
    const attach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function() { return attach.call(this, { mode: 'open' }); };
    window.chrome = { runtime: { id: 'fixture', getURL: () => 'about:blank', onMessage: { addListener() {} } } };
  });
  await floating.addScriptTag({ path: 'extension/floating.js' });
  assert.equal(await floating.locator('iframe').count(), 0, 'Do not mount on the initial login screen');
  await floating.evaluate(() => history.replaceState({}, '', '/pay/checkout?token=ORDER123'));
  await floating.locator('iframe[title="Reward Harbor card rewards advisor"]').waitFor({ state: 'visible' });
  assert.equal(await floating.locator('iframe').count(), 1, 'Login-to-checkout mounts exactly one advisor');
  await floating.getByRole('button', { name: 'Close Reward Harbor' }).click();
  assert.equal(await floating.locator('iframe').isVisible(), false);
  await floating.waitForTimeout(900);
  assert.equal(await floating.locator('iframe').isVisible(), false, 'Route polling respects dismissal');
  await floating.getByRole('button', { name: 'Open Reward Harbor' }).click();
  assert.equal(await floating.locator('iframe').isVisible(), true);
  await floating.close();
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Browser checks passed: checkout UI, visible card extraction/collisions, mocked SDK cancellation/approval, and side-panel mapping/comparison against the real local reward API (Chrome APIs mocked).');
  console.log('Screenshot: artifacts/demo-checkout.png');
} finally {
  await browser?.close();
  if (paymentServer) await new Promise(resolve => paymentServer.close(resolve));
  await new Promise(resolve => server.close(resolve));
}
