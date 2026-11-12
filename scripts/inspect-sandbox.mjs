import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const target = process.argv[2] || 'https://sandbox.paypal.com/myaccount/summary?intl=0';
function isSandbox(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' &&
      ['sandbox.paypal.com', 'www.sandbox.paypal.com'].includes(parsed.hostname);
  } catch { return false; }
}
if (!isSandbox(target)) throw new Error('Provide a PayPal sandbox HTTPS URL.');

const prompt = createInterface({ input: stdin, output: stdout });
let context;
try {
  context = await chromium.launchPersistentContext(resolve('.sandbox-browser'), {
    ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}),
    headless: false,
    viewport: { width: 1280, height: 900 },
  });
  const page = context.pages()[0] || await context.newPage();
  await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
  console.log('Sign in using your SANDBOX account in the browser, then open Wallet or a card detail page.');
  console.log('This browser has its own local profile; your regular browser login is not imported.');
  await prompt.question('Once the card information is visible, press Enter here to inspect it. ');

  const results = [];
  for (const openPage of context.pages()) {
    if (!isSandbox(openPage.url())) continue;
    for (const frame of openPage.frames()) {
      if (!isSandbox(frame.url())) continue;
      try {
        const data = await frame.evaluate(() => {
          // Read rendered text only. Never read cookies, storage, or input values.
          const text = document.body?.innerText || '';
          const brands = [...new Set(text.match(/\b(?:Visa|Mastercard|American Express|Amex|Discover|Diners Club|JCB|UnionPay)\b/gi) || [])];
          // Recognize masked labels, without collecting surrounding address text.
          const maskedCards = [...new Set(text.match(/(?:[•●·*xX][\s\u00a0]*){2,}(?:\d[\s\u00a0]*){4}(?!\d)|(?:ending\s+(?:in\s+)?|last\s+4\s*[:\-]?\s*)\d{4}\b/gi) || [])]
            .map(label => ({ last4: label.replace(/\D/g, '').slice(-4) }));
          return { brands, maskedCards, hasExpirationLabel: /expiration|expiry/i.test(text) };
        });
        // Drop queries and fragments that might contain session identifiers.
        const location = new URL(frame.url());
        results.push({ page: location.origin + location.pathname, ...data });
      } catch (error) {
        console.warn(`Could not inspect a frame: ${error.name}`);
      }
    }
  }
  const report = {
    inspectedAt: new Date().toISOString(),
    results,
    note: 'Visible brands and masked card suffixes only. Brand/suffix does not identify the issuer rewards product. No result does not establish that there are no cards.',
  };
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/sandbox-cards.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  console.log('Saved artifacts/sandbox-cards.json');
} finally {
  prompt.close();
  await context?.close();
}
