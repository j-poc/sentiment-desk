# Source approval and Jev account-use runtime gate — 2026-09-29

Trace ID: `TRACE-20260929-source-approval-runtime-gate`

## Request and acceptance

Continue the Sentiment Desk build, fix actionable gaps, keep live observations
real and source-attributed, preserve Jev as the per-item sentiment/event
classifier, and do not send provider or Jev requests while source rights,
account authority, or budget approvals remain unknown.

## Findings and changes

- A collector could previously start from the global request switch and
  `EXTERNAL_SOURCE_COLLECTORS` alone. The project records said that exact
  source-use permissions were unresolved, leaving those terms as operator
  comments rather than an independent runtime boundary.
- Collection and quote/chart fetches now require the collector in both
  `EXTERNAL_SOURCE_COLLECTORS` and `SOURCE_RIGHTS_APPROVED_COLLECTORS`, in
  addition to `EXTERNAL_REQUESTS_ENABLED=true` and source credentials where
  applicable. The approval set defaults empty.
- Jev requires `TYPESAFE_ACCOUNT_USE_APPROVED=true` in addition to a key,
  positive bounded daily request/byte budgets, and intersection of
  `TYPESAFE_ALLOWED_COLLECTORS`, `EXTERNAL_SOURCE_COLLECTORS`, and
  `SOURCE_RIGHTS_APPROVED_COLLECTORS`. The account-use flag defaults false.
- Health API and Desk Health panel report requested/approved/blocked source
  flags and Jev account-use state. Both the panel and coverage disclosure say
  these values are operator attestations, not verified rights or account
  authority.
- Rechecked the independent RSS-coverage finding against the current branch:
  the existing coverage disclosure and regression test already named the
  one-response bound and unknown completeness. Tightened the user-facing copy
  to say coverage may be incomplete when feeds provide no pagination or
  completeness signal.
- The credential-free live Compose smoke no longer self-approves its five
  public endpoints. It requires the operator to provide the exact approval set
  before it can issue live requests.
- `README.md` and `.env.example` describe the distinct gates. Existing
  source/account rights remain blocked; the flags do not clear them.

## Current official-source recheck

The [SEC EDGAR access guidance](https://www.sec.gov/search-filings/edgar-search-assistance/accessing-edgar-data)
requires a descriptive contact-bearing User-Agent and states a 10-request per
second limit; the product still lacks the contact value. The [TypeSafe MCA](https://typesafe.ai/legal/mca)
requires authority to bind the customer and rights in inputs, permits broad
telemetry use, charges credits per submitted input, and restricts use of
Services or Output to develop a similar or competing product. The account's
accepted Order, authority, telemetry/retention, limits/refill, exact product
scope, and rejected-request billing remain unverified.

The current [Finnhub Terms](https://finnhub.io/terms-of-service) restrict listed
plans to personal use unless stated otherwise, require written approval for
business use of personal plans and sharing data or derived results, and
require data deletion when a subscription ends. [Reddit Data API Terms](https://redditinc.com/policies/data-api-terms)
limit the User Content license to the app-use context, require a separate
agreement for commercial or other unpermitted uses, restrict model training
without rightsholder permission, and impose deletion on termination. The [X
Developer Policy](https://docs.x.com/developer-terms/policy) restricts content
redistribution and requires removal of content that becomes unavailable. The
project-specific plan, model-processing, display, retention, and deletion
permissions remain unresolved for these feeds. These observations are not a
legal determination.

## Data and side-effect boundary

No provider, SEC, market-data, Reddit, X, Finnhub, or Jev request was sent for
this checkpoint. The offline-startup verifier intercepted external fetches
before network access. No application database, credential value, or saved
source text was read or changed for this implementation. No demo or synthetic
product data was added.

## Verification

- `npm test -- --reporter=dot` — **PASS**, 212 tests across 28 files.
- `npm run typecheck` — **PASS**.
- `npm run verify:offline-startup` — **PASS**; production build succeeded,
  default-off startup attempted zero requests, all nine individually guarded
  source paths required both source lists, a missing source approval made zero
  requests, and Jev remained disabled without account approval or a matching
  source intersection. The fully configured Jev case only checked health; it
  had no pending item and made no model request.
- `git diff --check`, `sh -n scripts/verify-live-compose.sh`, and JSON parsing
  of `live-data-etl.json` — **PASS**.
- Browser readback at `http://127.0.0.1:8796/` confirmed the global-off,
  saved-data-only state, the wrapped source-approval and Jev account-use rows,
  and the explicit no-data chart state on an isolated empty SQLite database.
  No provider or Jev request was sent. This verifies the default health UI;
  the saved-data browser verification of company selection and sentiment/price
  chart is recorded at the top of `sentiment-desk-completion.md`.
- The production build retains its existing Vite chunk-size advisory.

## Remaining gates

This is a local enforcement and disclosure checkpoint, not live operation,
10/10, or release readiness. The source-use flags remain empty in normal
configuration. Still required: a valid SEC User-Agent contact; actual
source-specific permissions; authorized TypeSafe account-owner evidence and
approved request/spend limits; at least two independent qualified reviewers
for frozen blinded real-source labels and a passing Jev evaluation; and
historical `legacy_unknown` request/payload/billing reconciliation from
account/provider records. Coverage remains explicitly finite and incomplete.
Opportunity Radar is unchanged and remains downstream of Sentiment Desk
operational readiness.
