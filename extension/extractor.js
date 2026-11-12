// Shared, deterministic parser. Does not read cookies, storage, or form values.
globalThis.RewardExtractor = (() => {
  function cardFromText(text) {
    if (/\b(checking|savings|bank account)\b/i.test(text)) return null;
    const suffixes = [...text.matchAll(/(?:[•●·*][\s\u00a0]*){2,}(\d{4})(?!\d)|\bending\s+(?:in\s+)?(\d{4})\b/gi)];
    const values = [...new Set(suffixes.map(m => m[1] || m[2]))];
    if (values.length !== 1) return null; // Ambiguous containers must not merge multiple cards.
    const names = [...new Set((text.match(/\b(Visa|Mastercard|American Express|Amex|Discover|Diners Club|JCB|UnionPay)\b/gi) || []).map(n => /^(amex|american express)$/i.test(n) ? 'Amex' : n.toLowerCase()))];
    if (names.length > 1) return null;
    const match = text.match(/\b(Visa|Mastercard|American Express|Amex|Discover|Diners Club|JCB|UnionPay)\b/i);
    const networks = { visa: 'Visa', mastercard: 'Mastercard', 'american express': 'Amex', amex: 'Amex', discover: 'Discover', 'diners club': 'Diners Club', jcb: 'JCB', unionpay: 'UnionPay' };
    if (!match) return null; // A masked suffix alone may belong to a bank account.
    return { network: networks[match[0].toLowerCase()], last4: values[0], type: /\bdebit\b/i.test(text) ? 'debit' : /\bcredit\b/i.test(text) ? 'credit' : 'unknown' };
  }
  function extract(doc, location) {
    const cards = new Map();
    const candidates = doc.querySelectorAll('label, [role="radio"], [role="option"], button, a, li, section, [data-testid]');
    for (const element of candidates) {
      if (!element.getClientRects().length || element.closest('[hidden], [aria-hidden="true"]')) continue;
      const text = element.innerText?.trim();
      if (!text || text.length > 450) continue;
      const card = cardFromText(text);
      if (!card) continue;
      const href = element.closest('a[href]')?.getAttribute('href') || '';
      const reference = href.match(/\/myaccount\/money\/cards\/(CC-[A-Za-z0-9_-]+)(?:[/?#]|$)/)?.[1];
      const id = reference || `${card.network}:${card.last4}`;
      if (card.network === 'Unknown' && [...cards.values()].some(c => c.last4 === card.last4 && c.network !== 'Unknown')) continue;
      if (card.network !== 'Unknown') cards.delete(`Unknown:${card.last4}`);
      cards.set(id, { ...card, localCardId: id, identityConfidence: reference ? 'page-reference' : 'network-and-suffix', requiresConfirmation: true });
    }
    // Detail pages sometimes render the mask outside interactive card containers.
    if (!cards.size && /\/myaccount\/money\/cards\//.test(location.pathname)) {
      const card = cardFromText(doc.body.innerText);
      if (card) cards.set(`${card.network}:${card.last4}`, { ...card, localCardId: `${card.network}:${card.last4}`, identityConfidence: 'network-and-suffix', requiresConfirmation: true });
    }
    let purchase = { merchantName: '', amount: '', currency: 'USD', category: 'unknown', source: 'unavailable' };
    if (['localhost', '127.0.0.1'].includes(location.hostname)) {
      try {
        const candidate = JSON.parse(doc.documentElement.dataset.rewardCheckout);
        if (candidate && typeof candidate.merchantName === 'string') purchase = candidate;
      } catch {}
    } else {
      // Only select a total if its accessible label explicitly identifies it.
      const totals = [...doc.querySelectorAll('[data-testid*="total" i], [aria-label*="total" i]')]
        .filter(e => e.getClientRects().length)
        .map(e => (e.innerText || '').match(/(?:USD\s*|\$)(\d+(?:,\d{3})*\.\d{2})\b/)?.[1]?.replaceAll(',', ''))
        .filter(Boolean);
      // PayPal's full-payment plan explicitly labels the amount due today.
      // Do not use installment or card-row amounts as the purchase total.
      for (const element of doc.querySelectorAll('label, [role="radio"], [data-testid], section')) {
        if (!element.getClientRects().length || element.closest('[hidden], [aria-hidden="true"]')) continue;
        const text = element.innerText?.trim() || '';
        if (text.length > 160) continue;
        const full = text.match(/^Pay in full\s+(?:USD\s*|\$)(\d+(?:,\d{3})*\.\d{2})\s+today\b/i);
        if (full) totals.push(full[1].replaceAll(',', ''));
      }
      const unique = [...new Set(totals)];
      if (unique.length === 1) purchase = { ...purchase, amount: unique[0], source: 'visible-total-label' };
    }
    const values = [...cards.values()].filter(c => c.identityConfidence === 'page-reference' ||
      ![...cards.values()].some(other => other.identityConfidence === 'page-reference' && other.network === c.network && other.last4 === c.last4));
    let checkoutOrderId = null;
    if (['sandbox.paypal.com', 'www.sandbox.paypal.com'].includes(location.hostname)) {
      const token = new URL(location.href).searchParams.get('token');
      if (/^[A-Z0-9]{5,40}$/.test(token || '')) checkoutOrderId = token;
    }
    let selectedFundingSource = null;
    const selected = doc.querySelectorAll('input[type="radio"]:checked, [role="radio"][aria-checked="true"]');
    for (const control of selected) {
      const labels = control.labels ? [...control.labels] : [];
      const parents = []; let parent = control;
      for (let i = 0; parent && i < 6; i++, parent = parent.parentElement) parents.push(parent);
      for (const container of [...labels, ...parents]) {
        const text = container.innerText || '';
        if (text.length > 500) continue;
        const card = cardFromText(text);
        if (card) { selectedFundingSource = { ...card, kind: 'card', localCardId: `${card.network}:${card.last4}` }; break; }
        const maskedSuffixes = new Set([...text.matchAll(/[•●·*]{2,}\s*(\d{4})/g)].map(match => match[1]));
        const bank = maskedSuffixes.size === 1 && text.match(/(?:Checking|Savings)[\s\S]{0,40}?[•●·*]{2,}\s*(\d{4})/i);
        if (bank) { selectedFundingSource = { kind: 'bank', last4: bank[1], localCardId: `bank:${bank[1]}` }; break; }
      }
      if (selectedFundingSource) break;
    }
    let checkoutState;
    if (['localhost', '127.0.0.1'].includes(location.hostname)) {
      try {
        const payment = JSON.parse(doc.documentElement.dataset.rewardPayment || 'null');
        checkoutState = payment?.state;
        checkoutOrderId = payment?.orderId || checkoutOrderId;
      } catch {}
    }
    return { cards: values, purchase, checkoutOrderId, checkoutState, selectedFundingSource, page: location.origin + location.pathname,
      note: 'Visible cards only. Open the funding-source list, then refresh. Confirm mappings if sandbox accounts change or suffixes collide.' };
  }
  return { cardFromText, extract };
})();
