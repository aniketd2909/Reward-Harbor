import { sandboxCardMappings } from './sandbox-card-mappings.mjs';

export function bestCardForPurchase(input, profiles) {
  const purchase = input?.purchase;
  if (!purchase || typeof purchase.merchantName !== 'string' || !purchase.merchantName.trim() || purchase.merchantName.length > 120 ||
    typeof purchase.amount !== 'string' || !/^\d{1,6}\.\d{2}$/.test(purchase.amount) || Number(purchase.amount) <= 0 || purchase.currency !== 'USD') {
    throw Object.assign(new Error('A merchant and positive USD purchase amount are needed.'), { status: 400 });
  }
  const categories = ['grocery', 'dining', 'flights', 'hotels', 'travel', 'drugstores', 'streaming', 'transit', 'gas', 'other'];
  if (!categories.includes(purchase.category)) throw Object.assign(new Error('Purchase category is missing. Refresh the demo store and reopen checkout, or correct the category.'), { status: 400 });
  if (!Array.isArray(input.cards) || input.cards.length > 20) throw Object.assign(new Error('Provide the visible checkout cards.'), { status: 400 });
  const amountCents = Math.round(Number(purchase.amount) * 100);
  const candidates = [], unavailable = []; const seen = new Set();
  for (const card of input.cards) {
    const mapping = sandboxCardMappings.find(m => card?.network === m.network && card.last4 === m.last4 &&
      [m.cardReference, `${m.network}:${m.last4}`].includes(card.localCardId));
    if (!mapping) {
      if (card?.network && card.network !== 'Unknown') unavailable.push({ localCardId: card.localCardId, network: card.network, last4: card.last4,
        productName: `${card.network} card`, estimatedValue: null, benefits: [], conditions: [], unavailableReason: 'Card product is not mapped, so rewards cannot be estimated.' });
      continue;
    }
    if (seen.has(mapping.cardReference)) continue;
    seen.add(mapping.cardReference);
    const profile = profiles.find(p => p.productId === mapping.productId);
    if (!profile) {
      unavailable.push({ localCardId: card.localCardId, network: card.network, last4: card.last4, productName: mapping.assumedProductName,
        estimatedValue: null, benefits: [], conditions: [], unavailableReason: 'Reward profile is unavailable from the catalog.' });
      continue;
    }
    const choices = [];
    for (const rule of profile.rewards) {
      if (rule.rateType !== 'total' || !['points_per_usd', 'cashback_percent'].includes(rule.unit) || !Number.isFinite(rule.rate) || rule.rate < 0) continue;
      if (rule.category !== '*' && rule.category !== purchase.category) continue;
      if (rule.paypalEligibility === 'excluded' || rule.activationRequired) continue;
      if (rule.bookingChannels && !rule.bookingChannels.includes(purchase.bookingChannel)) continue;
      if (rule.prepaidRequired && purchase.prepaid !== true) continue;
      if (rule.geography === 'US' && purchase.country && purchase.country !== 'US') continue;
      const conditions = [...(rule.conditions || [])];
      let eligibleCents = amountCents;
      if (rule.annualSpendCapUsd != null) {
        eligibleCents = Math.min(amountCents, Math.round(rule.annualSpendCapUsd * 100));
        conditions.push('Assumes the annual bonus spending allowance has not been used.');
      }
      if (rule.geography === 'US' && !purchase.country) conditions.push('Assumes an eligible U.S. merchant.');
      if (rule.paypalEligibility !== 'eligible') conditions.push('PayPal eligibility and issuer merchant classification are unverified.');
      if (profile.reviewStatus !== 'full_terms_reviewed') conditions.push('Based on advertised issuer summaries; full terms apply.');
      const units = eligibleCents * rule.rate / 100 + (amountCents - eligibleCents) * (rule.afterCapRate || 0) / 100;
      const points = rule.unit === 'points_per_usd';
      // Explicit sandbox comparison assumption, not an issuer redemption guarantee.
      const valueCents = units; // Points × 1 cent, or cashback already calculated in cents.
      choices.push({ rule, rewardUnits: points ? Math.round(units * 100) / 100 : Math.round(units) / 100, estimatedValueCents: Math.round(valueCents), conditions });
    }
    choices.sort((a, b) => b.estimatedValueCents - a.estimatedValueCents);
    const choice = choices[0];
    if (!choice) {
      unavailable.push({ localCardId: card.localCardId, network: card.network, last4: card.last4, productName: profile.name,
        estimatedValue: null, benefits: profile.rewards, sourceUrl: profile.sourceUrl, conditions: [],
        unavailableReason: 'No applicable sourced rule is available for this purchase. This does not mean the card earns no rewards.' });
      continue;
    }
    candidates.push({ localCardId: card.localCardId, network: card.network, last4: card.last4, productId: profile.productId,
      productName: profile.name, estimatedValue: (choice.estimatedValueCents / 100).toFixed(2),
      rewardUnits: choice.rewardUnits, unit: choice.rule.unit, rate: choice.rule.rate,
      sourceUrl: profile.sourceUrl, retrievedAt: profile.retrievedAt, conditions: choice.conditions,
      mappingSource: mapping.mappingSource, benefits: profile.rewards });
  }
  candidates.sort((a, b) => Number(b.estimatedValue) - Number(a.estimatedValue));
  const best = candidates[0] || null;
  return { bestCard: best, options: [...candidates, ...unavailable], purchase, comparedCards: candidates.length, currency: 'USD',
    reason: best ? `Highest estimated reward among ${candidates.length} mapped cards with applicable sourced rules for ${purchase.merchantName} (${purchase.category}).` : 'No mapped card has an applicable sourced reward rule for this purchase.',
    assumptions: ['Card products are temporary hardcoded sandbox assumptions.', 'Membership Rewards points are valued at 1 US cent each for this comparison; actual redemption value varies.',
      ...(purchase.categoryBasis === 'sandbox-department-simulation' ? ['The purchase category is a simulated store-department scenario, not a verified merchant category.'] : [])],
    conditional: true };
}
