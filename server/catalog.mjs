export const merchant = { name: 'Harbor Market', category: 'grocery', currency: 'USD' };
export const products = [
  { id: 'pantry-box', name: 'The pantry box', description: 'Everyday staples, thoughtfully selected.', cents: 4800, category: 'grocery' },
  { id: 'coffee-box', name: 'Weekend coffee', description: 'Two bags of small-batch roasted coffee.', cents: 2400, category: 'grocery' },
  { id: 'market-box', name: 'The market basket', description: 'A generous selection for the week ahead.', cents: 12000, category: 'grocery' },
];
export function purchaseFor(sku, quantity = 1) {
  const product = products.find(p => p.id === sku);
  if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
    throw Object.assign(new Error('Choose a valid product and quantity (1–10).'), { status: 400 });
  }
  return { sku, quantity, merchantName: merchant.name, category: product.category,
    currency: merchant.currency, amount: (product.cents * quantity / 100).toFixed(2), description: product.name };
}
