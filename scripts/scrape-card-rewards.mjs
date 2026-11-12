import { chromium } from 'playwright';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { issuerSources, extractIssuerCard } from '../server/issuer-sources.mjs';

const browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || 'chrome', headless: true });
const cards = []; const failures = [];
try {
  for (const source of issuerSources) {
    const page = await browser.newPage();
    try {
      console.log(`Reading official source: ${source.id}`);
      const response = await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (!response?.ok()) throw new Error(`HTTP ${response?.status() ?? 'unavailable'}`);
      // Allow public, client-rendered benefits to appear. No login or challenge bypass.
      await page.waitForTimeout(1500);
      const text = await page.locator('body').innerText({ timeout: 10000 });
      const sourceHash = createHash('sha256').update(text).digest('hex');
      cards.push(extractIssuerCard(source, text, new Date().toISOString(), sourceHash));
      console.log(`Extracted ${cards.at(-1).rewards.length} reward summaries.`);
    } catch (error) {
      failures.push({ productId: source.id, reason: error.message.split('\n')[0] });
      console.warn(`Source unavailable or changed: ${source.id}. Existing dataset will not be overwritten if any source fails.`);
    } finally { await page.close(); }
  }
} finally { await browser.close(); }
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/card-scrape-report.json', JSON.stringify({ cardsExtracted: cards.length, failures }, null, 2) + '\n');
if (failures.length) {
  console.error(JSON.stringify(failures, null, 2));
  process.exitCode = 1;
} else {
  await mkdir('data', { recursive: true });
  const dataset = { schemaVersion: 1, generatedAt: new Date().toISOString(), cards };
  await writeFile('data/issuer-cards.json.tmp', JSON.stringify(dataset, null, 2) + '\n');
  await rename('data/issuer-cards.json.tmp', 'data/issuer-cards.json');
  // Index name is supplied in the URL at import time; IDs make re-import idempotent.
  const bulk = cards.map(card => JSON.stringify({ index: { _id: card.id } }) + '\n' + JSON.stringify(card)).join('\n') + '\n';
  await writeFile('data/issuer-cards.bulk.ndjson', bulk);
  console.log(`Saved ${cards.length} issuer card profiles to data/issuer-cards.json and Elastic bulk NDJSON.`);
}
