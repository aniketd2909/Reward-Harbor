const BASE = 'https://api-m.sandbox.paypal.com';
export class PayPalError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}
export function createPayPal({ clientId, secret, fetchImpl = fetch }) {
  let cached;
  async function token() {
    if (!clientId || !secret) throw new PayPalError('Configure sandbox credentials in .env and restart the server.', 503);
    if (cached && cached.until > Date.now()) return cached.value;
    const response = await fetchImpl(`${BASE}/v1/oauth2/token`, {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { Authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=client_credentials',
    });
    if (!response.ok) throw new PayPalError('PayPal sandbox authentication failed. Check your sandbox app credentials.');
    const data = await response.json();
    if (!data.access_token) throw new PayPalError('PayPal did not return an access token.');
    cached = { value: data.access_token, until: Date.now() + Math.max(0, (data.expires_in - 60) * 1000) };
    return cached.value;
  }
  async function call(path, method = 'GET', body, requestId) {
    const accessToken = await token();
    const response = await fetchImpl(`${BASE}${path}`, { method, signal: AbortSignal.timeout(20000),
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json',
        Prefer: 'return=representation', ...(requestId ? { 'PayPal-Request-Id': requestId } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      if (response.status === 401) cached = null;
      const data = await response.json().catch(() => ({}));
      const issue = data.details?.[0]?.issue;
      const message = issue === 'INSTRUMENT_DECLINED' ? 'The funding source was declined. Choose another card in PayPal.'
        : issue === 'ORDER_NOT_APPROVED' ? 'Approve this order in PayPal before capturing it.'
        : 'PayPal sandbox could not complete the request. Retry or check the sandbox app configuration.';
      throw new PayPalError(message);
    }
    return response.json();
  }
  return {
    create(purchase, requestId) {
      return call('/v2/checkout/orders', 'POST', { intent: 'CAPTURE', purchase_units: [{
        reference_id: 'demo-purchase', description: `${purchase.merchantName}: ${purchase.description}`.slice(0, 127),
        amount: { currency_code: purchase.currency, value: purchase.amount },
      }] }, requestId);
    },
    capture: (id, requestId) => call(`/v2/checkout/orders/${encodeURIComponent(id)}/capture`, 'POST', {}, requestId),
    get: id => call(`/v2/checkout/orders/${encodeURIComponent(id)}`),
  };
}

export function verifiedCapture(data, expected) {
  const units = data.purchase_units;
  if (data.status !== 'COMPLETED' || !Array.isArray(units) || units.length !== 1) return null;
  const captures = units[0].payments?.captures;
  if (!Array.isArray(captures) || captures.length !== 1) return null;
  const capture = captures[0];
  if (!capture.id || capture.status !== 'COMPLETED' ||
      capture.amount?.currency_code !== expected.currency || capture.amount?.value !== expected.amount) return null;
  return { status: 'COMPLETED', captureId: capture.id, amount: capture.amount.value, currency: capture.amount.currency_code };
}
