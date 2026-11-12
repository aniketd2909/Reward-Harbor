import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bestCardForPurchase } from '../server/best-card.mjs';
import vm from 'node:vm';

const { cards: profiles } = JSON.parse(await readFile(new URL('../data/issuer-cards.json', import.meta.url), 'utf8'));
const purchase = { merchantName: 'Harbor Market', amount: '48.00', currency: 'USD', category: 'grocery' };
const cards = [{ network: 'Amex', last4: '2402', localCardId: 'Amex:2402' }, { network: 'Visa', last4: '6302', localCardId: 'Visa:6302' }, { network: 'Unknown', last4: '6206', localCardId: 'Unknown:6206' }];
test('returns one best sourced card automatically and excludes the bank account', () => {
  const result = bestCardForPurchase({ purchase, cards }, profiles);
  assert.equal(result.comparedCards, 2);
  assert.equal(result.options.length, 2);
  assert.equal(result.options[0].productId, 'us-amex-gold');
  assert.equal(result.options[1].estimatedValue, '0.72');
  assert.ok(result.options[1].benefits.some(rule => rule.category === 'dining' && rule.rate === 3));
  assert.equal(result.bestCard.productId, 'us-amex-gold');
  assert.equal(result.bestCard.rewardUnits, 192);
  assert.equal(result.bestCard.estimatedValue, '1.92');
  assert.ok(result.bestCard.conditions.some(c => c.includes('allowance')));
});
test('total rates replace base rates and purchase amount changes the estimate', () => {
  const result = bestCardForPurchase({ purchase: { ...purchase, amount: '100.00', category: 'dining' }, cards: [cards[1]] }, profiles);
  assert.equal(result.bestCard.estimatedValue, '3.00');
  assert.equal(result.bestCard.rate, 3);
});
test('different storefront scenarios select the appropriate available card rates', () => {
  const beauty = bestCardForPurchase({ purchase: { ...purchase, category: 'drugstores', categoryBasis: 'sandbox-department-simulation' }, cards }, profiles);
  assert.equal(beauty.bestCard.productId, 'us-chase-freedom-unlimited'); assert.equal(beauty.bestCard.rate, 3);
  assert.ok(beauty.assumptions.some(text => text.includes('simulated')));
  const home = bestCardForPurchase({ purchase: { ...purchase, category: 'other' }, cards }, profiles);
  assert.equal(home.bestCard.productId, 'us-chase-freedom-unlimited'); assert.equal(home.bestCard.rate, 1.5);
});
test('portal bonuses do not apply to an ordinary PayPal travel purchase', () => {
  const result = bestCardForPurchase({ purchase: { ...purchase, category: 'travel' }, cards }, profiles);
  assert.equal(result.bestCard.productId, 'us-chase-freedom-unlimited');
  assert.equal(result.bestCard.rate, 1.5);
  assert.equal(result.comparedCards, 1, 'Missing Gold base rule does not become a fictional zero rate');
  assert.equal(result.options.length, 2);
  assert.equal(result.options[1].estimatedValue, null);
  assert.match(result.options[1].unavailableReason, /does not mean/);
});
test('unknown context and unsupported currencies do not yield guessed recommendations', () => {
  assert.throws(() => bestCardForPurchase({ purchase: { ...purchase, category: 'unknown' }, cards }, profiles), /category/);
  assert.throws(() => bestCardForPurchase({ purchase: { ...purchase, currency: 'EUR' }, cards }, profiles), /USD/);
});
test('popup scanner inherits matching context from its actual demo opener', async () => {
  let listener;
  let observedAmount = '48.00';
  const demo = { merchantName: 'Harbor Market', amount: '48.00', currency: 'USD', category: 'grocery', source: 'demo-catalog' };
  const context = vm.createContext({ chrome: {
    sidePanel: { setPanelBehavior: async () => {} },
    tabs: { query: async () => [{ id: 2, openerTabId: 1 }], get: async () => ({ id: 1, url: 'http://localhost:3000/' }) },
    scripting: { executeScript: async ({ target }) => [{ result: { cards: target.tabId === 2 ? cards.slice(0, 2) : [],
      purchase: target.tabId === 1 ? demo : { amount: observedAmount, currency: 'USD', source: 'visible-total-label' }, page: 'fixture', note: '' } }] },
    runtime: { onMessage: { addListener(fn) { listener = fn; } } },
  } });
  vm.runInContext(await readFile(new URL('../extension/background.js', import.meta.url), 'utf8'), context);
  const result = await new Promise(resolve => listener({ type: 'SCAN_ACTIVE_TAB' }, {}, resolve));
  assert.equal(result.snapshot.purchase.merchantName, 'Harbor Market');
  assert.equal(result.snapshot.purchase.category, 'grocery');
  observedAmount = '99.00';
  const mismatch = await new Promise(resolve => listener({ type: 'SCAN_ACTIVE_TAB' }, {}, resolve));
  assert.equal(mismatch.snapshot.purchase.merchantName, undefined, 'Do not reuse opener context for a different checkout amount');
});
