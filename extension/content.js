globalThis.rewardSnapshot = () => globalThis.RewardExtractor.extract(document, location);
let lastSnapshot = '';
let timer, stopped = false;
let observer;
function stop() {
  stopped = true;
  clearTimeout(timer);
  observer?.disconnect();
  window.removeEventListener('reward-checkout-changed', notify);
  window.removeEventListener('reward-payment-changed', paymentChanged);
  document.removeEventListener('click', observePayClick, true);
}
function connected() {
  try { if (!stopped && chrome.runtime?.id) return true; } catch {}
  stop(); return false;
}
async function send(message) {
  if (!connected()) return;
  try { return await chrome.runtime.sendMessage(message); }
  catch (error) {
    if (/extension context invalidated/i.test(error?.message || '') || !connected()) stop();
    // A missing receiver during worker startup is transient; allow a later retry.
  }
}
function notify() {
  if (!connected()) return;
  paymentChanged();
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (!connected()) return;
    const snapshot = globalThis.rewardSnapshot();
    const serialized = JSON.stringify(snapshot);
    if (serialized !== lastSnapshot) {
      lastSnapshot = serialized;
      send({ type: 'FUNDING_OBSERVATION', orderId: snapshot.checkoutOrderId, selection: snapshot.selectedFundingSource }).catch(() => {});
      send({ type: 'PAGE_CHANGED' }).catch(() => {});
    }
  }, 350);
}
observer = new MutationObserver(notify);
observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
window.addEventListener('reward-checkout-changed', notify);
let lastPayment = '';
function paymentChanged() {
  if (!connected()) return;
  if (!(globalThis.RewardHarborConfig?.storeOrigin(location.href) || ['localhost', '127.0.0.1'].includes(location.hostname)) || window !== top) return;
  try {
    const serialized = document.documentElement.dataset.rewardPayment || 'null';
    if (serialized === lastPayment) return;
    const payment = JSON.parse(serialized);
    if (payment) {
      lastPayment = serialized;
      send({ type: 'CHECKOUT_CONTEXT', payment }).then(result => { if (!result?.ok) lastPayment = ''; }).catch(() => { lastPayment = ''; });
    }
  } catch {}
}
window.addEventListener('reward-payment-changed', paymentChanged);
paymentChanged();
function observePayClick(event) {
  if (!connected()) return;
  const button = event.target.closest?.('button, [role="button"]');
  if (!button || !/^pay(?:\s+now)?$/i.test(button.innerText.trim())) return;
  const snapshot = globalThis.rewardSnapshot();
  send({ type: 'FUNDING_OBSERVATION', orderId: snapshot.checkoutOrderId,
    selection: snapshot.selectedFundingSource, final: true }).catch(() => {});
}
document.addEventListener('click', observePayClick, true);

notify();
