import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { merchant, products, purchaseFor } from './catalog.mjs';
import { verifiedCapture } from './paypal.mjs';
import { createStore } from './store.mjs';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const fail = (status, message) => Object.assign(new Error(message), { status });
const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'] };
async function body(req) {
  let text = '';
  for await (const chunk of req) {
    text += chunk;
    if (Buffer.byteLength(text) > 8192) throw fail(413, 'Request too large.');
  }
  try { return text ? JSON.parse(text) : {}; } catch { throw fail(400, 'Expected JSON.'); }
}
export function createApp({ paypal, clientId = '', configured = false, store = createStore(), recommendation, purchaseResolver } = {}) {
  const locks = new Map();
  function serial(key, work) {
    if (locks.has(key)) return locks.get(key);
    const task = Promise.resolve().then(work).finally(() => locks.delete(key));
    locks.set(key, task);
    return task;
  }
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    const send = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    try {
      if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.host || '')) throw fail(403, 'Use the localhost demo address.');
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && files[url.pathname]) {
        const [name, type] = files[url.pathname];
        res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` });
        res.end(await readFile(publicDir + name)); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/config') {
        send(200, { environment: 'sandbox', configured, clientId: configured ? clientId : '', merchant, products }); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/health') { send(200, { status: 'ok', environment: 'sandbox' }); return; }
      // Local sandbox recovery: the opaque PayPal order ID is a capability for
      // these non-personal purchase fields. Never return cookies or account data.
      const contextOrder = url.pathname.match(/^\/api\/checkout-context\/([A-Z0-9]{5,40})$/);
      if (req.method === 'GET' && contextOrder) {
        const order = store.data.orders[contextOrder[1]];
        if (!order) throw fail(404, 'No local checkout exists for this order.');
        if (Date.now() - order.createdAt > 2 * 60 * 60 * 1000) throw fail(410, 'This checkout context expired. Start a new checkout.');
        const p = order.purchase;
        send(200, { orderId: contextOrder[1], state: order.result ? 'completed' : 'active', purchase: {
          merchantName: p.merchantName, amount: p.amount, currency: p.currency, category: p.category,
          ...(p.country ? { country: p.country } : {}), ...(p.categoryBasis ? { categoryBasis: p.categoryBasis } : {}),
          source: 'server-order',
        } }); return;
      }
      // Extension reward endpoints are read-only calculations and carry no payment credentials.
      if (recommendation && await recommendation(req, res, url, body, send)) return;
      if (req.method !== 'POST' || !url.pathname.startsWith('/api/paypal/')) throw fail(404, 'Not found.');
      const origin = req.headers.origin;
      if (origin !== `http://${req.headers.host}`) throw fail(403, 'Payment requests must come from this checkout.');
      if (!req.headers['content-type']?.startsWith('application/json')) throw fail(415, 'Expected application/json.');
      const input = await body(req);
      let session = req.headers.cookie?.match(/(?:^|;\s*)demo_session=([a-f0-9]{64})(?:;|$)/)?.[1];
      if (!session) {
        session = randomBytes(32).toString('hex');
        res.setHeader('Set-Cookie', `demo_session=${session}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400`);
      }
      if (!configured) throw fail(503, 'Add your sandbox client ID and secret to .env, then restart the server.');
      if (url.pathname === '/api/paypal/orders') {
        const purchase = purchaseResolver ? await purchaseResolver(input) : purchaseFor(input.sku, input.quantity ?? 1);
        const key = `${session}:${purchase.sku}:${purchase.quantity}:${purchase.amount}:${purchase.currency}`;
        const result = await serial(key, async () => {
          let attempt = store.data.attempts[key];
          if (!attempt || attempt.paid || Date.now() - attempt.createdAt > 3 * 60 * 60 * 1000) {
            attempt = { requestId: randomUUID(), captureRequestId: randomUUID(), session, purchase, createdAt: Date.now() };
            store.data.attempts[key] = attempt; store.save();
          }
          if (!attempt.orderId) {
            const data = await paypal.create(purchase, attempt.requestId);
            if (!/^[A-Z0-9]+$/.test(data.id || '')) throw fail(502, 'PayPal returned an invalid order.');
            attempt.orderId = data.id;
            store.data.orders[data.id] = attempt; store.save();
          }
          return { id: attempt.orderId, purchase };
        });
        send(200, result); return;
      }
      const match = url.pathname.match(/^\/api\/paypal\/orders\/([A-Z0-9]+)\/capture$/);
      if (!match) throw fail(404, 'Not found.');
      const id = match[1];
      const record = store.data.orders[id];
      if (!record || record.session !== session) throw fail(404, 'Order not found for this checkout session.');
      const result = await serial(`capture:${id}`, async () => {
        if (record.result) return record.result;
        let data;
        try { data = await paypal.capture(id, record.captureRequestId); }
        catch (error) {
          // A response can be lost after a successful capture. Reconcile before retrying.
          data = await paypal.get(id).catch(() => null);
          if (!data || data.status !== 'COMPLETED') throw error;
        }
        const verified = data?.id === id && verifiedCapture(data, record.purchase);
        if (!verified) throw fail(502, 'Payment is not confirmed as completed for the expected amount. Do not retry a new purchase until its status is checked.');
        record.result = { orderId: id, ...verified, confirmedAt: new Date().toISOString() }; record.paid = true;
        for (const attempt of Object.values(store.data.attempts)) if (attempt.orderId === id) attempt.paid = true;
        store.save(); return record.result;
      });
      send(200, result);
    } catch (error) {
      send(error.status || 502, { error: error.status ? error.message : 'The sandbox service is unavailable. Please retry shortly.' });
    }
  });
}
