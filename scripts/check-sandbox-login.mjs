import { chromium } from 'playwright';
import { readFile, mkdir, writeFile } from 'node:fs/promises';

// Credentials arrive through hidden stdin, never command arguments or files.
process.stdin.setEncoding('utf8');
process.stdin.setRawMode?.(true);
console.log('Ready for sandbox credentials on hidden stdin.');
const credentials = await new Promise((resolve, reject) => {
  let buffer = '';
  const receive = chunk => {
    buffer += chunk;
    if (!buffer.includes('\n')) return;
    process.stdin.off('data', receive);
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
    try { resolve(JSON.parse(buffer.trim())); } catch { reject(new Error('Invalid credential input.')); }
  };
  process.stdin.on('data', receive);
});

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  await page.goto('https://www.sandbox.paypal.com/signin', { waitUntil: 'domcontentloaded' });
  await page.locator('#email').fill(credentials.email);
  const next = page.locator('#btnNext');
  if (await next.isVisible()) await next.click();
  await page.locator('#password').fill(credentials.password);
  credentials.password = '';
  await page.locator('#btnLogin').click();
  await page.waitForURL(url => url.pathname.startsWith('/myaccount'), { timeout: 45000 });
  console.log('Sandbox login succeeded.');
  await page.goto('https://www.sandbox.paypal.com/myaccount/money/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const extractor = await readFile(new URL('../extension/extractor.js', import.meta.url), 'utf8');
  async function inspect() {
    await page.evaluate(extractor);
    return page.evaluate(() => RewardExtractor.extract(document, location));
  }
  const wallet = await inspect();
  const cardPaths = await page.locator('a[href*="/myaccount/money/cards/"]').evaluateAll(links => [...new Set(links.map(a => new URL(a.href).pathname))]);
  const details = [];
  for (const path of cardPaths.slice(0, 10)) {
    if (!/^\/myaccount\/money\/cards\/CC-[A-Za-z0-9_-]+\/?$/.test(path)) continue;
    await page.goto(`https://www.sandbox.paypal.com${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    const snapshot = await inspect();
    const fields = await page.evaluate(() => {
      const text = document.body.innerText;
      return { expiration: text.match(/(?:Expiration date|Expiry date)\s*(\d{2}\/\d{4})/i)?.[1] || null,
        hasBillingAddress: /Billing address/i.test(text),
        hasPreferenceControl: /Set as preferred/i.test(text) };
    });
    details.push({ ...snapshot, ...fields });
  }
  const report = { inspectedAt: new Date().toISOString(), wallet, details,
    note: 'Authenticated Wallet inspection only. No payment approved/captured; checkout compatibility remains separate.' };
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/authenticated-sandbox-cards.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(error.name === 'TimeoutError' ? 'Sandbox navigation timed out. Login may require a challenge or the page selectors may have changed.' : 'Sandbox inspection failed. No credentials or page contents were logged.');
  process.exitCode = 1;
} finally {
  credentials.password = '';
  await browser.close();
}
