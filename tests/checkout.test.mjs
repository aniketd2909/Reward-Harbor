import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { createApp } from '../server/app.mjs';
import { createPayPal, verifiedCapture } from '../server/paypal.mjs';
import { createStore } from '../server/store.mjs';

async function fixture(t, overrides = {}) {
  let creates = 0, captures = 0;
  const complete = { id: 'ORDER123', status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAPTURE123', status: 'COMPLETED', amount: { currency_code: 'USD', value: '48.00' } }] } }] };
  const paypal = {
    async create(purchase) { creates++; assert.equal(purchase.amount, '48.00'); return { id: 'ORDER123' }; },
    async capture() { captures++; return complete; }, async get() { return complete; }, ...overrides,
  };
  const server = createApp({ paypal, configured: true, clientId: 'public-client-id', store: createStore() });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  let cookie;
  const post = async (path, data, { session = cookie, origin = base } = {}) => {
    const response = await fetch(base + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(session ? { Cookie: session } : {}) }, body: JSON.stringify(data) });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie').split(';')[0];
    return { status: response.status, data: await response.json() };
  };
  return { post, base, counters: () => ({ creates, captures }), complete };
}
test('server owns price, binds orders to session, and deduplicates creation/capture', async t => {
  const f = await fixture(t);
  const created = await f.post('/api/paypal/orders', { sku: 'pantry-box', amount: '0.01' });
  assert.equal(created.status, 200); assert.equal(created.data.purchase.amount, '48.00');
  const context = await (await fetch(f.base + '/api/checkout-context/ORDER123')).json();
  assert.equal(context.purchase.category, 'grocery'); assert.equal(context.purchase.amount, '48.00');
  assert.equal(context.state, 'active'); assert.equal(context.session, undefined);
  assert.equal(context.purchase.sku, undefined);
  await f.post('/api/paypal/orders', { sku: 'pantry-box' });
  assert.equal(f.counters().creates, 1);
  const stolen = await f.post('/api/paypal/orders/ORDER123/capture', {}, { session: 'demo_session=' + 'a'.repeat(64) });
  assert.equal(stolen.status, 404);
  const results = await Promise.all([f.post('/api/paypal/orders/ORDER123/capture', {}), f.post('/api/paypal/orders/ORDER123/capture', {})]);
  assert.ok(results.every(r => r.status === 200 && r.data.captureId === 'CAPTURE123'));
  assert.equal(f.counters().captures, 1);
});
test('rejects foreign origins and invalid purchases before creating orders', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('/api/paypal/orders', { sku: 'pantry-box' }, { origin: 'https://other.test' })).status, 403);
  assert.equal((await f.post('/api/paypal/orders', { sku: 'unknown' })).status, 400);
  assert.equal((await f.post('/api/paypal/orders', { sku: 'pantry-box', quantity: -1 })).status, 400);
  assert.equal(f.counters().creates, 0);
});
test('reconciles an uncertain capture response without creating a second payment', async t => {
  const f = await fixture(t, { async capture() { throw new Error('connection lost'); } });
  await f.post('/api/paypal/orders', { sku: 'pantry-box' });
  const response = await f.post('/api/paypal/orders/ORDER123/capture', {});
  assert.equal(response.status, 200); assert.equal(response.data.status, 'COMPLETED');
});
test('never reports success for pending or wrong-amount captures', async t => {
  const wrong = { id: 'ORDER123', status: 'COMPLETED', purchase_units: [{ payments: { captures: [{ id: 'CAP', status: 'COMPLETED', amount: { value: '0.01', currency_code: 'USD' } }] } }] };
  assert.equal(verifiedCapture(wrong, { amount: '48.00', currency: 'USD' }), null);
  const f = await fixture(t, { async capture() { return wrong; } });
  await f.post('/api/paypal/orders', { sku: 'pantry-box' });
  assert.equal((await f.post('/api/paypal/orders/ORDER123/capture', {})).status, 502);
});
test('PayPal adapter always uses sandbox and stable idempotency headers', async () => {
  const calls = [];
  const paypal = createPayPal({ clientId: 'id', secret: 'secret', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return Response.json(url.endsWith('/token') ? { access_token: 'test-token', expires_in: 3600 } : { id: 'ORDER123' });
  } });
  await paypal.create({ amount: '48.00', currency: 'USD', merchantName: 'Harbor', description: 'Box' }, 'create-id');
  await paypal.capture('ORDER123', 'capture-id');
  assert.ok(calls.every(c => c.url.startsWith('https://api-m.sandbox.paypal.com/')));
  assert.equal(calls[1].options.headers['PayPal-Request-Id'], 'create-id');
  assert.equal(calls[2].options.headers['PayPal-Request-Id'], 'capture-id');
  assert.equal(calls.length, 3);
});

test('configured HTTPS deployment accepts exact host/origin and issues a Secure session cookie', async t => {
  let creates = 0;
  const server = createApp({ publicOrigin: 'https://reward-harbor.onrender.com', configured: true,
    paypal: { async create() { creates++; return { id: 'RENDER123' }; } } });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const host = 'reward-harbor.onrender.com';
  const request = (path, headers, payload) => new Promise((resolve, reject) => {
    const req = httpRequest(base + path, { method: payload ? 'POST' : 'GET', headers }, res => {
      res.resume(); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.on('error', reject); req.end(payload);
  });
  assert.equal((await request('/', { Host: host })).status, 200);
  assert.equal((await request('/', { Host: 'unknown.example' })).status, 403);
  const post = origin => request('/api/paypal/orders', { Host: host, Origin: origin, 'Content-Type': 'application/json' }, JSON.stringify({ sku: 'pantry-box' }));
  assert.equal((await post('https://other.example')).status, 403);
  assert.equal((await post('http://' + host)).status, 403);
  const response = await post('https://' + host);
  assert.equal(response.status, 200);
  assert.match(response.headers['set-cookie'][0], /; Secure/);
  assert.equal(creates, 1);
});
