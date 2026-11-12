import { readFile } from 'node:fs/promises';
const base = process.env.ELASTIC_URL?.trim().replace(/\/$/, '');
const key = process.env.ELASTIC_API_KEY?.trim();
const index = process.env.ELASTIC_CARD_INDEX || 'card-catalog';
if (!base || new URL(base).protocol !== 'https:' || !key || !/^[a-z0-9_-]+$/.test(index)) throw new Error('Set HTTPS ELASTIC_URL, ELASTIC_API_KEY, and optionally ELASTIC_CARD_INDEX in .env.');
const mapping = JSON.parse(await readFile(new URL('../elastic/card-catalog.mapping.json', import.meta.url), 'utf8'));
const bulk = await readFile(new URL('../data/issuer-cards.bulk.ndjson', import.meta.url), 'utf8');
async function call(path, method, body, contentType = 'application/json') {
  const response = await fetch(`${base}/${path}`, { method, headers: { Authorization: `ApiKey ${key}`, 'Content-Type': contentType },
    ...(body ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Elastic returned ${response.status}. Check endpoint, index, and permissions.`);
  return method === 'HEAD' ? null : response.json();
}
const exists = await fetch(`${base}/${index}`, { method: 'HEAD', headers: { Authorization: `ApiKey ${key}` }, signal: AbortSignal.timeout(15000) });
if (exists.status === 404) await call(index, 'PUT', mapping);
else if (exists.ok) await call(`${index}/_mapping`, 'PUT', mapping.mappings);
else throw new Error('Cannot inspect Elastic card catalog.');
const result = await call(`${index}/_bulk?refresh=wait_for`, 'POST', bulk, 'application/x-ndjson');
if (result.errors) throw new Error('Some card profiles failed to index. Check index mappings.');
console.log(`Indexed ${result.items.length} sourced card profiles in ${index}. Full terms and PayPal eligibility still require review.`);
