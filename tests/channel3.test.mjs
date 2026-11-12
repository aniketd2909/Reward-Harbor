import { test } from 'node:test';
import assert from 'node:assert/strict';
import { channel3Service, shoppingProduct } from '../server/channel3.mjs';

const offer = { domain: 'merchant.example', price: { price: 19.99, currency: 'USD' }, availability: 'InStock', url: 'https://merchant.example/buy?affiliate=fresh' };
async function search(service, input) {
  let result;
  await service({ method: 'POST' }, null, new URL('http://localhost/api/shopping/search'), async () => input,
    (status, data) => { result = { status, ...data }; });
  return result;
}
test('refreshes search results before displaying offers and does not expose client credentials', async () => {
  const calls = [];
  const service = channel3Service({ client: { products: {
    search: async input => { calls.push(input); return { data: [{ id: 'coffee', title: 'Old title', offers: [{ ...offer, url: 'https://stale.example/', price: { price: 999, currency: 'USD' } }] }] }; },
    retrieve: async input => { calls.push(input); return { id: 'coffee', title: 'Fresh coffee', offers: [offer] }; },
  } } });
  const result = await search(service, { query: 'coffee', limit: 1 });
  assert.equal(result.products[0].title, 'Fresh coffee');
  assert.equal(result.products[0].offers[0].price, 19.99);
  assert.equal(result.products[0].offers[0].url, offer.url);
  assert.equal(calls[1].product_id, 'coffee');
  assert.equal(calls[0].config.currency, 'USD');
});
test('never substitutes stale search offers when detail refresh fails', async () => {
  const service = channel3Service({ client: { products: {
    search: async () => ({ data: [{ id: 'coffee', offers: [offer] }] }),
    retrieve: async () => { throw new Error('detail unavailable'); },
  } } });
  const result = await search(service, { query: 'coffee' });
  assert.equal(result.partial, true); assert.equal(result.products.length, 0);
});
test('filters unsafe links, out-of-stock products, unsupported currency, and invalid prices', () => {
  const result = shoppingProduct({ id: 'x', title: 'Coffee', offers: [offer,
    { ...offer, url: 'javascript:alert(1)' }, { ...offer, availability: 'OutOfStock' },
    { ...offer, price: { price: -1, currency: 'USD' } }, { ...offer, price: { price: 10, currency: 'EUR' } },
  ] });
  assert.equal(result.offers.length, 1);
});
test('validates search input before SDK calls and sanitizes upstream errors', async () => {
  const service = channel3Service({ client: { products: { search: async () => { throw new Error('sensitive upstream details'); } } } });
  await assert.rejects(search(service, { query: 'x' }), /between 2 and 250/);
  await assert.rejects(search(service, { query: 'coffee', limit: 20 }), /between 1 and 5/);
  await assert.rejects(search(service, { query: 'coffee' }), error => error.status === 502 && !error.message.includes('sensitive'));
  await assert.rejects(search(channel3Service(), { query: 'coffee' }), error => error.status === 503);
});
