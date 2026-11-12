import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculateRecommendations, demoRules, rewardService } from '../server/rewards.mjs';
import { createApp } from '../server/app.mjs';
import { once } from 'node:events';
const purchase = { merchantName: 'Harbor Market', amount: '120.00', currency: 'USD', category: 'grocery' };
const card = { localCardId: 'visa1', productId: 'demo-visa-grocery', offerActivated: true, bonusRemainingCents: 50000 };
test('calculates additive bonus and limits eligible spending to remaining cap', () => {
  const full = calculateRecommendations({ purchase, cards: [card] }, demoRules).results[0];
  assert.equal(full.estimatedReward, '6.00'); assert.equal(full.conditional, false);
  const capped = calculateRecommendations({ purchase, cards: [{ ...card, bonusRemainingCents: 2000 }] }, demoRules).results[0];
  assert.equal(capped.estimatedReward, '2.00');
});
test('unknown activation/cap is conditional and cannot outrank confirmed value', () => {
  const result = calculateRecommendations({ purchase, cards: [{ ...card, offerActivated: null, bonusRemainingCents: null }, { localCardId: 'mc1', productId: 'demo-mastercard-everyday' }] }, demoRules);
  assert.equal(result.recommendedCardId, 'mc1');
  const visa = result.results.find(r => r.localCardId === 'visa1');
  assert.equal(visa.confirmedReward, '1.20'); assert.equal(visa.estimatedReward, '6.00'); assert.equal(visa.conditions.length, 2);
});
test('inactive, expired, and PayPal-excluded bonuses are not counted', () => {
  const inactive = calculateRecommendations({ purchase, cards: [{ ...card, offerActivated: false }] }, demoRules).results[0];
  assert.equal(inactive.estimatedReward, '1.20');
  const excluded = demoRules.map(r => r.kind === 'incremental' ? { ...r, paypalEligibility: 'excluded' } : r);
  assert.equal(calculateRecommendations({ purchase, cards: [card] }, excluded).results[0].estimatedReward, '1.20');
  const expired = demoRules.map(r => ({ ...r, end: '2020-01-02' }));
  assert.equal(calculateRecommendations({ purchase, cards: [card] }, expired).recommendedCardId, null);
});
test('validates amounts and does not invent category bonuses for unknown categories', () => {
  assert.throws(() => calculateRecommendations({ purchase: { ...purchase, amount: '-5' }, cards: [card] }, demoRules));
  const result = calculateRecommendations({ purchase: { ...purchase, category: 'unknown' }, cards: [card] }, demoRules).results[0];
  assert.equal(result.estimatedReward, '1.20'); assert.equal(result.conditional, true);
});
test('recommendation HTTP API works without PayPal credentials', async t => {
  const server = createApp({ recommendation: rewardService() }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/recommendations`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ purchase, cards: [card] }) });
  assert.equal(response.status, 200); const result = await response.json(); assert.equal(result.dataSource, 'local-demo'); assert.equal(result.results[0].estimatedReward, '6.00');
});
