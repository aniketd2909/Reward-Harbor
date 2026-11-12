const $ = selector => document.querySelector(selector);
const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
let config, department = 'all', catalogGeneration = 0, quoteGeneration = 0;
let selected, selectedQuote, busy = false, paid = false, pendingOrder, activeOrderId, sdkPromise;
function node(tag, text, className) { const el = document.createElement(tag); if (text !== undefined) el.textContent = text; if (className) el.className = className; return el; }
async function request(path, body) {
  const response = await fetch(path, { ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(40000) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Please try again shortly.'); return result;
}
function status(text, state = '') { $('#status').textContent = text; $('#status').dataset.state = state; }
function publishPayment(state, orderId = activeOrderId) {
  if (!orderId) return;
  document.documentElement.dataset.rewardPayment = JSON.stringify({ orderId, state, purchase: JSON.parse(document.documentElement.dataset.rewardCheckout || '{}') });
  window.dispatchEvent(new CustomEvent('reward-payment-changed')); if (state !== 'active') activeOrderId = null;
}
function publishPurchase(purchase) {
  publishPayment('changed'); delete document.documentElement.dataset.rewardPayment;
  document.documentElement.dataset.rewardCheckout = JSON.stringify({ merchantName: purchase.merchantName, amount: purchase.amount,
    currency: purchase.currency, category: purchase.category, country: purchase.country, categoryBasis: purchase.categoryBasis, source: 'demo-catalog' });
  window.dispatchEvent(new CustomEvent('reward-checkout-changed'));
}
function lock(value) {
  busy = value; $('#quantity').disabled = value || paid; $('#offer').disabled = value || paid;
  for (const button of document.querySelectorAll('[data-buy]')) button.disabled = value;
}
function image(el, fallback, url, alt = '') {
  // Lazy images need a visible layout box to start loading. Keep the image in
  // layout while showing the fallback, rather than using display:none.
  el.alt = alt; el.hidden = !url; el.style.opacity = url ? '0' : ''; fallback.hidden = false;
  fallback.style.position = 'absolute';
  el.onload = () => { el.hidden = false; el.style.opacity = '1'; fallback.hidden = true; };
  el.onerror = () => { el.hidden = true; fallback.hidden = false; };
  if (url) { el.src = url; if (el.complete && el.naturalWidth > 0) el.onload(); } else el.removeAttribute('src');
}
async function loadCatalog() {
  const generation = ++catalogGeneration;
  $('#product-grid').setAttribute('aria-busy', 'true'); $('#retry-catalog').hidden = true;
  $('#catalog-status').textContent = 'Finding fresh offers…';
  $('#product-grid').replaceChildren(...Array.from({ length: 8 }, () => node('div', undefined, 'skeleton')));
  try {
    const params = new URLSearchParams({ department }); const query = $('#search').value.trim(); if (query) params.set('q', query);
    const data = await request(`/api/storefront/products?${params}`);
    if (generation !== catalogGeneration) return;
    $('#product-grid').replaceChildren();
    const title = department === 'all' ? 'The everyday edit' : data.departments.find(d => d.id === department)?.name;
    $('#collection-title').textContent = query ? `Finds for “${query}”` : title;
    $('#product-count').textContent = `${data.products.length} live finds · Channel3`;
    $('#catalog-status').textContent = !data.products.length ? 'No available offers found. Try another search or department.' : data.partial ? 'Some collections could not be loaded. Try refreshing to see more.' : '';
    for (const product of data.products) {
      const offer = product.offers.find(o => o.price > 0); if (!offer) continue;
      const card = node('article', undefined, 'product-card'); const visual = node('div', undefined, 'product-visual');
      const img = document.createElement('img'); img.loading = 'lazy'; const fallback = node('span', product.title.charAt(0), 'initial');
      image(img, fallback, product.imageUrl, product.title); visual.append(img, fallback, node('span', product.departmentName, 'product-tag'));
      const info = node('div', undefined, 'product-info'); info.append(node('p', offer.domain, 'eyebrow'), node('h3', product.title));
      const bottom = node('div', undefined, 'product-bottom'); const button = node('button', 'View & pay ↗');
      button.dataset.buy = product.id; button.disabled = busy; button.addEventListener('click', () => openProduct(product));
      bottom.append(node('strong', `From ${money(offer.price)}`), button); info.append(bottom); card.append(visual, info); $('#product-grid').append(card);
    }
    if (data.products[0]) image($('#hero-image'), $('#hero-fallback'), data.products[0].imageUrl);
  } catch (error) {
    if (generation !== catalogGeneration) return;
    $('#product-grid').replaceChildren(); $('#catalog-status').textContent = error.message; $('#retry-catalog').hidden = false;
  } finally { if (generation === catalogGeneration) $('#product-grid').setAttribute('aria-busy', 'false'); }
}
async function openProduct(product) {
  if (busy) return;
  selected = { id: product.id, department: product.department }; selectedQuote = null; paid = false; pendingOrder = null;
  $('#quantity').value = '1'; $('#checkout-heading').textContent = product.title; $('#detail-department').textContent = product.departmentName;
  image($('#detail-image'), $('#detail-fallback'), product.imageUrl, product.title);
  $('#description').textContent = product.selectedOptions?.map(o => `${o.name}: ${o.label}`).join(' · ') || 'A live catalog find, ready for a sandbox checkout.';
  $('#offer').replaceChildren(); $('#total').textContent = '—'; $('#retry-capture').hidden = true; $('#continue-shopping').hidden = true;
  if (!$('#product-dialog').open) $('#product-dialog').showModal();
  await requote();
}
async function requote() {
  const quantity = Number($('#quantity').value);
  if (!selected || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) { status('Choose a quantity from 1 to 10.', 'error'); $('#paypal-button-container').hidden = true; return; }
  const generation = ++quoteGeneration; lock(true); $('#paypal-button-container').hidden = true; status('Checking the current offer…');
  try {
    const quote = await request('/api/storefront/quote', { productId: selected.id, department: selected.department,
      quantity, offerDomain: $('#offer').value || undefined });
    if (generation !== quoteGeneration) return;
    selectedQuote = quote;
    $('#offer').replaceChildren(...quote.product.offers.filter(o => o.price > 0).map(offer => {
      const option = node('option', `${offer.domain} · ${money(offer.price)}${offer.condition !== 'unknown' ? ` · ${offer.condition}` : ''}`); option.value = offer.domain; return option;
    }));
    $('#offer').value = quote.selectedOffer.domain;
    $('#merchant').textContent = quote.purchase.merchantName; $('#checkout-category').textContent = quote.purchase.category;
    $('#total').textContent = money(Number(quote.purchase.amount));
    publishPurchase(quote.purchase);
    $('#setup').hidden = config.configured;
    if (config.configured) { await setupPayPal(); $('#paypal-button-container').hidden = false; status('Ready. Pay securely with your sandbox buyer account.'); }
    else status('Sandbox payment credentials are not configured.');
  } catch (error) { selectedQuote = null; status(error.message, 'error'); }
  finally { if (generation === quoteGeneration) lock(false); }
}
async function capture(orderId) {
  pendingOrder = orderId; status('Confirming your sandbox payment…');
  try {
    const result = await request(`/api/paypal/orders/${encodeURIComponent(orderId)}/capture`, {});
    paid = true; lock(false); pendingOrder = null; publishPayment('completed', orderId);
    $('#retry-capture').hidden = true; $('#paypal-button-container').hidden = true; $('#continue-shopping').hidden = false;
    $('#payment-success-info').textContent = `${result.currency} ${result.amount}`;
    $('#payment-success').showModal();
    status(`Sandbox payment completed · ${result.currency} ${result.amount}`, 'success');
  } catch (error) {
    lock(true); $('#retry-capture').hidden = false;
    status(`${error.message} Use “Check payment again” for this order.`, 'error'); throw error;
  }
}
function setupPayPal() {
  return sdkPromise ||= (async () => {
    status('Connecting to PayPal sandbox…');
    const script = document.createElement('script'); script.src = 'https://www.sandbox.paypal.com/web-sdk/v6/core';
    await new Promise((resolve, reject) => { script.onload = resolve; script.onerror = () => reject(new Error('PayPal could not load. Refresh and try again.')); document.head.append(script); });
    const sdk = await window.paypal.createInstance({ clientId: config.clientId, components: ['paypal-payments'], pageType: 'checkout' });
    const eligibility = await sdk.findEligibleMethods({ currencyCode: 'USD' });
    if (!eligibility.isEligible('paypal')) throw new Error('PayPal checkout is unavailable in this browser.');
    const session = await sdk.createPayPalOneTimePaymentSession({ onApprove: ({ orderId }) => capture(orderId),
      onCancel: () => { if (!pendingOrder) { publishPayment('cancelled'); lock(false); status('Payment cancelled. You can try again.'); } },
      onError: () => { if (!pendingOrder) { publishPayment('failed'); lock(false); status('PayPal could not complete checkout. Please try again.', 'error'); } },
    });
    const button = document.createElement('paypal-button'); $('#paypal-button-container').replaceChildren(button);
    button.addEventListener('click', async () => {
      if (busy || paid || !selectedQuote) return;
      lock(true); status('Opening PayPal sandbox…');
      try {
        const orderPromise = request('/api/paypal/orders', { quoteId: selectedQuote.quoteId }).then(data => {
          activeOrderId = data.id; publishPayment('active'); return { orderId: data.id };
        });
        await session.start({ presentationMode: 'auto' }, orderPromise);
      } catch (error) { if (!pendingOrder) { publishPayment('failed'); lock(false); status(error.message || 'Could not start checkout.', 'error'); } }
    });
  })().catch(error => { sdkPromise = null; throw error; });
}
$('#quantity').addEventListener('change', requote); $('#offer').addEventListener('change', requote);
$('#retry-capture').addEventListener('click', async () => { $('#retry-capture').disabled = true; try { await capture(pendingOrder); } catch {} finally { $('#retry-capture').disabled = false; } });
function closeCheckout() { if (!busy) $('#product-dialog').close(); }
$('#close-checkout').addEventListener('click', closeCheckout); $('#continue-shopping').addEventListener('click', closeCheckout);
$('#product-dialog').addEventListener('cancel', event => { if (busy) event.preventDefault(); });
$('#department-tabs').addEventListener('click', event => {
  const button = event.target.closest('[data-department]'); if (!button) return;
  department = button.dataset.department; $('#search').value = '';
  for (const tab of document.querySelectorAll('[data-department]')) { tab.classList.toggle('active', tab === button); tab.setAttribute('aria-pressed', String(tab === button)); }
  loadCatalog();
});
$('#search-form').addEventListener('submit', event => { event.preventDefault(); loadCatalog(); });
$('#retry-catalog').addEventListener('click', loadCatalog);
request('/api/config').then(data => { config = data; return loadCatalog(); }).catch(error => { $('#catalog-status').textContent = error.message; });

$('#close-payment-success').addEventListener('click', () => { $('#payment-success').close(); $('#product-dialog').close(); });
