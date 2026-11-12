import { demoRules } from '../server/rewards.mjs';
const base = process.env.ELASTIC_URL?.replace(/\/$/, '');
const key = process.env.ELASTIC_API_KEY;
const index = process.env.ELASTIC_INDEX || 'reward-rules';
if (!base || new URL(base).protocol !== 'https:' || !key || !/^[a-z0-9_-]+$/.test(index)) throw new Error('Configure HTTPS ELASTIC_URL, ELASTIC_API_KEY, and a simple index name in .env.');
async function call(path, method, data, type = 'application/json') {
  const response = await fetch(`${base}/${path}`, { method, headers: { Authorization: `ApiKey ${key}`, 'Content-Type': type },
    body: typeof data === 'string' ? data : JSON.stringify(data), signal: AbortSignal.timeout(15000) });
  const result = await response.json();
  if (!response.ok) throw new Error(`Elastic request failed (${response.status}). Check endpoint, index, and API key privileges.`);
  return result;
}
const mapping = { properties: { productId: { type: 'keyword' }, category: { type: 'keyword' }, kind: { type: 'keyword' },
  start: { type: 'date', format: 'yyyy-MM-dd' }, end: { type: 'date', format: 'yyyy-MM-dd' } } };
// PUT mapping works with an existing index and auto-creation for bulk is not relied upon.
const exists = await fetch(`${base}/${index}`, { method: 'HEAD', headers: { Authorization: `ApiKey ${key}` }, signal: AbortSignal.timeout(15000) });
if (exists.status === 404) await call(index, 'PUT', { mappings: mapping });
else if (exists.ok) await call(`${index}/_mapping`, 'PUT', mapping);
else throw new Error('Cannot inspect Elastic index. Check API key privileges.');
const ndjson = demoRules.map(rule => JSON.stringify({ index: { _index: index, _id: rule.id } }) + '\n' + JSON.stringify(rule)).join('\n') + '\n';
const result = await call('_bulk?refresh=wait_for', 'POST', ndjson, 'application/x-ndjson');
if (result.errors) throw new Error('Some demo rules failed to index.');
console.log(`Indexed ${demoRules.length} synthetic demo rules. These are not verified issuer benefits.`);
