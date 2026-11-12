# Official issuer card datasource

`issuer-cards.json` contains four US consumer card profiles and selected advertised
reward summaries extracted from public official issuer pages. `issuer-cards.bulk.ndjson`
contains the same documents in Elasticsearch bulk format, using stable product IDs.

| Product ID | Card | Official source |
| --- | --- | --- |
| `us-amex-gold` | American Express Gold | https://www.americanexpress.com/us/credit-cards/card/gold-card/ |
| `us-amex-platinum` | American Express Platinum | https://www.americanexpress.com/us/credit-cards/card/platinum/ |
| `us-amex-blue-cash-preferred` | Blue Cash Preferred | https://www.americanexpress.com/us/credit-cards/card/blue-cash-preferred/ |
| `us-chase-freedom-unlimited` | Chase Freedom Unlimited (Visa) | https://creditcards.chase.com/cash-back-credit-cards/freedom/unlimited |

Visa is a network; rewards belong to an issuer product. These profiles are not
automatically assigned to the sandbox cards. The user must confirm the product.

## Refresh and import

```sh
npm run scrape:cards
```

This uses installed Chrome in a temporary profile, reads the four public pages,
and checks known rate/cap patterns. It neither logs in nor bypasses challenges.
When a page fails or a pattern changes, it reports failure in
`artifacts/card-scrape-report.json` and leaves the last complete dataset intact.

The parser is a small set of issuer-specific extraction recipes, not a general
credit-card crawler. Rates are captured and checked against expected values;
category/channel/cap summaries are curated from the linked source. Changed terms
require human review of both the source and the recipe. The Gold base rate was
not exposed by this browser scrape, so its profile contains only the four
successfully extracted bonus sections rather than guessing a missing rate.

Configure the local `.env`:

```dotenv
ELASTIC_URL=https://your-elasticsearch-endpoint
ELASTIC_API_KEY=your_encoded_api_key
ELASTIC_CARD_INDEX=card-catalog
```

```sh
npm run seed:cards
```

The seeder creates or updates the mapping in `elastic/card-catalog.mapping.json`,
then uploads the NDJSON. Stable IDs make repeated imports replace those profiles.
The configured Elastic deployment has been populated with four card documents.
Document count and Amex Gold grocery retrieval were verified through the catalog service.
This uses a separate index from `npm run seed:elastic`, which still seeds only
synthetic calculator fixtures. Never load these nested profiles into the flat
demo `reward-rules` index.

Restart the backend after configuration/code changes, then query:

```text
GET /api/issuer-cards
GET /api/issuer-cards?network=Amex
GET /api/issuer-cards?productId=us-amex-gold&category=grocery
```

Without Elastic, these routes read the local sourced JSON. With Elastic configured,
they search the card catalog. Connection/search failures use the local snapshot
and report `dataSource: local-issuer-sources` plus a `fallbackReason`.

`GET /api/sandbox-card-mappings` resolves temporary mappings from
`server/sandbox-card-mappings.mjs`: Amex 2402 to Gold, and Visa 6302 to Chase Freedom
Unlimited. The extension shows these assumptions and their sourced reward summaries.
They do not establish the sandbox cards' real products. The panel now sends
visible cards and purchase context to `POST /api/best-card` for automatic selection.

## Meaning and limits

- `demo: false` means sourced issuer advertising, not a fictional reward rule.
- `reviewStatus: advertised_summary_only` means full rewards-agreement review is pending.
- `rateType: total` means a category rate replaces the base; it is not an additive bonus.
- `points_per_usd` is distinct from `cashback_percent`. There is no assumed point valuation.
- `paypalEligibility: unknown` means the scrape did not establish PayPal eligibility.
- `retrievedAt` and `sourceHash` record provenance, not a guarantee of continued validity.
- Absence of a rule does not establish a zero reward; this is a selected-benefits catalog.
- Caps, geographic restrictions, prepaid requirements, and booking channels are preserved.
- Personalized offers, welcome bonuses, statement credits, and annual-fee valuations are excluded.

The extension's active `POST /api/best-card` flow uses these profiles and returns
one best estimated card. It uses total-rate handling, booking-channel/prepaid
filters, and an explicit sandbox assumption of 1¢ per Membership Rewards point.
It assumes unused capped allowance and marks PayPal eligibility unverified.
Individual allowance tracking, full terms review, and guaranteed issuer eligibility
remain outside this prototype. The legacy synthetic calculator is not used by the panel.
