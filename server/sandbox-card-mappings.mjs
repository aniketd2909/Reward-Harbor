// Temporary, user-authorized assumptions for the two observed sandbox cards.
// These product types were NOT inferred from PayPal or a BIN lookup.
export const sandboxCardMappings = [
  { cardReference: 'CC-R8QQHYHB2HNBU', network: 'Amex', last4: '2402', productId: 'us-amex-gold', assumedProductName: 'American Express Gold Card', mappingSource: 'hardcoded-sandbox-assumption' },
  { cardReference: 'CC-7BZX84H2UYJJC', network: 'Visa', last4: '6302', productId: 'us-chase-freedom-unlimited', assumedProductName: 'Chase Freedom Unlimited', mappingSource: 'hardcoded-sandbox-assumption' },
];
