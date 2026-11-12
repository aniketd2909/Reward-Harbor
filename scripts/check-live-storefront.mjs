import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://localhost:3000');
  await page.waitForFunction(() => document.querySelectorAll('[data-buy]').length > 0 || !document.querySelector('#retry-catalog').hidden, { timeout: 60000 });
  const count = await page.locator('[data-buy]').count();
  if (!count) throw new Error(await page.locator('#catalog-status').innerText());
  await page.locator('.product-card').first().scrollIntoViewIfNeeded();
  await page.waitForFunction(() => [...document.querySelectorAll('.product-visual img')].some(img => img.complete && img.naturalWidth > 0 && !img.hidden), { timeout: 20000 });
  await page.evaluate(async () => {
    const images = [...document.querySelectorAll('#product-grid img, #hero-image')];
    await Promise.all(images.map(image => image.complete ? Promise.resolve() : new Promise(resolve => {
      image.addEventListener('load', resolve, { once: true }); image.addEventListener('error', resolve, { once: true }); setTimeout(resolve, 5000);
    })));
  });
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/live-storefront.png', fullPage: true });
  await page.locator('[data-buy]').first().click();
  await page.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Ready.') || document.querySelector('#status').dataset.state === 'error', { timeout: 45000 });
  const status = await page.locator('#status').innerText();
  const checkout = JSON.parse(await page.locator('html').getAttribute('data-reward-checkout'));
  assert.ok(Number(checkout.amount) > 0); assert.equal(checkout.categoryBasis, 'sandbox-department-simulation');
  assert.ok(status.startsWith('Ready.'), status);
  await page.screenshot({ path: 'artifacts/live-checkout.png', fullPage: true });
  await page.locator('#close-checkout').click(); await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log(JSON.stringify({ productsDisplayed: count, checkoutReady: true, category: checkout.category,
    amount: checkout.amount, mobileLayout: 'passed', paymentInitiated: false }));
} finally { await browser.close(); }
