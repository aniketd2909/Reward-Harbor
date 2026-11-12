chrome.action?.onClicked.addListener(tab => {
  if (tab.id) chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_ADVISOR' }).catch(() => {});
});
let tokenPromise;
function historyToken() {
  return tokenPromise ||= (async () => {
    const saved = await chrome.storage.local.get('rewardHistoryToken');
    if (saved.rewardHistoryToken) return saved.rewardHistoryToken;
    const token = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, '0')).join('');
    await chrome.storage.local.set({ rewardHistoryToken: token }); return token;
  })();
}
async function historyRequest(path, body) {
  const response = await fetch(`http://localhost:3000${path}`, { method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${await historyToken()}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Savings history is unavailable.'); return data;
}

const finalizing = new Map();
function finalizeOrder(orderId, record) {
  if (finalizing.has(orderId)) return finalizing.get(orderId);
  const task = (async () => {
    const receipt = await historyRequest('/api/savings/finalize', { orderId, selectedFundingSource: record.selectedFundingSource, selectionEvidence: record.selectionEvidence });
    await chrome.storage.session.set({ [`checkout:${orderId}`]: { ...record, purchase: undefined, state: 'completed', receipt, savedAt: Date.now() }, lastRewardReceipt: receipt });
    chrome.runtime.sendMessage({ type: 'SAVINGS_UPDATED', receipt }).catch(() => {});
    return receipt;
  })().finally(() => finalizing.delete(orderId));
  finalizing.set(orderId, task); return task;
}
async function snapshotsFor(tabId) {
  // Refresh just the stateless extractor after extension updates, even on an
  // already-open checkout. Do not reinject event listeners or duplicate observers.
  await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ['extractor.js'] });
  const frames = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: () => location.protocol === 'chrome-extension:' ? null : globalThis.RewardExtractor?.extract(document, location) || globalThis.rewardSnapshot?.() || null });
  return frames.map(frame => frame.result).filter(Boolean);
}
function matchingDemo(snapshots, observed) {
  return snapshots.map(s => s.purchase).find(p => p?.source === 'demo-catalog' && p.amount &&
    (!observed.amount || p.amount === observed.amount) && (!observed.currency || p.currency === observed.currency));
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.type === 'GET_HISTORY_TOKEN') { historyToken().then(token => reply({ token })); return true; }
  if (message.type === 'GET_SAVINGS') {
    historyRequest('/api/savings/summary').then(totals => reply({ totals })).catch(() => reply({ unavailable: true })); return true;
  }
  if (message.type === 'FUNDING_OBSERVATION') {
    (async () => {
      if (!/^https:\/\/(www\.)?sandbox\.paypal\.com\//.test(sender.url || '') || !/^[A-Z0-9]{5,40}$/.test(message.orderId || '')) return reply({ ok: false });
      const key = `checkout:${message.orderId}`;
      const record = (await chrome.storage.session.get(key))[key];
      if (!record?.purchase || record.state !== 'active' || !message.selection) return reply({ ok: false });
      if (!record.baselineSelection) record.baselineSelection = message.selection;
      if (message.final) { record.selectedFundingSource = message.selection; record.selectionEvidence = 'checkout-pay-click'; }
      await chrome.storage.session.set({ [key]: record }); reply({ ok: true });
    })().catch(() => reply({ ok: false })); return true;
  }
  if (message.type === 'CHECKOUT_CONTEXT') {
    (async () => {
      if (sender.frameId !== 0 || !/^http:\/\/(localhost|127\.0\.0\.1):3000\//.test(sender.url || '') || !sender.tab?.id) return reply({ ok: false });
      const { orderId, state, purchase } = message.payment || {};
      if (!/^[A-Z0-9]{5,40}$/.test(orderId || '')) return reply({ ok: false });
      const key = `checkout:${orderId}`;
      if (state === 'active') {
        if (!purchase?.merchantName || !/^\d+\.\d{2}$/.test(purchase.amount || '') || purchase.currency !== 'USD' || !purchase.category) return reply({ ok: false });
        const existing = (await chrome.storage.session.get(key))[key];
        await chrome.storage.session.set({ [key]: { ...(existing?.state === 'active' ? existing : {}), state, originTabId: sender.tab.id, savedAt: Date.now(), purchase: {
          merchantName: purchase.merchantName, amount: purchase.amount, currency: purchase.currency, category: purchase.category, source: 'order-session',
          ...(purchase.country ? { country: purchase.country } : {}), ...(purchase.categoryBasis ? { categoryBasis: purchase.categoryBasis } : {}),
        } } });
      } else if (['completed', 'cancelled', 'changed', 'failed'].includes(state)) {
        const record = (await chrome.storage.session.get(key))[key];
        if (record && (record.originTabId === sender.tab.id || record.originTabId == null)) {
          await chrome.storage.session.set({ [key]: { ...record, purchase: undefined, state, originTabId: sender.tab.id, savedAt: Date.now() } });
          if (state === 'completed') {
            try {
              await finalizeOrder(orderId, record);
            } catch { chrome.runtime.sendMessage({ type: 'SAVINGS_UNAVAILABLE' }).catch(() => {}); }
          }
        }
      }
      // Wake any open panel after the session record has been saved/cleared.
      chrome.runtime.sendMessage({ type: 'PAGE_CHANGED' }).catch(() => {});
      reply({ ok: true });
    })().catch(() => reply({ ok: false }));
    return true;
  }
  if (message.type === 'CHECK_COMPLETION') {
    (async () => {
      if (!/^[A-Z0-9]{5,40}$/.test(message.orderId || '')) return reply({ ok: false });
      const record = (await chrome.storage.session.get(`checkout:${message.orderId}`))[`checkout:${message.orderId}`];
      if (!record) return reply({ ok: false });
      if (record.receipt) return reply({ receipt: record.receipt });
      const response = await fetch(`http://localhost:3000/api/checkout-context/${message.orderId}`, { signal: AbortSignal.timeout(5000) });
      const data = await response.json();
      if (response.ok && data.orderId === message.orderId && data.state === 'completed') return reply({ receipt: await finalizeOrder(message.orderId, record) });
      reply({ ok: true });
    })().catch(() => reply({ ok: false })); return true;
  }
  if (message.type !== 'SCAN_ACTIVE_TAB') return;
  (async () => {
    const tab = sender.tab?.id ? await chrome.tabs.get(sender.tab.id) : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
    if (!tab?.id) throw new Error('Open a sandbox checkout tab first.');
    const snapshots = await snapshotsFor(tab.id);
    if (!snapshots.length) throw new Error('Open PayPal sandbox or the localhost demo, then refresh the page after installing the extension.');
    const cards = new Map();
    for (const snapshot of snapshots) for (const card of snapshot.cards) cards.set(card.localCardId, card);
    const purchases = snapshots.map(s => s.purchase);
    let purchase = purchases.find(p => p.source === 'demo-catalog') || purchases.find(p => p.amount) || purchases[0];
    const orderId = snapshots.find(s => s.checkoutOrderId)?.checkoutOrderId;
    let baselineSelection = snapshots.find(s => s.selectedFundingSource)?.selectedFundingSource;
    let checkoutState = snapshots.find(s => s.checkoutState)?.checkoutState;
    if (orderId) {
      const key = `checkout:${orderId}`;
      let record = (await chrome.storage.session.get(key))[key];
      if (!record || record.state === 'active' || record.state === 'completed' && !record.receipt) {
        try {
          const response = await fetch(`http://localhost:3000/api/checkout-context/${encodeURIComponent(orderId)}`, { signal: AbortSignal.timeout(5000) });
          if (response.ok) {
            const recovered = await response.json();
            if (recovered.orderId === orderId && recovered.purchase?.amount &&
              (!purchase.amount || purchase.amount === recovered.purchase.amount) &&
              (!purchase.currency || purchase.currency === recovered.purchase.currency)) {
              record = { ...record, state: recovered.state, purchase: recovered.purchase, savedAt: Date.now(),
                originTabId: record?.originTabId ?? tab.openerTabId ?? null };
              await chrome.storage.session.set({ [key]: record });
              checkoutState = recovered.state;
            }
          }
        } catch { /* Session/opener context can still work when the backend is offline. */ }
      }
      checkoutState = record?.state || checkoutState;
      if (record?.state === 'completed' && !record.receipt) {
        try { await finalizeOrder(orderId, record); } catch { /* Retry next scan after a transient backend failure. */ }
      }
      baselineSelection = record?.baselineSelection || baselineSelection;
      if (record?.purchase && record.state === 'active' && baselineSelection && !record.baselineSelection) {
        record.baselineSelection = baselineSelection; await chrome.storage.session.set({ [key]: record });
      }
      if (record && Date.now() - record.savedAt < 2 * 60 * 60 * 1000 && record.state !== 'active') {
        purchase = { merchantName: '', amount: '', currency: 'USD', category: 'unknown', source: 'checkout-ended' };
      } else if (record?.purchase && Date.now() - record.savedAt < 2 * 60 * 60 * 1000 &&
        (!purchase.amount || purchase.amount === record.purchase.amount) &&
        (!purchase.currency || purchase.currency === record.purchase.currency)) purchase = record.purchase;
      else if (record) await chrome.storage.session.remove(key);
    }
    // Read the actual opener live; do not attach unrelated tab history to a checkout.
    if (!['demo-catalog', 'order-session', 'server-order', 'checkout-ended'].includes(purchase.source) && tab.openerTabId) {
      try {
        const opener = await chrome.tabs.get(tab.openerTabId);
        if (/^http:\/\/(localhost|127\.0\.0\.1):3000\//.test(opener.url || '')) {
          const demo = matchingDemo(await snapshotsFor(opener.id), purchase);
          if (demo) purchase = { ...demo, source: 'demo-checkout-opener' };
        }
      } catch { /* Context stays unknown when opener is inaccessible or mismatched. */ }
    }
    reply({ ok: true, snapshot: { tabId: tab.id, cards: [...cards.values()], purchase, orderId, baselineSelection,
      checkoutState,
      page: snapshots[0].page, note: snapshots[0].note } });
  })().catch(error => reply({ ok: false, error: error.message || 'Cannot inspect this page.' }));
  return true;
});
