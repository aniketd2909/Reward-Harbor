// Isolated, top-frame UI. The page cannot read the extension iframe's storage or API key.
(() => {
  if (window !== window.top) return;
  const sandbox = /^(www\.)?sandbox\.paypal\.com$/.test(location.hostname);
  const demo = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (!sandbox && !demo) return;
  let host, observer, routeTimer, lastState, opened = false;
  function stop() { observer?.disconnect(); clearInterval(routeTimer); host?.remove(); }
  function update() {
    try { if (!chrome.runtime?.id) return stop(); } catch { return stop(); }
    // PayPal can replace login with checkout without loading a new document.
    const snapshot = sandbox ? globalThis.rewardSnapshot?.() : null;
    const checkout = sandbox && (/^\/.*checkout/i.test(location.pathname) || Boolean(snapshot?.checkoutOrderId && snapshot?.cards?.length));
    let payment;
    try { payment = JSON.parse(document.documentElement.dataset.rewardPayment || 'null'); } catch {}
    if (!checkout && !payment) return;
    if (!host) mount();
    else if (!host.isConnected) document.documentElement.append(host);
    const state = checkout ? `checkout:${snapshot?.checkoutOrderId || location.pathname}` : `${payment.orderId}:${payment.state}`;
    if (state !== lastState) {
      lastState = state;
      // Keep the merchant overlay closed while PayPal owns focus; reopen on capture.
      if (checkout || payment?.state === 'completed') setOpen(true);
    }
  }
  let frame, toggle;
  window.addEventListener('message', event => {
    if (!frame || event.source !== frame.contentWindow || event.origin !== chrome.runtime.getURL('').replace(/\/$/, '')) return;
    if (event.data?.type !== 'REWARD_HARBOR_SIZE' || !Number.isFinite(event.data.height)) return;
    const height = Math.max(100, Math.min(510, event.data.height));
    frame.style.height = `min(${height}px, calc(100dvh - 100px))`;
  });
  function setOpen(value) {
    opened = value; frame.hidden = !value;
    toggle.textContent = value ? '×' : '↗';
    toggle.setAttribute('aria-expanded', String(value));
    toggle.setAttribute('aria-label', value ? 'Close Reward Harbor' : 'Open Reward Harbor');
  }
  function mount() {
    host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;right:16px;bottom:16px;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `:host{color-scheme:dark}button{display:block;margin-left:auto;width:44px;height:44px;border:1px solid #a99bff;border-radius:50%;background:#6554df;color:white;font:26px system-ui;cursor:pointer;box-shadow:0 6px 24px #0005}button:focus-visible{outline:3px solid #b7f3db;outline-offset:3px}iframe{display:block;width:min(340px,calc(100vw - 32px));height:min(510px,calc(100dvh - 100px));border:1px solid #7465f5;border-radius:16px;margin-bottom:12px;background:#101421;box-shadow:0 16px 64px #0007}iframe[hidden]{display:none}`;
    frame = document.createElement('iframe'); frame.hidden = true;
    frame.src = chrome.runtime.getURL('panel.html'); frame.title = 'Reward Harbor card rewards advisor';
    toggle = document.createElement('button'); toggle.type = 'button'; toggle.textContent = '↗';
    toggle.addEventListener('click', () => setOpen(!opened));
    root.append(style, frame, toggle); document.documentElement.append(host);
    setOpen(false);
  }
  chrome.runtime.onMessage.addListener(message => {
    if (message.type === 'TOGGLE_ADVISOR') { if (!host) mount(); setOpen(!opened); }
  });
  observer = new MutationObserver(update);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-reward-payment'] });
  // A short route check also covers history.replaceState, which has no browser event.
  routeTimer = setInterval(update, 750);
  window.addEventListener('popstate', update);
  window.addEventListener('pageshow', update);
  window.addEventListener('pagehide', event => { if (!event.persisted) stop(); });
  update();
})();
