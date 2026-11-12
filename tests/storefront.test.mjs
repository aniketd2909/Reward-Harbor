import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storefrontService } from '../server/storefront.mjs';
function fixture() {
  let price = 25;
  const service = storefrontService({ client: { products: {
    search: async () => ({ data: [{ id: 'product1' }] }),
    retrieve: async ({ product_id }) => ({ id: product_id, title: 'Live product', offers: [{ domain: 'store.example',
      price: { price, currency: 'USD' }, availability: 'InStock', url: 'https://store.example/product' }] }),
  } } });
  async function call(path, body) {
    let result; await service({ method: body ? 'POST' : 'GET' }, null, new URL(`http://localhost${path}`), async () => body, (_, data) => { result = data; }); return result;
  }
  return { service, call, price: value => { price = value; } };
}
test('live collections include different explicitly simulated rewards categories', async () => {
  const f = fixture(); const result = await f.call('/api/storefront/products');
  assert.deepEqual(result.products.map(p => p.rewardsCategory), ['grocery', 'dining', 'drugstores', 'other']);
  assert.equal(result.dataSource, 'channel3');
});
test('checkout amount is calculated on the server from a fresh Channel3 offer', async () => {
  const f = fixture(); const quote = await f.call('/api/storefront/quote', { productId: 'product1', department: 'drugstores', quantity: 2, amount: '0.01' });
  assert.equal(quote.purchase.amount, '50.00'); assert.equal(quote.purchase.category, 'drugstores');
  assert.equal(quote.purchase.categoryBasis, 'sandbox-department-simulation');
  const purchase = await f.service.resolvePurchase({ quoteId: quote.quoteId, amount: '0.01', quantity: 99 });
  assert.equal(purchase.amount, '50.00'); assert.equal(purchase.quantity, 2);
});
test('changed prices and unknown checkout quotes cannot create orders', async () => {
  const f = fixture(); const quote = await f.call('/api/storefront/quote', { productId: 'product1', department: 'grocery', quantity: 1 });
  f.price(30);
  await assert.rejects(f.service.resolvePurchase({ quoteId: quote.quoteId }), /offer changed/);
  await assert.rejects(f.service.resolvePurchase({ quoteId: 'missing' }), /expired/);
});
