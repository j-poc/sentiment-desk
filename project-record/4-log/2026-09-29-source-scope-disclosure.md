# Collector scope disclosure and local source inventory — 2026-09-29

Trace ID: `TRACE-20260929-source-scope-disclosure`

## Request and acceptance

Continue the Sentiment Desk build with real data only. Review adjacent source-
coverage weaknesses and make the current feed boundaries visible before a
researcher treats selected observations as representative. Do not add sources,
send provider or Jev requests, or expand Opportunity Radar for this slice.

Acceptance: enumerate all real external collector IDs and their current bounds;
surface RSS's unknown completeness and known uncovered source families in the
Desk; preserve an explicit rights caveat; verify the rendered disclosure,
company selection, and saved-data chart; checkpoint the result.

## Finding and change

The local inventory covered nine allowlisted external collector IDs:

| Collector | Role and configured bound | Material coverage limit |
| --- | --- | --- |
| `google_news_rss` | Name/ticker RSS search, English-US, two days; one response per company | No pagination or provider-completeness signal |
| `yahoo_finance_rss` | Headline RSS response for each configured ticker | One response per company; no pagination or provider-completeness signal; exact endpoint rights unresolved |
| `gdelt_doc_api` | English article metadata, descending, two days, up to 250 results | No pagination; reaching 250 is recorded as partial; linked-publisher rights unresolved |
| `sec_edgar` | Recent 8-K and 8-K/A filings accepted within three days | Requires contact-bearing `SEC_USER_AGENT`; only a narrow EDGAR rights path is reviewed |
| `finnhub` | Optional company-news feed over a three-day request window; separate earnings/calendar paths | Credentials and plan-specific storage, display, and model rights are unverified |
| `reddit` | Optional one-week, link-post search, 25-item pages | One page/company/poll with persisted cursor; optional and plan rights remain unverified |
| `x` | Optional English recent-search terms, bounded to seven days | Persisted page chain; optional and storage/display/model rights remain unverified |
| `yahoo_quote` | Price quote context | Not sentiment evidence; exact endpoint rights unresolved |
| `yahoo_chart` | Timestamped price-series context | Not sentiment evidence; exact endpoint rights unresolved |

The source page already said configured feeds do not cover the full public web.
However, it did not explain that each RSS collector consumes one response with
no completeness signal, nor identify the direct source families absent from
the build. The Desk now has a collapsed, keyboard-operable **Collection scope
and gaps** disclosure. It names response bounds, separates price-only
collectors from sentiment sources, states that direct company/product pages,
press releases, presentations, job posts, app-store reviews, search trends,
YouTube/podcasts, and broad customer-support discussions are not collected,
and says RSS/syndicated mentions do not provide systematic coverage. It also
states that source access alone does not establish rights to retain, display,
or send content to Jev.

No new data source or live request was added. Jev remains disabled in the saved-
data preview; all product records remain source-backed. Synthetic fixtures
remain isolated to tests.

## Verification

- `npm test -- --reporter=dot` — **PASS**, 209 tests across 27 files.
- `npm run typecheck` — **PASS**.
- `npm run verify:offline-startup` — **PASS**. Production web/server build
  succeeded; default startup kept all sources and Jev paused, manual retry
  returned 503, and no fetch was attempted. Nine separate allowlist probes
  activated only their own request paths behind a pre-network fetch guard; the
  Jev/source mismatch remained disabled. The existing Vite 535.29 kB main
  chunk advisory remains.
- `git diff --check` and `python3 -m json.tool project-record/3-project-specs/live-data-etl.json`
  — **PASS**.
- Production UI preview at `http://127.0.0.1:8795/` — **PASS** over a separate
  SQLite backup of `data/desk.db` at
  `/private/tmp/sentiment-desk-preview.fBtbSM/desk.db`; global provider opt-in,
  collector allowlists, Jev key, and Jev budgets were all empty/off. The API
  returned 24 companies and health confirmed `externalRequestsEnabled=false`
  with every collector and Jev disabled. The UI showed **SAVED DATA ONLY** and
  **APP CONNECTED**. Clicking the Adobe ticker selected Adobe, changed the
  heading and feed to 68 saved mentions, and rendered its sentiment/price chart
  from the local store (`source 14h ago`). Pressing Enter on the scope summary
  expanded the full coverage details. No provider or Jev request was sent.
- A read-only aggregate of the isolated preview database found 4,349 Google
  News, 581 Yahoo Finance RSS, 2,876 Finnhub, and 3 SEC observations; zero
  `demo_simulation`; and 4,700 `legacy_unknown`. The app quarantines the latter
  from research views; their unknown provenance is not proof they are real and
  their historical Jev-use/billing lineage remains unaudited. The original
  `data/desk.db` was not used by the preview server or modified.

## Gate state

The local source inventory is complete for the nine current external collector
IDs. The overall `source_coverage` gate stays **PARTIAL**: optional collectors
are not enabled or rights-cleared, GDELT may be rate-limited or capped, RSS
does not report completeness, and the desk does not collect the broader public
source families above. The user-facing disclosure prevents those gaps from
being mistaken for broad convergence evidence; it does not make collection
exhaustive.

The wider Sentiment Desk goal remains incomplete. Open gates still include
account-owner confirmation of TypeSafe terms and request/cost limits, the SEC
contact, source-specific non-SEC rights, independent blinded real-source Jev
labels and evaluation, and provider usage/billing reconciliation for the
legacy-unknown records. Opportunity Radar stays downstream until the Sentiment
Desk acceptance gates pass.
