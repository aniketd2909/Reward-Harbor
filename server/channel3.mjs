import { Channel3 } from '@channel3/sdk';

const fail = (status, message) => Object.assign(new Error(message), { status });
const requestOptions = { timeoutInSeconds: 15, maxRetries: 0 };
function httpsUrl(value) {
  try { return new URL(value).protocol === 'https:' ? value : null; } catch { return null; }
}
export function shoppingProduct(product) {
  return {
    id: product.id, title: product.title, category: product.category?.title || null,
    imageUrl: httpsUrl(product.images?.[0]?.url),
    selectedOptions: product.variants?.selected || [],
    offers: (product.offers || []).filter(offer => offer.availability === 'InStock' && offer.price?.currency === 'USD' &&
      Number.isFinite(offer.price.price) && offer.price.price >= 0 && httpsUrl(offer.url))
      .sort((a, b) => a.price.price - b.price.price).slice(0, 5).map(offer => ({
        domain: offer.domain, url: offer.url, price: offer.price.price, currency: offer.price.currency,
        availability: offer.availability, condition: offer.condition || 'unknown',
      })),
  };
}
export function channel3Service({ apiKey = '', client } = {}) {
  const sdk = client || (apiKey ? new Channel3({ apiKey, timeoutInSeconds: 15, maxRetries: 0 }) : null);
  return async function routes(req, res, url, readBody, send) {
    if (!url.pathname.startsWith('/api/shopping/')) return false;
    if (!sdk) throw fail(503, 'Channel3 is not configured. Set CHANNEL3_API_KEY on the server.');
    if (req.method === 'POST' && url.pathname === '/api/shopping/search') {
      const input = await readBody(req);
      if (typeof input?.query !== 'string' || input.query.trim().length < 2 || input.query.length > 250) throw fail(400, 'Enter a product search between 2 and 250 characters.');
      const limit = input.limit ?? 3;
      if (!Number.isInteger(limit) || limit < 1 || limit > 5) throw fail(400, 'Choose between 1 and 5 products.');
      try {
        const page = await sdk.products.search({ query: input.query.trim(), limit, config: { country: 'US', currency: 'USD', language: 'en' } }, requestOptions);
        // Retrieve each displayed product for fresh prices/availability/affiliate URLs.
        const refreshed = await Promise.allSettled(page.data.slice(0, limit).map(product =>
          sdk.products.retrieve({ product_id: product.id, config: { country: 'US', currency: 'USD', language: 'en' } }, requestOptions)));
        const products = refreshed.filter(result => result.status === 'fulfilled').map(result => shoppingProduct(result.value));
        send(200, { products, dataSource: 'channel3', refreshedAt: new Date().toISOString(),
          partial: refreshed.some(result => result.status === 'rejected'),
          note: 'Product offers are separate from credit-card rewards. Prices exclude any unreported shipping/tax; check merchant terms. Offer links may earn affiliate commissions.' });
      } catch { throw fail(502, 'Channel3 product search is unavailable. Please try again shortly.'); }
      return true;
    }
    const match = url.pathname.match(/^\/api\/shopping\/products\/([A-Za-z0-9_-]{1,120})$/);
    if (req.method === 'GET' && match) {
      try {
        const product = await sdk.products.retrieve({ product_id: match[1], config: { country: 'US', currency: 'USD', language: 'en' } }, requestOptions);
        send(200, { product: shoppingProduct(product), dataSource: 'channel3', refreshedAt: new Date().toISOString() });
      } catch { throw fail(502, 'Current Channel3 offers are unavailable for this product.'); }
      return true;
    }
    throw fail(404, 'Shopping endpoint not found.');
  };
}
