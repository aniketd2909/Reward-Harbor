export const cardProducts = [
  { id: 'demo-visa-grocery', name: 'Grocery Plus · fictional demo', issuer: 'Demo Bank', network: 'Visa', country: 'US' },
  { id: 'demo-mastercard-everyday', name: 'Everyday · fictional demo', issuer: 'Demo Bank', network: 'Mastercard', country: 'US' },
  { id: 'demo-amex-gold', name: 'Gold · demo rules only', issuer: 'American Express', network: 'Amex', country: 'US' },
  { id: 'demo-amex-platinum', name: 'Platinum · demo rules only', issuer: 'American Express', network: 'Amex', country: 'US' },
];
// These rates are invented fixtures. They make no claims about actual card benefits.
export const demoRules = cardProducts.flatMap((product, i) => [
  { id: `${product.id}-base`, productId: product.id, kind: 'base', basisPoints: [100, 200, 100, 100][i],
    category: '*', paypalEligibility: 'eligible', activationRequired: false, capCents: null,
    start: '2020-01-01', end: '2099-12-31', demo: true, source: 'Local synthetic demo fixture', verifiedAt: null },
  ...([0, 2].includes(i) ? [{ id: `${product.id}-grocery`, productId: product.id, kind: 'incremental', basisPoints: i === 0 ? 400 : 200,
    category: 'grocery', paypalEligibility: 'eligible', activationRequired: i === 0, capCents: i === 0 ? 50000 : null,
    start: '2020-01-01', end: '2099-12-31', demo: true, source: 'Local synthetic demo fixture', verifiedAt: null }] : []),
]);
const bad = message => Object.assign(new Error(message), { status: 400 });
export function validateRecommendation(input) {
  if (!input || typeof input !== 'object') throw bad('Expected a purchase and card mappings.');
  const p = input.purchase;
  if (!p || typeof p.amount !== 'string' || !/^\d{1,6}\.\d{2}$/.test(p.amount) || Number(p.amount) <= 0 || p.currency !== 'USD') throw bad('Enter a positive USD purchase amount, with two decimal places.');
  if (typeof p.merchantName !== 'string' || !p.merchantName.trim() || p.merchantName.length > 120) throw bad('Enter a merchant name.');
  if (!['grocery', 'dining', 'travel', 'other', 'unknown'].includes(p.category)) throw bad('Choose a supported purchase category.');
  if (!Array.isArray(input.cards) || !input.cards.length || input.cards.length > 20) throw bad('Map between 1 and 20 cards.');
  const ids = new Set();
  for (const card of input.cards) {
    if (!card || typeof card.localCardId !== 'string' || card.localCardId.length > 120 || ids.has(card.localCardId) || !cardProducts.some(p => p.id === card.productId)) throw bad('Choose a valid, distinct card mapping.');
    ids.add(card.localCardId);
    if (![true, false, null, undefined].includes(card.offerActivated)) throw bad('Invalid activation status.');
    if (card.bonusRemainingCents != null && (!Number.isSafeInteger(card.bonusRemainingCents) || card.bonusRemainingCents < 0)) throw bad('Invalid remaining bonus allowance.');
  }
}
export function calculateRecommendations(input, rules, date = new Date().toISOString().slice(0, 10)) {
  validateRecommendation(input);
  const cents = Number(input.purchase.amount.replace('.', ''));
  const results = input.cards.map(card => {
    const applicable = rules.filter(r => r.productId === card.productId && r.start <= date && r.end >= date && r.paypalEligibility !== 'excluded' &&
      (r.category === '*' || r.category === input.purchase.category) && (!r.merchantName || r.merchantName.toLowerCase() === input.purchase.merchantName.toLowerCase()));
    const conditions = []; const evidence = []; let numerator = 0; let confirmedNumerator = 0;
    // Supported schema: one base rate plus explicitly additive, stackable increments.
    const base = applicable.filter(r => r.kind === 'base').sort((a, b) => b.basisPoints - a.basisPoints)[0];
    const selected = [...(base ? [base] : []), ...applicable.filter(r => r.kind === 'incremental')];
    if (!base) conditions.push('No applicable base reward rule is available.');
    if (input.purchase.category === 'unknown') conditions.push('Merchant category is unknown; category bonuses are not included.');
    for (const rule of selected) {
      if (!Number.isInteger(rule.basisPoints) || rule.basisPoints < 0 || rule.basisPoints > 10000) continue;
      if (rule.activationRequired && card.offerActivated === false) continue;
      let eligibleCents = cents; let conditional = false;
      if (rule.activationRequired && card.offerActivated !== true) { conditional = true; conditions.push('Confirm that the promotional offer is activated.'); }
      if (rule.paypalEligibility !== 'eligible') { conditional = true; conditions.push('Confirm this rule applies to PayPal-funded purchases.'); }
      if (rule.capCents != null) {
        eligibleCents = Math.min(cents, rule.capCents, card.bonusRemainingCents ?? rule.capCents);
        if (card.bonusRemainingCents == null) { conditional = true; conditions.push('Remaining bonus spending allowance is unknown.'); }
      }
      const value = eligibleCents * rule.basisPoints;
      numerator += value; if (!conditional) confirmedNumerator += value;
      evidence.push({ ruleId: rule.id, basisPoints: rule.basisPoints, kind: rule.kind, source: rule.source, verifiedAt: rule.verifiedAt, demo: rule.demo });
    }
    return { localCardId: card.localCardId, productId: card.productId,
      estimatedReward: (Math.round(numerator / 10000) / 100).toFixed(2),
      confirmedReward: (Math.round(confirmedNumerator / 10000) / 100).toFixed(2),
      conditional: conditions.length > 0, conditions: [...new Set(conditions)], evidence,
      demo: evidence.some(e => e.demo), available: Boolean(base) };
  });
  results.sort((a, b) => Number(b.available) - Number(a.available) || Number(b.confirmedReward) - Number(a.confirmedReward) || Number(b.estimatedReward) - Number(a.estimatedReward));
  return { currency: 'USD', results, rankedBy: 'Confirmed estimated reward, then conditional potential',
    recommendedCardId: results[0]?.available ? results[0].localCardId : null,
    disclaimer: 'Demo reward rules are synthetic. Merchant categories and issuer eligibility must be verified before real-world recommendations.' };
}

export function rewardService({ elasticUrl = '', apiKey = '', index = 'reward-rules', fetchImpl = fetch } = {}) {
  if (elasticUrl && (new URL(elasticUrl).protocol !== 'https:' || !/^[a-z0-9_-]+$/.test(index))) throw new Error('Use an HTTPS Elastic URL and a simple index name.');
  return async function routes(req, res, url, readBody, send) {
    if (req.method === 'GET' && url.pathname === '/api/card-products') {
      const network = url.searchParams.get('network')?.toLowerCase();
      send(200, { products: cardProducts.filter(p => !network || p.network.toLowerCase() === network), demo: true }); return true;
    }
    if (req.method !== 'POST' || url.pathname !== '/api/recommendations') return false;
    const input = await readBody(req); validateRecommendation(input);
    let rules = demoRules;
    if (elasticUrl) {
      const response = await fetchImpl(`${elasticUrl.replace(/\/$/, '')}/${index}/_search`, {
        method: 'POST', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json', Authorization: `ApiKey ${apiKey}` },
        body: JSON.stringify({ size: 200, query: { bool: { filter: [
          { terms: { productId: input.cards.map(c => c.productId) } },
          { range: { start: { lte: new Date().toISOString().slice(0, 10) } } },
          { range: { end: { gte: new Date().toISOString().slice(0, 10) } } },
        ] } } }),
      });
      if (!response.ok) throw Object.assign(new Error('Elastic search is unavailable. No recommendation was generated.'), { status: 503 });
      const data = await response.json(); rules = data.hits?.hits?.map(h => h._source) || [];
    }
    send(200, { ...calculateRecommendations(input, rules), dataSource: elasticUrl ? 'elastic' : 'local-demo' }); return true;
  };
}
