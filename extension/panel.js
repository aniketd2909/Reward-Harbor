let API = globalThis.RewardHarborConfig?.defaultApi || 'http://localhost:3000';
const $ = selector => document.querySelector(selector);
let snapshot, generation = 0, scanning = false, rescanQueued = false;
let trackingToken, completedOrderId, lastTotals, lastTransaction;
const shownReceipts = new Set();
let watchingOrderId, checkingCompletion = false;
function completed(receipt) {
  const id = receipt.transaction.orderId;
  completedOrderId = id;
  renderSavings(receipt.totals, receipt.transaction, true);
  invalidate(); $('main').hidden = true; $('#purchase-details').hidden = true;
  message('');
  if (!shownReceipts.has(id)) {
    shownReceipts.add(id);
    const transaction = receipt.transaction;
    const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
    $('#receipt-content').replaceChildren(
      node('p', transaction.estimatedSavingsCents == null ? 'Savings for this payment are unavailable.' : `Estimated savings this payment: ${money(transaction.estimatedSavingsCents)}`),
      savingsAmount(receipt.totals.estimatedSavingsCents)
    );
    if (!$('#receipt-dialog').open) $('#receipt-dialog').showModal();
  }
}
$('#close-receipt').addEventListener('click', () => $('#receipt-dialog').close());
setInterval(async () => {
  if (!watchingOrderId || checkingCompletion) return;
  checkingCompletion = true;
  try {
    const result = await chrome.runtime.sendMessage({ type: 'CHECK_COMPLETION', orderId: watchingOrderId });
    if (result?.receipt) { completed(result.receipt); watchingOrderId = null; }
  } catch { /* The next poll retries a disconnected service worker. */ } finally { checkingCompletion = false; }
}, 2500);
function message(text, error = false) { $('#status').textContent = text; $('#status').className = error ? 'error' : ''; }
function invalidate() { generation++; $('#results').replaceChildren(); }
function node(tag, text, className) { const element = document.createElement(tag); if (text !== undefined) element.textContent = text; if (className) element.className = className; return element; }
function purchase() { return { ...snapshot?.purchase, currency: snapshot?.purchase?.currency || 'USD', category: snapshot?.purchase?.category || 'unknown' }; }
function summary() {
  const p = purchase();
  $('#purchase-summary').textContent = `${p.merchantName || 'Merchant unavailable'} · ${p.currency} ${p.amount || '—'} · ${p.category}`;
}
function savingsAmount(cents) {
  const line = node('p', 'Estimated savings: ', 'savings-total');
  line.append(node('strong', new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100), 'savings-amount'));
  return line;
}
function renderSavings(totals, transaction = totals.lastTransaction, current = false) {
  lastTotals = totals; lastTransaction = transaction;
  const money = cents => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
  $('#savings').hidden = false;
  $('#savings').replaceChildren(savingsAmount(totals.estimatedSavingsCents));
}
function renderCard(card, data, isBest = false) {
  const box = node('article', undefined, `result${isBest ? ' best' : ''}`);
  box.append(node('span', isBest ? 'BEST ESTIMATED CARD' : 'OTHER CARD', 'tag'), node('h2', card.productName), node('p', `${card.network} ••••${card.last4}`));
  if (card.estimatedValue != null) {
    box.append(node('div', `$${card.estimatedValue}`, 'value'));
    box.append(node('p', card.unit === 'points_per_usd' ? `${card.rewardUnits} points · ${card.rate} points/$ · estimated at 1¢ per point` : `${card.rate}% cashback on this purchase`));
  } else box.append(node('p', card.unavailableReason || 'Reward estimate unavailable.'));

  if (card.benefits?.length) {
    const benefits = node('details'); benefits.append(node('summary', 'Card rewards and benefits'));
    const list = node('ul');
    for (const reward of card.benefits) {
      const rate = reward.unit === 'points_per_usd' ? `${reward.rate} points/$` : `${reward.rate}% cashback`;
      const qualifiers = [];
      if (reward.annualSpendCapUsd != null) qualifiers.push(`up to $${reward.annualSpendCapUsd.toLocaleString('en-US')} eligible spending per ${reward.capPeriod === 'calendar_year' ? 'calendar year' : 'year'}`);
      if (reward.afterCapRate != null) qualifiers.push(`then ${reward.afterCapRate}${reward.unit === 'points_per_usd' ? ' point(s)/$' : '% cashback'}`);
      if (reward.geography === 'US') qualifiers.push('eligible U.S. merchants');
      if (reward.bookingChannels) qualifiers.push(`booking channel: ${reward.bookingChannels.join(', ').replaceAll('_', ' ')}`);
      if (reward.prepaidRequired) qualifiers.push('prepaid booking required');
      if (reward.activationRequired) qualifiers.push('activation required');
      qualifiers.push(...(reward.conditions || []));
      list.append(node('li', `${reward.category === '*' ? 'Other eligible purchases' : reward.category}: ${rate}${qualifiers.length ? ` — ${qualifiers.join('; ')}` : ''}`));
    }
    benefits.append(node('p', 'General advertised benefits; categories and booking restrictions may not apply to this purchase.', 'muted'), list); box.append(benefits);
  }
  if (card.sourceUrl) {
    const sourceLine = node('p', 'Source: ', 'source');
    const source = node('a', 'Official issuer reward details'); source.href = card.sourceUrl; source.target = '_blank'; source.rel = 'noopener noreferrer';
    sourceLine.append(source); box.append(sourceLine);
  }
  return box;
}
async function showDetectedCards(version) {
  let mappings = [], dataSource = 'visible-checkout';
  try {
    const response = await fetch(`${API}/api/sandbox-card-mappings`, { signal: AbortSignal.timeout(10000) });
    if (response.ok) { const data = await response.json(); mappings = data.mappings || []; dataSource = data.dataSource; }
  } catch { /* Visible cards remain useful even when the catalog is offline. */ }
  if (version !== generation) return;
  $('#results').append(node('h2', 'Detected cards'));
  for (const card of snapshot.cards) {
    const mapping = mappings.find(m => m.network === card.network && m.last4 === card.last4 && [m.cardReference, `${m.network}:${m.last4}`].includes(card.localCardId));
    const profile = mapping?.profile;
    const box = renderCard({ ...card, productName: profile?.name || `${card.network} card`, estimatedValue: null,
      unavailableReason: 'Purchase details are incomplete; a reward estimate is not available.',
      benefits: profile?.rewards || [], sourceUrl: profile?.sourceUrl }, { dataSource, assumptions: [] });
    box.querySelector('.tag').textContent = 'DETECTED CARD';
    $('#results').append(box);
  }
}
async function recommend() {
  invalidate(); const version = generation;
  const completed = snapshot?.checkoutState === 'completed' || Boolean(completedOrderId && snapshot?.orderId === completedOrderId);
  const paymentPortal = /^https:\/\/(www\.)?sandbox\.paypal\.com\//i.test(snapshot?.page || '') && (/\/.*checkout/i.test(new URL(snapshot.page).pathname) || Boolean(snapshot.orderId && snapshot.cards?.length));
  const ended = completed || ['cancelled', 'changed', 'failed'].includes(snapshot?.checkoutState) || snapshot?.purchase?.source === 'checkout-ended';
  $('main').hidden = !paymentPortal || ended;
  $('#purchase-details').hidden = !paymentPortal || ended;
  if (!paymentPortal || ended) { message(''); return; }
  if (!snapshot?.cards.length) { message('Open PayPal’s payment-method list to make your cards visible.'); return; }
  if (snapshot.purchase?.source === 'checkout-ended') { message('This checkout has ended or changed. Start a new payment from the store.'); return; }
  const p = purchase(); summary();
  if (!p.merchantName || !p.amount || p.category === 'unknown') {
    message('Cards detected. This checkout does not provide enough merchant/category information to recommend a best card.');
    await showDetectedCards(version); return;
  }
  try {
    message('Finding your best card…');
    const response = await fetch(`${API}/api/best-card`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(trackingToken ? { Authorization: `Bearer ${trackingToken}` } : {}) },
      body: JSON.stringify({ purchase: p, cards: snapshot.cards,
        ...(trackingToken && snapshot.orderId ? { orderId: snapshot.orderId, baselineSelection: snapshot.baselineSelection || null } : {}) }), signal: AbortSignal.timeout(15000) });
    const data = await response.json();
    if (!response.ok) throw new Error(response.status === 404 ? 'Restart the backend to enable the updated recommendation endpoint.' : data.error || 'Could not calculate rewards.');
    if (version !== generation) return;
    const best = data.bestCard;
    if (best) $('#results').append(renderCard(best, data, true));
    const alternatives = (data.options || []).filter(card => card.localCardId !== best?.localCardId);
    if (alternatives.length) {
      const dropdown = node('details', undefined, 'alternatives');
      dropdown.append(node('summary', `${best ? 'Other available cards' : 'Available cards'} (${alternatives.length})`));
      for (const card of alternatives) dropdown.append(renderCard(card, data));
      $('#results').append(dropdown);
    }
    message(best ? 'Select this card in PayPal to use its rewards.' : data.reason);
  } catch (error) { if (version === generation) message(error.message || 'Start the backend with npm run dev and retry.', true); }
}
async function scan({ automatic = false } = {}) {
  if (scanning) { rescanQueued = true; invalidate(); return; }
  scanning = true;
  try {
    const response = await chrome.runtime.sendMessage({ type: 'SCAN_ACTIVE_TAB' });
    if (!response?.ok) throw new Error(response?.error || 'Cannot read this page.');
    const next = response.snapshot;
    if (automatic && snapshot && JSON.stringify(snapshot) === JSON.stringify(next)) return;
    if (lastTotals && next.orderId && next.orderId !== completedOrderId && next.checkoutState !== 'completed') renderSavings(lastTotals, lastTransaction);
    const nextApi = globalThis.RewardHarborConfig?.storeOrigin(next.apiBase) || API;
    if (nextApi !== API) {
      API = nextApi;
      const history = await chrome.runtime.sendMessage({ type: 'GET_SAVINGS', apiBase: API });
      if (history?.totals) renderSavings(history.totals);
    }
    snapshot = next;
    if (next.orderId && next.orderId !== completedOrderId) watchingOrderId = next.orderId;
    $('#card-count').textContent = `${next.cards.length} visible card${next.cards.length === 1 ? '' : 's'} · automatic sandbox mappings`;
    summary(); await recommend();
  } catch (error) { snapshot = null; invalidate(); $('main').hidden = true; message(''); }
  finally {
    scanning = false;
    if (rescanQueued) { rescanQueued = false; queueMicrotask(() => scan()); }
  }
}
$('#refresh').addEventListener('click', () => scan());
chrome.runtime.onMessage.addListener(event => {
  if (event.type === 'PAGE_CHANGED') scan({ automatic: true });
  if (event.type === 'SAVINGS_UPDATED') {
    completed(event.receipt);
  }
  if (event.type === 'SAVINGS_UNAVAILABLE') {
    message('Payment completed. Savings could not be updated; reopen the panel to retry.', true);
  }
});
chrome.tabs.onActivated.addListener(() => scan({ automatic: true }));

(async () => {
  trackingToken = (await chrome.runtime.sendMessage({ type: 'GET_HISTORY_TOKEN' }))?.token;
  const history = await chrome.runtime.sendMessage({ type: 'GET_SAVINGS', apiBase: API });
  if (history?.totals) renderSavings(history.totals);
  await scan();
})().catch(() => scan());

if (window !== window.top) document.documentElement.classList.add('floating-panel');

// Let the host fit the quiet state instead of reserving checkout-sized space.
if (window !== window.top) {
  let previousHeight;
  function resizeFloating() {
    const compact = $('main').hidden && !$('#receipt-dialog').open;
    const height = compact ? Math.ceil($('header').getBoundingClientRect().height + $('.banner').getBoundingClientRect().height) + 2 : 510;
    if (height === previousHeight) return;
    previousHeight = height;
    window.parent.postMessage({ type: 'REWARD_HARBOR_SIZE', height }, '*');
  }
  new ResizeObserver(resizeFloating).observe(document.body);
  new MutationObserver(resizeFloating).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['hidden', 'open'] });
  resizeFloating();
}
