# Reward Harbor

Current project documents: [Specification](docs/SPEC.md) · [Task tracker](docs/TASKS.md).

A Channel3-powered e-commerce demo with PayPal sandbox checkout and a Chrome
extension for comparing sourced card rewards and tracking estimated savings.
No live PayPal endpoints are used.

## Start the checkout

Requires Node.js 22+.

```sh
npm install
cp -n .env.example .env
npm run dev
```

Open **http://localhost:3000**, browse departments or search, and select **View & pay**.
The product dialog shows fresh merchant offers, quantity, total, and the PayPal
button. Set `CHANNEL3_API_KEY` in `.env` for live catalog access. To enable PayPal:

1. Open [PayPal Apps & Credentials](https://developer.paypal.com/dashboard/applications/sandbox).
2. Select/create a sandbox REST app associated with a sandbox business account.
3. Put its `PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET` in `.env`; restart the server.
4. Sign in at checkout with a different sandbox personal buyer account.
5. Open the funding-source selector to display available cards.

Keep `.env` private. Do not share secrets, cookies, or browser profiles.

The server owns prices, binds orders to an HTTP-only session, persists retry IDs,
and verifies capture amount/currency/status before marking a purchase paid. A lost
capture response is reconciled against the order. Use “Check payment again” after
capture errors. Pending or mismatched captures are not reported as paid.

Ignored `.local-data/checkout.json` persists orders and sessions across restarts.
It is a single-process demo journal, not a multi-instance production database.

## Install the extension

1. Keep the backend running on port **3000**.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked**, selecting this project's `extension/` directory.
4. Pin **Reward Harbor · Sandbox Advisor** in the toolbar.
5. Refresh sandbox pages after installing or reloading the extension.
6. Open the PayPal funding-source list, click the icon, then **Refresh page**.
7. The panel automatically uses the sandbox mappings, highlights the best estimated
   card, and lists the remaining cards with purchase estimates and expandable benefits.
8. Purchase context is read from checkout and its actual localhost opener. Use
   **Correct purchase details** only when automatic context is incomplete.
9. Select the card and approve payment in PayPal yourself.

Sandbox Wallet pages are also supported for inspection. The parser reads visible
labels, not private APIs. Authenticated Wallet inspection detected Amex ending
2402 and Visa ending 6302 using the extension extractor. Actual checkout compatibility requires an authenticated
sandbox test. It cannot enumerate cards that the page does not expose.

Mappings stay in `chrome.storage.local`. **Clear mappings when switching sandbox
accounts.** Network + suffix can collide; distinct Wallet page references are used
when available. Identical checkout labels without references cannot reliably be
distinguished. Unsupported networks need a product added to the demo catalog.

The demo checkout publishes purchase context once an order is created. The extension
keeps it in `chrome.storage.session`, keyed by the PayPal order ID. Popups recover
that order's context even without an opener link. Completion, cancellation, failure,
or purchase changes remove the purchase fields; a small ended-state marker prevents
stale reuse. Records older than two hours are rejected, and session storage clears
when Chrome restarts. No user profile or payment credentials are stored there.
If the bridge or opener is missing, the extension recovers minimal purchase fields
from `GET /api/checkout-context/:orderId` using the exact opaque sandbox order token.
This local-only endpoint returns no cookies, credentials, or account details and
rejects unknown or expired orders. It is not a production customer authentication
scheme. The scanner refreshes its stateless extractor on existing tabs.
The popup scanner also reads its actual localhost opener when available and when
the visible amount/currency matches. It does not borrow context from unrelated tabs. Unknown
bank labels are excluded. The active recommendation flow uses sourced profiles
for Amex 2402 → Gold and Visa 6302 → Freedom Unlimited, with Elastic primary and
local snapshot fallback. Membership Rewards points use an explicit 1¢ valuation;
unused bonus allowance and PayPal eligibility are assumptions, not guarantees.

## Elastic and rewards

An official issuer datasource is now available separately from the synthetic
calculator: [dataset and import instructions](data/README.md). It includes Amex
Gold, Platinum, Blue Cash Preferred, and Chase Freedom Unlimited, with 16 sourced
reward summaries. Refresh with `npm run scrape:cards`, import with
`npm run seed:cards`, and query `GET /api/issuer-cards` after restarting the backend.
These profiles preserve points, caps, and channel restrictions. The extension
uses `POST /api/best-card` to select a single estimated winner from sourced profiles.
It treats rates as total rates and excludes portal/prepaid bonuses when the
purchase does not establish the required booking conditions. The older synthetic
comparison endpoint remains for development tests and is not used by the panel.

Without Elastic, the active flow falls back to the sourced local issuer snapshot.
The old `server/rewards.mjs` synthetic calculator is retained for development only.

To use Elastic, set these variables in `.env`:

```dotenv
ELASTIC_URL=https://your-elasticsearch-endpoint
ELASTIC_API_KEY=your_encoded_api_key
ELASTIC_CARD_INDEX=card-catalog
```

```sh
npm run seed:cards
npm run dev
```

The seed command loads sourced issuer summaries and requires index creation/mapping/write
privileges. Runtime needs read privileges; use separate keys where possible.
Elastic failures use the labeled local fallback. The configured deployment has
four card profiles, with live catalog lookup verified.

Real reward rules need full terms, caps, merchant classification, and PayPal
eligibility review. The active flow uses total rates and an explicit 1¢ point-value
assumption. Credits, complex stacking, personalized ingestion, and hosting remain future work.

## API and verification

### Channel3 product offers

The [Channel3 API skill](.agents/skills/channel3-api/SKILL.md) is installed locally.
The backend uses the official `@channel3/sdk` with `CHANNEL3_API_KEY` from `.env`.
The key is never included in `/api/config`, extension files, or product responses.

Channel3 is used by the main storefront, not the extension. The store starts with
eight live finds across Pantry & coffee, Food & treats, Beauty & wellness, and
Home & tech. Department tabs and search fetch current products. Product selection
opens an offer/quantity dialog and PayPal sandbox button. The extension stays focused
on card rewards, recommendations, and savings. Reload it to version 0.7.0.

Each department carries an explicitly simulated rewards category for testing:
grocery, dining, drugstores, or other. This is not an issuer merchant-category lookup.
For example, retail chocolate does not inherently qualify as restaurant dining,
and skincare does not establish a drugstore merchant. All payments go to our demo
merchant; catalog retailers receive no order and no goods are shipped.

```dotenv
CHANNEL3_API_KEY=your_channel3_key
```

Server routes:

- `GET /api/storefront/products?department=all` (optional `q` search)
- `POST /api/storefront/quote` with product ID, department, quantity, and optional offer domain
- `POST /api/shopping/search` with `{ "query": "whole bean coffee", "limit": 3 }`
- `GET /api/shopping/products/:productId` to refresh a known product

Search uses the US/USD locale and retrieves full details for each displayed result
before returning offer prices, stock, and links. Stale search offers are not used
if refresh fails. Requests have bounded limits/timeouts; upstream errors are
sanitized. Only search IDs are cached. Server-owned checkout quotes expire after
15 minutes; price and availability are rechecked before a PayPal order is created.
Changed prices require a new quote. Completed order/receipt snapshots remain in
the payment and savings ledgers. Offer prices may exclude shipping/tax; the sandbox
does not add shipping or tax. Variant conditions should be checked at the merchant.

Live API authentication, search, and one product refresh were verified. Tests use
a mocked SDK for deterministic freshness/error checks and extension UI verification.

### Payment savings history

Version 0.5 adds a SQLite ledger at `.local-data/rewards.sqlite`. The database
stores quote snapshots, merchant/category/amount/currency, verified capture/order
IDs and timestamps, recommended product, observed selected card (masked suffix),
initial funding selection, estimated rewards, and incremental estimated savings.
It does not store PayPal passwords or full card numbers.

The extension creates a private random history token in local extension storage;
the database stores its hash. History is scoped to this browser installation,
not an authenticated PayPal user or cross-device account. Removing extension data
loses access to that installation's history. SQLite uses Node 22's built-in
experimental `node:sqlite` module. The database is ignored by Git.

Savings mean **selected-card estimated rewards minus the first observed funding
selection's estimated rewards**. A bank account is assumed to earn no card rewards.
Points retain the existing 1¢ comparison assumption. Negative differences are
preserved. No discount or issuer-confirmed cashback is claimed.

The backend saves a recommendation snapshot against the server-owned demo order.
On the Pay button click, the extension observes the selected funding source. After
our backend verifies capture, the extension requests finalization. Unique capture
and owner/order constraints prevent duplicate totals on retries. Uncompleted orders
cannot enter the ledger. Missing card/baseline evidence remains unknown and is
excluded from savings totals, rather than substituted with the recommended card.

After finalization, the extension displays this payment's estimated savings and
cumulative savings only in the extension side panel. No savings banner is injected
into the merchant page. Completed checkouts suppress the live card-selection prompt.
History survives server/browser restarts. Only this demo merchant's verified
payments are supported. Actual issuer reward settlement and refunds are not
reconciled, and paid-card selection is browser-observed, not PayPal-verified.

New endpoints (private installation bearer token required):

- `GET /api/savings/summary`
- `POST /api/savings/finalize`

The best-card endpoint records a quote when supplied a known `orderId` and token.
Reload the extension, refresh the store, and begin a new payment to enable tracking.

| Route | Purpose |
| --- | --- |
| `GET /api/health` | Local status |
| `GET /api/config` | Public client ID, setup state, and demo catalog |
| `POST /api/paypal/orders` | Create/reuse an order from `{sku, quantity}` |
| `POST /api/paypal/orders/:orderId/capture` | Capture/reconcile a session-owned order |
| `GET /api/card-products` | Demo card catalog |
| `POST /api/recommendations` | Rank mapped cards |

Payment requests require this checkout's Origin and JSON. The backend binds to
`127.0.0.1`. Payment secrets remain on the server; the extension only calls reward APIs.

```sh
npm test
npm run test:browser
```

Browser checks use installed Google Chrome in a fresh temporary profile. They
cover the local checkout, rendered card fixtures, and panel UI with simulated
Chrome APIs. PayPal SDK/provider calls are mocked for approval/cancellation tests.
They do not verify a real payment or actual extension installation. Screenshots
are saved to ignored `artifacts/`.

## Existing sandbox inspector

```sh
PLAYWRIGHT_CHANNEL=chrome npm run inspect:sandbox
```

Sign in locally in the separate browser, open Wallet/a card, then press Enter in
the terminal. The inspector saves brands and masked suffixes to
`artifacts/sandbox-cards.json`. Its `.sandbox-browser` profile retains login state;
keep it private. Without `PLAYWRIGHT_CHANNEL`, install Playwright Chromium first
with `npx playwright install chromium`.

## References

- [Development plan](docs/DEVELOPMENT_PLAN.md)
- [PayPal checkout](https://developer.paypal.com/checkout/integrate)
- [PayPal SDK setup](https://developer.paypal.com/sdk/js/set-up/)
- [Chrome side panel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)
- [Elastic search](https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-search)

### Payment confirmations (extension 0.8.0)
The independent navy/violet advisor displays a closable savings dialog after a verified sandbox capture. It also checks the last observed order every 2.5 seconds while the panel is open, so closing the PayPal popup or missing the merchant completion event does not leave stale recommendations. Finalization is idempotent, preserves observed paid-card evidence for retries, and keeps unquantifiable savings explicit. Closing the dialog keeps the savings summary visible. The storefront shows its own small payment-success dialog without reward estimates.

The current integration supports PayPal sandbox and the local demo checkout. The extension design is independent of the storefront; arbitrary live merchants still need supported purchase context and verified completion integration.

### Floating advisor (0.9.0)
The advisor now opens automatically as an isolated floating window on PayPal sandbox checkout. Use the round purple launcher to close/reopen it, or the Chrome toolbar action to toggle it. After verified payment, it opens on the demo store to keep the savings receipt visible after the PayPal popup closes. Savings totals use green text. Reload the extension and refresh the store after updating; the side-panel entry has been removed.

### Render host and HTTPS origin
The server uses `PUBLIC_ORIGIN`, falling back to Render's `RENDER_EXTERNAL_URL`, to allow the exact deployed host and HTTPS checkout origin. Set `PUBLIC_ORIGIN=https://reward-harbor.onrender.com` explicitly if the automatic URL is unavailable. HTTPS checkout session cookies include `Secure`. Localhost remains supported for development. Extension 0.10.0 includes this deployed origin and defaults its API to Render; local checkout records retain their local backend. Keep `.local-data` on a persistent disk to preserve payment and savings records.


### Test the hosted extension (0.10.0)
1. Reload the unpacked extension at `chrome://extensions` and allow its updated site access.
2. Refresh https://reward-harbor.onrender.com and close old PayPal popups.
3. Select a product, click PayPal, and sign in with a sandbox buyer account.
4. Verify the advisor opens, reads the current purchase and compares the two mapped cards.
5. Choose the card in PayPal and complete payment; verify the store confirmation and extension savings receipt.
6. Close the receipt and check that the advisor becomes compact. Repeat a payment to check cumulative totals.

The public endpoint allowlist is in `extension/config.js`. No API keys are embedded in it. Local and hosted histories are separate databases; the extension associates each observed order with its originating backend.

### Render persistence and runtime
SQLite does not need a separate database service or manual schema creation: the app creates the database and tables at startup. It **does** need persistent storage on Render.

- Use a paid web service with a persistent disk mounted at `/opt/render/project/src/.local-data`. Leave `DATA_DIR` unset or set it to `.local-data`.
- Alternatively mount a disk at `/var/data` and set `DATA_DIR=/var/data`.
- Both `checkout.json` and `rewards.sqlite`, including SQLite sidecars, must stay inside that disk. Keep a single application instance.
- Build: `npm ci`. Start: `npm start`. Health check: `/api/health`.
- The package pins Node 22.14+ within the 22.x line for its native `node:sqlite` API. Remove conflicting Render `NODE_VERSION` overrides or set a compatible 22.x version.
- Set the existing PayPal sandbox, Channel3 and Elastic environment variables in Render, plus `PUBLIC_ORIGIN=https://reward-harbor.onrender.com`.
- Local savings are not transferred automatically. Adding a new empty disk or changing `DATA_DIR` starts with empty history unless existing data is migrated safely.

The deployed smoke check can be run without initiating payment:

```sh
STOREFRONT_URL=https://reward-harbor.onrender.com node scripts/check-live-storefront.mjs
```

Persistent disks are not available on Render's free web service tier. Without one, file-backed history can be lost on restart/redeploy. The public demo remains sandbox-only; live merchant/payment verification and production account authorization are separate future work.
