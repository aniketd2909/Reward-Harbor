# Reward Harbor — Task tracker

Baseline: extension 0.9.5, reviewed 2026-11-12. Source of requirements: [SPEC.md](SPEC.md).

Checked items describe implemented code. They do not imply a fresh authenticated PayPal test. Unchecked items are proposed remaining work; production deployment is not part of the current sandbox MVP.

## Implemented

- [x] MVP-01 — Build Channel3 storefront with departments, search, product images, offers and quantity selection. Server owns fresh checkout prices. FR-01–02.
- [x] MVP-02 — Integrate sandbox order creation, session ownership, verified capture and retry recovery. FR-03.
- [x] MVP-03 — Extract visible cards, exclude bank accounts, and apply the two explicit sandbox mappings. FR-04.
- [x] MVP-04 — Preserve exact-order context through popup focus; recover context from the server when the bridge/opener is missing. FR-05.
- [x] MVP-05 — Scrape official issuer summaries and generate four sourced profiles; use Elastic first and local catalog as fallback. FR-06.
- [x] MVP-06 — Rank applicable rewards, handle points/cashback, caps and booking restrictions, and retain unquantified cases. FR-06.
- [x] MVP-07 — Show the best estimated card, collapsed alternatives, expandable benefits and issuer source links. FR-07.
- [x] MVP-08 — Replace the side panel with a compact floating advisor and toolbar toggle; auto-open on checkout and detect login transitions. FR-08.
- [x] MVP-09 — Add compact idle/completed states, green savings totals and automatic window height. Remove manual purchase correction controls.
- [x] MVP-10 — Track baseline and observed paid selection; persist quote snapshots and verified savings in SQLite. FR-10.
- [x] MVP-11 — Add closable extension savings receipt and store payment-success dialog without capture IDs. FR-09–10.
- [x] MVP-12 — Poll confirmed payment state to recover missed completion notifications and retry finalization safely. FR-09.
- [x] MVP-13 — Handle invalidated extension contexts without uncaught errors. FR-11.
- [x] MVP-14 — Add unit and browser regression coverage, including first-login route transition and respecting dismissal.

## P0 — Validate the complete sandbox demo

### QA-01 — First-login and returning-login checkout

- [ ] Load the actual unpacked extension, refresh the store, sign out of sandbox, then complete first login from checkout.
- [ ] Repeat with an existing authenticated sandbox session.
- [ ] Confirm the advisor opens automatically once, displays both mapped cards, and does not reopen repeatedly after closing it.
- [ ] Confirm the floating window fits narrow PayPal popups and does not prevent access to funding choices or Pay.

Done when: both login paths pass with observed screenshots/logs that omit credentials and private session data. Related: FR-04, FR-08.

### QA-02 — Verified payment and savings end to end

- [ ] For a known baseline, choose a mapped card and complete a sandbox payment.
- [ ] Verify the chosen card, transaction estimate, cumulative total and one SQLite transaction agree.
- [ ] Confirm the savings dialog is visible after the PayPal popup closes; dismiss it and verify the minimal header state.
- [ ] Repeat finalization/reload to confirm the total is not counted twice.
- [ ] Exercise unknown selection and baseline; verify no numeric savings are invented.

Done when: verified capture and persisted receipt reconcile for known and unknown cases. Related: FR-03, FR-09–10.

### QA-03 — Category and recovery scenarios

- [ ] Compare grocery and drugstore purchases and verify the appropriate reward rules select the best card.
- [ ] Test cancellation, a changed purchase, a second order, capture retry and backend restart.
- [ ] Test Elastic outage and confirm local fallback returns sourced estimates with API provenance.
- [ ] Verify no previous order's merchant, amount or completion state leaks into a new checkout.

Done when: automated checks plus recorded manual outcomes cover these scenarios. Related: FR-02, FR-05–06, FR-09.

## P1 — Improve MVP reliability and maintenance

### REL-01 — Test the actual extension iframe integration

- [ ] Add an unpacked-extension browser harness where the Chrome version permits it.
- [ ] Verify real runtime messages, iframe sender/tab association, web-accessible resources, resize messages and PayPal frame restrictions.
- [ ] Test full redirects, same-document navigation, refreshed checkout and restored pages.

Done when: real extension APIs supplement the existing mocked Chrome regression suite. Depends on QA-01.

### DATA-01 — Review issuer data and freshness

- [ ] Review full issuer terms for current rates, eligible merchants, PayPal restrictions and cap periods.
- [ ] Define a refresh schedule and stale-source policy; retain source timestamps and review status.
- [ ] Keep unsupported eligibility unquantified or explicitly conditional.

Done when: each supported rule has a reviewed source, applicable conditions and a refresh policy. Related: FR-06.

### DOC-01 — Reconcile setup documentation

- [ ] Replace remaining old README instructions about manual mappings, side panels and correction fields.
- [ ] Add a reproducible demo checklist and current floating-advisor screenshots.
- [ ] Document local data backup/reset and installation-history behavior without publishing secrets.

Done when: a new developer can run the current MVP using only the README and this spec.

### UX-01 — Usability and accessibility pass

- [ ] Verify keyboard navigation, focus after closing dialogs, screen reader labels and text scaling.
- [ ] Check the best card remains easy to find at narrow widths and 200% zoom.
- [ ] Evaluate launcher placement/dragging to reduce obstruction of PayPal controls.

Done when: supported checkout layouts remain usable with mouse and keyboard; no payment control is permanently obscured.

## P2 — Future product scope; requires design before implementation

- [ ] NEXT-01 — Replace sandbox assumptions with explicit user-confirmed issuer/product mappings, including account switching and suffix collisions. Do not infer tier from a masked number.
- [ ] NEXT-02 — Design merchant adapters for other websites: purchase context, lifecycle events, supported permissions and verification of completion.
- [ ] NEXT-03 — Replace local-only order-context capability and installation identity with a deployment-appropriate authorization and ownership model.
- [ ] NEXT-04 — Move the single-process journal to transactional shared storage before multi-instance hosting.
- [ ] NEXT-05 — Design refunds, reversals, settled reward reconciliation and historical estimate corrections.
- [ ] NEXT-06 — Define optional user accounts, retention, deletion/export and cross-device history.
- [ ] NEXT-07 — Define a separate live-payment rollout and validation process before enabling production PayPal.

## Definition of done

For each code task: meet its acceptance criteria, run relevant checks, keep credentials out of artifacts, update the spec when behavior changes, and distinguish simulated/estimated results from verified payment state. A checkbox for implementation does not replace the P0 manual release gates.
