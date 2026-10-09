# Sentiment Desk continuation board — 2026-10-09 (current)

| Owner | Scope | Status | Evidence / next |
|---|---|---|---|
| `/root` | Real SEC Recent Filings listing verification, cache reuse, and UI recovery | Listing workflow verified; filing inspection open | In the primary app, the repaired “Verify current listings” action stayed enabled through the SEC refresh cooldown. A real current Hub receipt was matched against both official Nasdaq Trader directories: **29 listed 8-K rows shown / 10 ambiguous or unlisted rows withheld**, with directory creation and retrieval clocks. The UI now exposes this action in `listing_unverified`; a current accepted receipt is reused without an additional SEC refresh. Inspecting the first row ended at **Retry SEC evidence**, so the full filing-detail/save/resume workflow is not claimed. No Luna call or product-synthetic record was used. Focused SEC/UI tests: **43/43**; full Vitest: **1,062/1,062**; typecheck, production build, and `git diff --check` pass. |
| `/root/whole_build_recheck_private_scope` | Independent current review of the full product | Current review: full product still fails | Final review: **4.5/10**, 12 pass, 17 unverified, 3 blocked, 1 fail. Criterion 22 remains unverified because first-filing inspection did not complete. The 33-index matrix keeps tickerless small-cap discovery, real Luna qualification, investor outcomes, AlphaSense comparison, saved SEC task recovery, and 4,700-row provider-usage reconciliation open. |
| `/root` | Explicit private-note consent | Scope recorded; live analysis unverified | User authorizes GPT-6 Luna analysis only after explicit selection and confirmation of the exact note and listed issuer. The note remains local by default. No real note or OpenAI credential was available for a model run. The authenticated TypeSafe model catalog returned Jev aliases only; no Jev fallback was used. Official OpenAI documentation confirms the `gpt-6-luna` model ID and API support, not this account's API access. |
| `/root` | Current live-data ETL and SEC receipt | **10/10 gate checks pass** | `live_data_etl_gate.py verify` passed at `2026-10-09T06:50:55Z`, bound to code fingerprint `e6c37e3ae6185be9a063cd312191a53aabcbbad7163bf478b9b51be352f0976e`. Includes fixture/failure/replay suites, offline request guards, storage, SEC inbox tests, current Hub receipt, Nasdaq replay, and isolated real-source Compose/restart smoke. The smoke used the dedicated `sentiment-desk-verify` Colima profile, public keyless sources only, and zero classifier requests. A separate direct run returned 27 quotes / 24 companies, 40 real chart points, a real Yahoo Finance RSS observation, HTTP 200 before and after recreation, and preserved observation/chart receipts. Current Hub SEC receipt: 39 rows, feed updated `2026-10-09T06:47:07Z`, retrieved `2026-10-09T06:47:07.933Z`. |
| `/root` | Reviewed GitHub checkpoint | Pushed and verified | SEC listing recovery source checkpoint `fb2abe99625a013fe7b7575a19f9f6ef95a54a16` is on `origin/codex/real-data-rebuild`; `git ls-remote` matches. The current code-bound 10/10 ETL PASS report and this verification update are being recorded with the existing workflow docs. |
| `/root` | Full Sentiment Desk acceptance | Open | Current whole-build review is FAIL: 12 pass, 17 unverified, 3 blocked, 1 fail (**4.5/10**). Missing evidence includes a real Luna output and rights-qualified benchmark, no-ticker small-cap discovery, the 30-task AlphaSense comparison, uncoached investor/analyst outcomes, completed SEC task and company-decision resume journeys, and reconciliation of 4,700 legacy-unknown rows. Private companies remain out of scope. Opportunity Radar remains disabled. The selected classifier in current project acceptance is GPT-6 Luna; no key or run is available in the active primary profile. |

The primary app was started over a task-created temporary SQLite database and
only the SEC 8-K and Nasdaq listing sources were enabled for the verification
run. Its existing 24-company sample and saved archive were not modified; no
classifier or unrelated source was enabled. The Desk server was stopped after
verification. The old `:5174` address has since been reused by another app and
must not be treated as the Sentiment Desk preview.

# Sentiment Desk continuation board — 2026-10-07

## Selected filing evidence usability — 2026-10-07

| Owner | Scope | Status | Evidence / next |
|---|---|---|---|
| `/root` | SEC filing detail, integration, verification, independent review, trace, and checkpoint | In progress | A selected real 8-K now has an explicit inline evidence path: exact issuer/accession metadata, dates and acceptance/retrieval clocks, bounded primary/exhibit excerpts, source links and digest. No list-render fetch, classifier call, or body persistence. Design and criteria: `project-record/4-log/2026-10-07-sec-filing-disclosure-usability.md`. Run native, live-rendered and independent whole-build verification; push only reviewed source. |
| `/root/sec_accession_metadata` | Exact accession submissions lookup and parsing regressions | Complete | One paced bounded metadata request; issuer CIK is checked independently from submitting/accession CIK; exact 8-K accession and safe primary-document path are validated. `tests/sec-accession.test.ts` and `tests/sec.test.ts`: 22 focused tests passed. |
| `/root` | Broader operational acceptance | Open | This slice does not close the missing current Hub receipt, live OpenAI Luna route/evaluation, tickerless issuer-universe discovery, completed company/followed-company analysis, legacy provider-usage reconciliation, or uncoached investor outcomes. No demo or synthetic runtime data; Opportunity Radar remains disabled. |

## Archive-search and no-ticker recovery — 2026-10-06

| Owner | Scope | Status | Evidence / next |
|---|---|---|---|
| `/root` | Search semantics, direct recovery route, rendered proof, integration, and checkpoint | Focused slice verified | `AI` substring false positives fixed; cursors restart safely on policy changes; repeated headlines stay in source order and disclose per-row match/freshness. Unsupported SEC inbox now opens all-company saved headline/excerpt search and clears stale filters. `CPU Business` produced four real retained records in two same-title groups. See `project-record/4-log/2026-10-06-saved-source-archive-search.md`. |
| `/root/final_usability_review_oct06` | Independent route and whole-product review | Complete | PASS for the scoped direct search recovery. Whole product remains FAIL: no current no-ticker candidate, no supported SEC Hub all-filers receipt, stale saved evidence, and no qualified Luna outcome. Reviewer recommends resolving data capability rather than adding another archive panel. |
| `/root` | Verification and delivery gates | In progress | Full Vitest **752/752 across 97 files**, typecheck, build, focused route tests and quality-loop replay pass. Live-data evidence is current; only `sec_filings_current_hub_receipt` fails. The SEC route remains unsupported by the connected Hub. Current alignment and engineering receipt are pending. |
| `/root` | Whole-product acceptance | Open | Still lacks current tickerless small-cap discovery, qualified Luna classifications, selected-company SEC facts in the actual runtime, followed-company materiality evidence, intended-user outcomes, and the 4,700-row legacy usage reconciliation. 390/320 px acceptance remains unverified. Opportunity Radar stays disabled. |

## Current usability and checkpoint status

| Owner | Scope | Status | Evidence / next |
|---|---|---|---|
| `/root` | Stock-selection usability, integration, verification, trace, GitHub checkpoint | In progress | Fixed both Desk auto-scroll after archive load and My Research ticker selection that previously left the queue visible. Rendered mobile-picker and desktop-watchlist transitions now show the selected issuer in Desk. See `project-record/4-log/2026-10-06-investor-navigation-usability.md`. Checkpoint will contain reviewed source only; local database and private evidence stay excluded. |
| `/root/post_fix_usability_review` | Independent full-build and post-fix navigation review | Complete | Confirmed route and scroll behavior are coherent in code and covered by native regressions; whole product still fails readiness because current Luna output, tickerless discovery, fundamental facts, user outcomes, and live receipts remain unavailable. Rendered proof was completed in the parent browser. |
| `/root/finance_data_diff_review` | Whole-candidate source and financial-data boundary review | Complete | No evidenced secret or restricted filing data in the reviewed candidate; remaining issues are product acceptance gaps. The new navigation change received a separate focused review. |
| `/root` | Current scoped operational evidence | Open | Fresh matching ETL evidence passes every declared check except `sec_filings_current_hub_receipt`; the shared Hub still has no supported current all-filers route. The latest source retrieval remains October 4. No model or source request was made in the rendered review. |
| `/root` | Reviewed GitHub checkpoint | Complete for this candidate | Source commit `350f79c92e453a2d1f0454aa3863140825f50b32` is pushed to `https://github.com/j-poc/sentiment-desk`, branch `codex/real-data-rebuild`; `git ls-remote` matched. Whole-product readiness remains open. |
| `/root` | Whole-product acceptance | Open | This focused usability fix does not deliver current Luna classifications, programmatic tickerless discovery, persisted SEC fundamentals, complete followed-company findings, legacy-unknown usage reconciliation, or observed intended-user outcomes. Opportunity Radar remains disabled. |

The user explicitly requested regular checkpoints to the existing GitHub
branch. The current destination is the existing `j-poc/sentiment-desk`
repository and the in-app UI remains available at `http://127.0.0.1:8787/`.

The UI at `http://127.0.0.1:8787/` is the built production client over the local
saved-data runtime. External source and classifier requests are disabled. No
synthetic or demo rows were added to the product database. ADBE selection and
its historical chart were freshly rendered: 17 saved rows are pending Luna;
the labeled Jev archive shows 51 records in 20 buckets and is seven days old.

## Historical owners and prior reviews — 2026-10-04

| Owner | Scope | Status | Evidence / next |
|---|---|---|---|
| `/root` | Acceptance alignment, integration, verification, records, GitHub checkpoint | In progress | Existing pushed checkpoints remain historical. Fresh alignment review passed for the staged v2 contract candidate; a clean-tree checkpoint is pending. Full product acceptance remains open. |
| `/root/pending_sse_implementation` | Persisted-observation stream and company count refresh in `server/pipeline.ts` | Complete | Integrated as `93c54d3` plus `e8fbac4`; focused regression covers persisted event, exact replay, insert rejection, multi-company snapshot coalescing, and stop cancellation. |
| `/root/whole_build_acceptance` | Fresh independent entire-product and investor-journey review | Complete | FAIL 4/10. Confirmed the fixed 24-company roster, missing no-ticker small-cap discovery, incomplete fundamental triage and followed-company baseline, no live Luna result, and no investor outcome evidence. No private database, provider call, or rendered browser proof. |
| `/root/discovery_feasibility` | Independent real-source feasibility review for discovery and company research | Complete | Existing SEC, RSS, GDELT, Yahoo, Reddit, and X paths do not establish a current product-managed small-cap universe or complete fundamental workflow. A source-backed universe requires verified market-cap semantics and endpoint rights; no providers or canonical DB were used. |
| `/root/full_build_detector` | Fresh read-only whole-build review | Complete | FAIL 4/10. Confirmed 24-company roster, zero Luna classifications, incomplete discovery/fundamental/followed-company workflows, and external operational gates; no edits or provider calls. |
| `/root/whole_build_review_current_ui` | Fresh read-only whole-build and live UI review | Complete | FAIL 4/10. In-app AAPL view rendered its historical Jev chart and saved-source feed; 245 scores/32 buckets, zero Luna categories, external/classifier requests paused, current price unavailable, and historical delivery lineage gaps remain. |
| `/root/advisor_next_iteration` | Independent GPT-6.1 Sol xhigh next-slice advice | Complete | Ranked a source-linked followed-company baseline first, then issuer/fundamentals foundation, then live Luna qualification when account inputs exist. Advised “new evidence,” not materiality, for pending rows. |
| `/root/fresh_contract_alignment_review` | Fresh independent acceptance alignment review | Complete | PASS contract alignment only: 19 criteria retained, all mapped. Product readiness FAIL; zero-ticker discovery, fundamental triage, followed baseline, live Luna and outcome evidence remain open. |
| `/root/whole_product_review_candidate` | Fresh read-only engineering_bullshit_detector review of the full product and current code candidate | Complete | FAIL about 4/10. The candidate baseline is a useful source-record workflow but does not establish materiality; zero-ticker discovery, fundamentals, live Luna, user outcomes and the current checkpoint remain open. No database, secrets, provider calls or edits. |
| `/root/gpt61_advisor_next` | Fresh GPT-6.1 Sol xhigh choice of next investor-value milestone | Complete | Recommended filing-backed fundamental evidence and company triage next, because it is reusable across later discovery and monitoring and does not require paid Luna. Requires qualified SEC route, exact fact lineage, deterministic period comparisons, actual saved data and honest gaps. |
| `/root/sentiment_desk_ui_review` | Independent first-run and UI review | Complete | Earlier source review rated the UI 7/10 and found the first-run next step hidden. The CTA was added in this candidate and directly exercised on the isolated empty preview. This is not a fresh overall 10/10 rating or intended-user evidence. |

## Historical prior acceptance (verified at 2026-10-04 03:26 UTC)

- Newly persisted identified observations emit the exact saved `mention` once
  before optional classification starts, including while classifiers are
  paused. Exact replay and rejected persistence emit no mention event.
- Source-count summaries coalesce a burst into one shared snapshot read;
  stopping clears delayed updates.
- Writable startup upgrades version-9 databases additively to version 11. An
  idempotent SQLite trigger binds each new GPT-6 Luna classification to the
  exact saved attempt ID, model, requested/actual tier, prompt/profile/schema
  digests, HTTP response, response identity, full token usage, cost, and
  latency. Historical rows remain readable, with unbound rows excluded from
  categorical trends.
- Temporary SQLite regressions include a true red reproduction with the guard
  absent, model/tier/receipt mismatch attempts, and an accepted matching raw
  insert. The canonical product database is not a fixture.
- Current verification passed `npm run typecheck`, the full suite (581 tests
  across 67 files), production build, secret scan, production dependency audit,
  and five of six declared live-data ETL checks. The attempt-bound v9-to-v11
  SQLite regression passed within the full suite. The keyless live Compose
  smoke failed before provider access because its named Docker context is
  missing; its existing Colima profile is stopped, and host free space is
  2.7 GiB, so starting a 32 GiB verification VM/build is deferred to protect
  the host. The code-bound ETL check therefore remains FAIL.
- The fresh whole-build review is FAIL 4/10. Full Desk completion remains
  gated by real Luna output/usage evidence, verified source/account terms,
  legacy provider reconciliation, a real product-managed small-cap discovery
  path, fundamental triage, followed-company material-change baselines, and
  observed investor/analyst outcomes. Opportunity Radar remains disabled.
- The pushed source checkpoint is a reviewed reliability/provenance milestone,
  not a full-product or release-ready claim.
- The staged contract strengthens the zero-input data requirements and makes
  both Git checkpoint checks fail on any dirty worktree. The fresh alignment
  review binds to the current contract/source hashes; the whole-build review
  still fails product readiness and is not a completion signal.
- Fresh alignment review confirmed the contract change preserves all 19
  acceptance items and maps each to valid checks; this is not a product pass.
  Fresh in-app browser inspection confirms the chart and feed render, while the
  saved view remains historical Jev only, with no Luna categories or current
  price and external collection/classification paused.

## Historical candidate acceptance (2026-10-04)

- Exact application-source candidate: HEAD `22a7b860dc97b7f72a1d37b2ad918a950aba911c` plus the 26 source/config/test paths listed by `git status`; content digest `4bd10d178d5c4c4380fc045dd8fca6b1762a16566086e98bc24513400f9665f1`. Project-record updates and GitHub readback are not yet included in this digest.
- The true-empty first-run response no longer includes an archived filing or Jev result. The UI states that no eligible evidence exists and offers a direct button to open/focus Sources & operations. Isolated browser inspection at port 54836 confirmed zero saved observations, no chart, no provider calls, and successful CTA expansion. This proves the empty-state path only.
- New classification configuration defaults to OpenAI GPT-6 Luna and explicitly rejects `CLASSIFICATION_PROVIDER=typesafe`; production startup and pipeline dispatch use the bounded OpenAI path only. The old TypeSafe key fallback was removed. Existing genuine Jev history remains readable. No classifier request was made and no new Luna result exists.
- Followed-company comparison now captures an explicit, append-only baseline of exact identified-source observation IDs that have matching immutable delivery receipts and terminal successful/partial ingestion. Reads use bounded stable pages and distinguish late-arriving and late-finalized rows. The panel says “new source evidence” and explicitly does not judge materiality or price impact. The 50,000-observation cap, idempotency, conflicts, recovery, pagination, and persistence are covered by isolated database/API/component tests; no real-data baseline was captured or rendered.
- Health storage values below 1 GiB now display MB, with regression coverage.
- Verification: full suite **589 tests across 70 files passed** (`npm test -- --reporter=dot --maxWorkers=1 --testTimeout=20000`); `npm run typecheck`, `npm run build`, and `git diff --check` passed; `npm audit --omit=dev --audit-level=high` reported zero vulnerabilities; Gitleaks found no leaks in the scanned 11.32 MB and skipped ignored `data/desk.db` (97 MB), which is excluded from the candidate. The full suite prints two teardown warnings where test pipelines outlive their temporary database; these did not fail tests.
- The fresh whole-product engineering review is **FAIL about 4/10**. The 24-company universe is still a fixed large-cap roster; no-ticker small-cap discovery and filing-backed fundamentals are absent; baseline data is not interpreted as materiality; real Luna output, endpoint/account evidence, legacy-usage reconciliation, AlphaSense comparison and uncoached investor/analyst results remain unavailable.
- `live_data_etl_gate.py check` is **FAIL** because prior evidence is stale for this code/configuration and the authorized keyless Compose smoke has no current passing result. `engineering_gate.py check` reports a missing evidence receipt. No full verify was run: declared commands include private evaluation/outcome artifacts and a live Compose smoke, whose inputs/side effects are not verified for this candidate. No OpenAI, Jev, or source-provider request was made in this iteration.
- Read-only inspection of the actual saved-data UI showed stock selection update the selected company and its historical Jev chart/feed (AMD: 29 score buckets); current price and Luna classifications remain unavailable. The isolated empty preview is separate and contains no synthetic observations. Opportunity Radar remains disabled.
- GitHub checkpoint: `https://github.com/j-poc/sentiment-desk`, branch `codex/real-data-rebuild`, commit `646579ba4e0c7e00906adc6b61c7a0e2f9edf266`. GitHub visibility was confirmed as PUBLIC; it was not changed and no license was added. `git ls-remote` matched the local commit and the worktree was clean after push. Do not label this checkpoint a complete Desk, 10/10 result, or release-ready build.
