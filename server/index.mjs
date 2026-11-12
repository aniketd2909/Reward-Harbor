import { createApp } from './app.mjs';
import { createPayPal } from './paypal.mjs';
import { createStore } from './store.mjs';
import { rewardService } from './rewards.mjs';
import { cardCatalogService } from './card-catalog.mjs';
import { createSavings } from './savings.mjs';
import { channel3Service } from './channel3.mjs';
import { storefrontService } from './storefront.mjs';

const clientId = process.env.PAYPAL_CLIENT_ID?.trim() || '';
const secret = process.env.PAYPAL_CLIENT_SECRET?.trim() || '';
const port = Number(process.env.PORT || 3000);
const configured = Boolean(clientId && secret);
const store = createStore('.local-data/checkout.json');
const savings = createSavings({ store, file: '.local-data/rewards.sqlite' });
const shopping = channel3Service({ apiKey: process.env.CHANNEL3_API_KEY?.trim() });
const storefront = storefrontService({ apiKey: process.env.CHANNEL3_API_KEY?.trim() });
const rewards = rewardService({ elasticUrl: process.env.ELASTIC_URL, apiKey: process.env.ELASTIC_API_KEY, index: process.env.ELASTIC_INDEX || 'reward-rules' });
const cards = cardCatalogService({ elasticUrl: process.env.ELASTIC_URL, apiKey: process.env.ELASTIC_API_KEY, index: process.env.ELASTIC_CARD_INDEX || 'card-catalog', savings });
const server = createApp({ clientId, configured,
  paypal: createPayPal({ clientId, secret }),
  store,
  purchaseResolver: storefront.resolvePurchase,
  recommendation: async (...args) => await storefront(...args) || await shopping(...args) || await savings.routes(...args) || await cards(...args) || await rewards(...args),
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Sandbox checkout: http://localhost:${port}`);
  console.log(configured ? 'Sandbox credentials configured.' : 'Add sandbox credentials to .env to enable payment.');
  console.log(process.env.CHANNEL3_API_KEY?.trim() ? 'Channel3 product offers configured.' : 'Channel3 key not configured.');
});
