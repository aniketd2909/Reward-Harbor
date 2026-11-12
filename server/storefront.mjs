import { Channel3 } from '@channel3/sdk';
import { randomUUID } from 'node:crypto';
import { shoppingProduct } from './channel3.mjs';
import { merchant, purchaseFor } from './catalog.mjs';

export const departments = [
  { id: 'grocery', name: 'Pantry & coffee', query: 'specialty coffee beans and gourmet pantry food', rewardsCategory: 'grocery', description: 'Small rituals, better ingredients.' },
  { id: 'dining', name: 'Food & treats', query: 'gourmet chocolate gift box', rewardsCategory: 'dining', description: 'Something worth sharing.' },
  { id: 'drugstores', name: 'Beauty & wellness', query: 'skincare moisturizer', rewardsCategory: 'drugstores', description: 'A little care goes a long way.' },
  { id: 'other', name: 'Home & tech', query: 'wireless headphones and home desk lamp', rewardsCategory: 'other', description: 'Thoughtful upgrades for your day.' },
];
const fail = (status, message) => Object.assign(new Error(message), { status });
const options = { timeoutInSeconds: 15, maxRetries: 0 };
export function storefrontService({ apiKey = '', client } = {}) {
  const sdk = client || (apiKey ? new Channel3({ apiKey, timeoutInSeconds: 15, maxRetries: 0 }) : null);
  const ids = new Map(), quotes = new Map();
  function ready() { if (!sdk) throw fail(503, 'The product catalog is not configured. Please try again later.'); }
  async function retrieve(id) {
    ready();
    try { return shoppingProduct(await sdk.products.retrieve({ product_id: id, config: { country: 'US', currency: 'USD', language: 'en' } }, options)); }
    catch { throw fail(502, 'Current product details are unavailable. Please try again.'); }
  }
  async function collection(department, query, limit) {
    ready(); const key = `${department.id}:${query || ''}:${limit}`; let cached = ids.get(key);
    if (!cached || cached.until < Date.now()) {
      const page = await sdk.products.search({ query: query || department.query, limit, config: { country: 'US', currency: 'USD', language: 'en' } }, options);
      cached = { ids: page.data.slice(0, limit).map(product => product.id), until: Date.now() + 15 * 60 * 1000 }; ids.set(key, cached);
    }
    const fresh = await Promise.allSettled(cached.ids.map(retrieve));
    return fresh.filter(result => result.status === 'fulfilled' && result.value.offers.some(o => o.price > 0))
      .map(result => ({ ...result.value, department: department.id, departmentName: department.name, rewardsCategory: department.rewardsCategory }));
  }
  async function routes(req, res, url, readBody, send) {
    if (!url.pathname.startsWith('/api/storefront/')) return false;
    if (req.method === 'GET' && url.pathname === '/api/storefront/products') {
      const category = url.searchParams.get('department') || 'all';
      const query = url.searchParams.get('q')?.trim();
      if (query && (query.length < 2 || query.length > 150)) throw fail(400, 'Search using 2–150 characters.');
      const selected = category === 'all' ? departments : departments.filter(d => d.id === category);
      if (!selected.length) throw fail(400, 'Unknown department.');
      try {
        // Searches are limited to one department for a custom query; no duplicate broad searches.
        const groups = await Promise.allSettled((query ? [category === 'all' ? departments.find(d => d.id === 'other') : selected[0]] : selected).map(d => collection(d, query, category === 'all' && !query ? 2 : 5)));
        if (groups.every(g => g.status === 'rejected')) throw new Error('Catalog unavailable');
        send(200, { departments, products: groups.flatMap(g => g.status === 'fulfilled' ? g.value : []), dataSource: 'channel3',
          partial: groups.some(g => g.status === 'rejected'), categoryBasis: 'sandbox-department-simulation' });
      } catch { throw fail(502, 'The live catalog is unavailable. Please retry shortly.'); }
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/storefront/quote') {
      const input = await readBody(req);
      const department = departments.find(d => d.id === input?.department);
      if (!department || !/^[A-Za-z0-9_-]{1,120}$/.test(input.productId || '') || !Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 10) throw fail(400, 'Choose a product and quantity from 1 to 10.');
      const product = await retrieve(input.productId);
      const offer = input.offerDomain ? product.offers.find(o => o.domain === input.offerDomain && o.price > 0) : product.offers.find(o => o.price > 0);
      if (!offer) throw fail(409, 'This offer is no longer available. Choose another product or merchant offer.');
      const quoteId = randomUUID();
      const unitCents = Math.round(offer.price * 100);
      if (!Number.isSafeInteger(unitCents) || unitCents < 1 || unitCents * input.quantity > 99999999) throw fail(400, 'This purchase amount is unsupported.');
      const purchase = { sku: `channel3:${product.id}:${department.id}:${offer.domain}`, quantity: input.quantity,
        merchantName: merchant.name, category: department.rewardsCategory, categoryBasis: 'sandbox-department-simulation', country: 'US',
        currency: 'USD', amount: (unitCents * input.quantity / 100).toFixed(2), description: product.title,
        productId: product.id, offerDomain: offer.domain, unitCents, department: department.id };
      // Keep only short-lived checkout quotes. Fresh pricing is rechecked before order creation.
      for (const [id, quote] of quotes) if (quote.until < Date.now()) quotes.delete(id);
      quotes.set(quoteId, { purchase, until: Date.now() + 15 * 60 * 1000 });
      send(200, { quoteId, purchase, product, selectedOffer: offer }); return true;
    }
    throw fail(404, 'Storefront endpoint not found.');
  }
  routes.resolvePurchase = async input => {
    if (!input.quoteId) return purchaseFor(input.sku, input.quantity ?? 1);
    const quote = quotes.get(input.quoteId);
    if (!quote || quote.until < Date.now()) throw fail(409, 'Your checkout quote expired. Select the product again.');
    const product = await retrieve(quote.purchase.productId);
    const offer = product.offers.find(o => o.domain === quote.purchase.offerDomain);
    if (!offer || Math.round(offer.price * 100) !== quote.purchase.unitCents) throw fail(409, 'The offer changed. Select the product again to confirm its current price.');
    return quote.purchase;
  };
  return routes;
}
