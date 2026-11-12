import { readFile } from 'node:fs/promises';
import { sandboxCardMappings } from './sandbox-card-mappings.mjs';
import { bestCardForPurchase } from './best-card.mjs';

export function cardCatalogService({ elasticUrl = '', apiKey = '', index = 'card-catalog', fetchImpl = fetch, savings } = {}) {
  if (elasticUrl && (!apiKey || new URL(elasticUrl).protocol !== 'https:' || !/^[a-z0-9_-]+$/.test(index))) throw new Error('Configure an HTTPS Elastic endpoint, API key, and valid card index.');
  return async function route(req, res, url, readBody, send) {
    const isBestCard = req.method === 'POST' && url.pathname === '/api/best-card';
    if (!isBestCard && (req.method !== 'GET' || !['/api/issuer-cards', '/api/sandbox-card-mappings'].includes(url.pathname))) return false;
    const input = isBestCard ? await readBody(req) : null;
    const productId = url.searchParams.get('productId');
    const network = url.searchParams.get('network');
    const category = url.searchParams.get('category');
    let cards, dataSource = 'local-issuer-sources', fallbackReason;
    async function localCards() {
      try { return JSON.parse(await readFile(new URL('../data/issuer-cards.json', import.meta.url), 'utf8')).cards; }
      catch { throw Object.assign(new Error('Sourced card catalog is unavailable. Run npm run scrape:cards.'), { status: 503 }); }
    }
    if (elasticUrl) {
      try {
      const filters = [{ term: { country: 'US' } }];
      if (productId) filters.push({ term: { productId } });
      if (network) filters.push({ term: { network } });
      if (category) filters.push({ nested: { path: 'rewards', query: { terms: { 'rewards.category': ['*', category] } } } });
      const response = await fetchImpl(`${elasticUrl.replace(/\/$/, '')}/${index}/_search`, {
        method: 'POST', signal: AbortSignal.timeout(10000),
        headers: { 'Content-Type': 'application/json', Authorization: `ApiKey ${apiKey}` },
        body: JSON.stringify({ size: 50, query: { bool: { filter: filters } } }),
      });
      if (!response.ok) throw Object.assign(new Error('Elastic card catalog is unavailable.'), { status: 503 });
      cards = (await response.json()).hits?.hits?.map(hit => hit._source) || [];
      dataSource = 'elastic-card-catalog';
      } catch {
        cards = await localCards();
        fallbackReason = 'Elastic is unavailable; using the last local issuer snapshot.';
      }
    } else {
      cards = await localCards();
    }
    if (isBestCard) {
      const result = { ...bestCardForPurchase(input, cards), dataSource, ...(fallbackReason ? { fallbackReason } : {}) };
      if (input.orderId && savings) savings.recordQuote(req, input, result);
      send(200, result);
      return true;
    }
    if (url.pathname === '/api/sandbox-card-mappings') {
      send(200, { dataSource, ...(fallbackReason ? { fallbackReason } : {}), mappings: sandboxCardMappings.map(mapping => ({
        ...mapping, profile: cards.find(card => card.productId === mapping.productId) || null,
      })), note: 'Temporary sandbox assumptions, not verified card identities. Real issuer profiles are separate from the synthetic calculator.' });
      return true;
    }
    cards = cards.filter(card => (!productId || card.productId === productId) && (!network || card.network === network))
      .map(card => ({ ...card, rewards: category ? card.rewards.filter(rule => rule.category === '*' || rule.category === category) : card.rewards }))
      .filter(card => card.rewards.length);
    send(200, { dataSource, ...(fallbackReason ? { fallbackReason } : {}), cards,
      note: 'Sourced summaries, not payment recommendations. Exact product confirmation, full terms review, and PayPal eligibility are required.' });
    return true;
  };
}
