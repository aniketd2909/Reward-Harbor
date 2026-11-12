import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { issuerSources, extractIssuerCard } from '../server/issuer-sources.mjs';
import { cardCatalogService } from '../server/card-catalog.mjs';

test('scraped dataset preserves point units, caps, channel restrictions, and source provenance', async () => {
  const { cards } = JSON.parse(await readFile(new URL('../data/issuer-cards.json', import.meta.url), 'utf8'));
  assert.equal(cards.length, 4);
  for (const card of cards) {
    assert.match(card.sourceUrl, /^https:\/\/(www\.americanexpress\.com|creditcards\.chase\.com)\//);
    assert.match(card.sourceHash, /^[a-f0-9]{64}$/);
    assert.equal(card.paypalEligibility, 'unknown'); assert.equal(card.demo, false);
    assert.equal(card.reviewStatus, 'advertised_summary_only');
  }
  const gold = cards.find(c => c.id === 'us-amex-gold');
  const grocery = gold.rewards.find(r => r.category === 'grocery');
  assert.equal(grocery.rate, 4); assert.equal(grocery.unit, 'points_per_usd'); assert.equal(grocery.annualSpendCapUsd, 25000);
  const platinum = cards.find(c => c.id === 'us-amex-platinum');
  assert.deepEqual(platinum.rewards.find(r => r.category === 'hotels').bookingChannels, ['amex_travel']);
});
test('changed rates and missing cap evidence cannot silently regenerate a card', () => {
  const source = issuerSources.find(s => s.id === 'us-amex-blue-cash-preferred');
  assert.throws(() => extractIssuerCard(source, '7% Cash Back at U.S. Supermarkets', '2026-11-11T00:00:00Z', 'hash'), /evidence missing/);
});
test('Elastic bulk document IDs are stable and match the sourced dataset', async () => {
  const text = await readFile(new URL('../data/issuer-cards.bulk.ndjson', import.meta.url), 'utf8');
  assert.ok(text.endsWith('\n'));
  const lines = text.trim().split('\n').map(JSON.parse);
  assert.equal(lines.length, 8);
  for (let i = 0; i < lines.length; i += 2) assert.equal(lines[i].index._id, lines[i + 1].productId);
});
test('catalog returns issuer points as points without converting to cash', async () => {
  let result;
  await cardCatalogService()({ method: 'GET' }, null, new URL('http://localhost/api/issuer-cards?productId=us-amex-gold&category=grocery'), null, (status, data) => { assert.equal(status, 200); result = data; });
  assert.equal(result.cards.length, 1); assert.equal(result.cards[0].rewards[0].unit, 'points_per_usd');
  assert.equal(result.cards[0].rewards[0].category, 'grocery');
});
test('Elastic catalog uses nested category filters and labels local fallback on errors', async () => {
  let query;
  const service = cardCatalogService({ elasticUrl: 'https://elastic.example', apiKey: 'test', fetchImpl: async (url, options) => {
    query = JSON.parse(options.body); return Response.json({ hits: { hits: [] } });
  } });
  await service({ method: 'GET' }, null, new URL('http://localhost/api/issuer-cards?category=grocery'), null, () => {});
  assert.ok(query.query.bool.filter.some(f => f.nested?.path === 'rewards'));
  const failed = cardCatalogService({ elasticUrl: 'https://elastic.example', apiKey: 'test', fetchImpl: async () => new Response('', { status: 503 }) });
  let fallback;
  await failed({ method: 'GET' }, null, new URL('http://localhost/api/issuer-cards'), null, (status, data) => { fallback = data; });
  assert.equal(fallback.dataSource, 'local-issuer-sources');
  assert.match(fallback.fallbackReason, /Elastic is unavailable/);
  assert.equal(fallback.cards.length, 4);
});
test('hardcoded sandbox cards resolve to the intended issuer profiles', async () => {
  let result;
  await cardCatalogService()({ method: 'GET' }, null, new URL('http://localhost/api/sandbox-card-mappings'), null, (status, data) => { result = data; });
  assert.equal(result.mappings.length, 2);
  const amex = result.mappings.find(m => m.last4 === '2402');
  const visa = result.mappings.find(m => m.last4 === '6302');
  assert.equal(amex.profile.productId, 'us-amex-gold');
  assert.equal(visa.profile.productId, 'us-chase-freedom-unlimited');
  assert.ok(result.mappings.every(m => m.mappingSource === 'hardcoded-sandbox-assumption'));
});
