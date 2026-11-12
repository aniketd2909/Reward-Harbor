// US consumer cards only. Parsers fail closed when the advertised rate changes.
// Conditions are curated summaries; full issuer terms and PayPal eligibility still need review.
const rule = (id, category, rate, unit, pattern, extra = {}) => ({
  id, category, rate, unit, pattern, rateType: 'total', activationRequired: false,
  paypalEligibility: 'unknown', ...extra,
});
export const issuerSources = [
  { id: 'us-amex-gold', issuer: 'American Express', name: 'American Express Gold Card', network: 'Amex', country: 'US',
    url: 'https://www.americanexpress.com/us/credit-cards/card/gold-card/', rewardCurrency: 'Membership Rewards',
    rules: [
      rule('dining', 'dining', 4, 'points_per_usd', /(?<rate>4)X\s+Points\s+at\s+Restaurants/i,
        { annualSpendCapUsd: 50000, capPeriod: 'calendar_year', afterCapRate: 1, geography: 'worldwide' }),
      rule('grocery', 'grocery', 4, 'points_per_usd', /(?<rate>4)X\s+Points\s+at\s+U\.?S\.?\s+Supermarkets/i,
        { annualSpendCapUsd: 25000, capPeriod: 'calendar_year', afterCapRate: 1, geography: 'US', conditions: ['Eligible U.S. supermarkets; merchant classification matters.'] }),
      rule('flights', 'flights', 3, 'points_per_usd', /(?<rate>3)X\s+(?:POINTS\s+)?(?:per dollar spent\s+)?On\s+Flights/i,
        { bookingChannels: ['airline_direct', 'amex_travel'] }),
      rule('hotels', 'hotels', 5, 'points_per_usd', /(?<rate>5)X\s+(?:POINTS\s+)?(?:per dollar spent\s+)?On\s+Prepaid Hotels/i,
        { prepaidRequired: true, bookingChannels: ['amex_travel'] }),
    ],
    checks: [/50(?:,000|K)/i, /25(?:,000|K)/i],
  },
  { id: 'us-amex-platinum', issuer: 'American Express', name: 'American Express Platinum Card', network: 'Amex', country: 'US',
    url: 'https://www.americanexpress.com/us/credit-cards/card/platinum/', rewardCurrency: 'Membership Rewards',
    rules: [
      rule('base', '*', 1, 'points_per_usd', /(?<rate>1)X\s+(?:POINTS\s+)?On\s+Other Purchases/i),
      rule('flights', 'flights', 5, 'points_per_usd', /(?<rate>5)X\s+Points\s+on\s+Flights/i,
        { annualSpendCapUsd: 500000, capPeriod: 'calendar_year', afterCapRate: 1, bookingChannels: ['airline_direct', 'amex_travel'] }),
      rule('hotels', 'hotels', 5, 'points_per_usd', /(?<rate>5)X\s+Points\s+on\s+Prepaid Hotels/i,
        { prepaidRequired: true, bookingChannels: ['amex_travel'] }),
    ], checks: [/500,000/],
  },
  { id: 'us-amex-blue-cash-preferred', issuer: 'American Express', name: 'Blue Cash Preferred Card', network: 'Amex', country: 'US',
    url: 'https://www.americanexpress.com/us/credit-cards/card/blue-cash-preferred/', rewardCurrency: 'Reward Dollars',
    rules: [
      rule('base', '*', 1, 'cashback_percent', /(?<rate>1)%\s+Cash Back\s+(?:On\s+)?Other Eligible Purchases/i),
      rule('grocery', 'grocery', 6, 'cashback_percent', /(?<rate>6)%\s+Cash Back\s+at\s+U\.?S\.?\s+Supermarkets/i,
        { annualSpendCapUsd: 6000, capPeriod: 'year_unspecified', afterCapRate: 1, geography: 'US' }),
      rule('streaming', 'streaming', 6, 'cashback_percent', /(?<rate>6)%\s+Cash Back\s+on\s+Select\s+U\.?S\.?\s+Streaming/i,
        { geography: 'US', conditions: ['Only selected streaming subscriptions qualify.'] }),
      rule('transit', 'transit', 3, 'cashback_percent', /(?<rate>3)%\s+Cash Back\s+(?:On\s+)?Transit/i),
      rule('gas', 'gas', 3, 'cashback_percent', /(?<rate>3)%\s+Cash Back\s+(?:On\s+)?Gas/i,
        { geography: 'US', conditions: ['Eligible U.S. gas stations.'] }),
    ], checks: [/6,000/],
  },
  { id: 'us-chase-freedom-unlimited', issuer: 'Chase', name: 'Chase Freedom Unlimited', network: 'Visa', country: 'US',
    url: 'https://creditcards.chase.com/cash-back-credit-cards/freedom/unlimited', rewardCurrency: 'Cashback equivalent (Ultimate Rewards)',
    rules: [
      rule('base', '*', 1.5, 'cashback_percent', /unlimited\s+(?<rate>1\.5)%\s+cash back/i),
      rule('dining', 'dining', 3, 'cashback_percent', /(?<rate>3)%\s+on\s+dining\s+and\s+drugstores/i),
      rule('drugstores', 'drugstores', 3, 'cashback_percent', /(?<rate>3)%\s+on\s+dining\s+and\s+drugstores/i),
      rule('travel', 'travel', 5, 'cashback_percent', /(?<rate>5)%\s+on\s+travel\s+purchased\s+through\s+Chase Travel/i,
        { bookingChannels: ['chase_travel'] }),
    ], checks: [],
  },
];

export function extractIssuerCard(source, text, retrievedAt, sourceHash) {
  const normalized = text.normalize('NFKC').replace(/[®™‡†]/g, '').replace(/\s+/g, ' ');
  const rewards = source.rules.map(spec => {
    const match = normalized.match(spec.pattern);
    if (!match || Number(match.groups?.rate) !== spec.rate) throw new Error(`${source.id}: rate evidence missing for ${spec.id}; review source/parser.`);
    const { pattern, ...fields } = spec;
    return { ...fields, id: `${source.id}-${spec.id}` };
  });
  if (source.checks.some(check => !check.test(normalized))) throw new Error(`${source.id}: cap evidence missing; review source/parser.`);
  return {
    schemaVersion: 1, id: source.id, productId: source.id, issuer: source.issuer, name: source.name,
    network: source.network, country: source.country, rewardCurrency: source.rewardCurrency,
    rewards, sourceUrl: source.url, retrievedAt, sourceHash, demo: false,
    reviewStatus: 'advertised_summary_only', paypalEligibility: 'unknown',
    exclusions: ['Welcome bonuses and personalized offers are not included.', 'Statement credits and annual-fee value are not included.'],
    caveats: ['Selected advertised benefits only; this is not a complete rewards agreement.', 'Review full issuer terms before payment recommendations.', 'Points are not a cashback percentage.', 'Category and booking-channel eligibility must be confirmed.'],
  };
}
