# SEC filing inspection and research task — 2026-10-09

## Scope and setup

This was a targeted real-source check of the Recent Filings route and the
filing-to-My Research handoff. The app ran against a temporary SQLite database
and a scoped company inventory; the user's main database was not opened or
changed. Public SEC filing data and official Nasdaq issuer directories were
used. OpenAI and Jev dispatch were disabled, with zero model requests and no
private note supplied.

## Observed workflow

- “Verify current listings” loaded the saved current-revision SEC 8-K receipt:
  39 raw receipt rows, 29 uniquely verified as exchange-listed, and 10
  ambiguous or unlisted rows withheld. The receipt's feed update time was
  `2026-10-09T06:47:07.000Z`; receipt retrieval time was
  `2026-10-09T06:47:07.933Z`. The independent directory response was retrieved
  at `2026-10-09T06:54:51Z` / `06:54:52Z`; its source generation time was
  `2026-10-09T01:31Z`.
- In the rendered filing list, inspection opened Trinity Capital Inc., CIK
  `0001786108`, accession `0001193125-26-418097`. The UI showed the official
  SEC archive URL, filing date `2026-10-08`, acceptance time
  `2026-10-09T01:30:13Z`, report period as a report period (not an event date),
  Items `7.01` and `9.01`, bounded primary filing text, retrieval metadata,
  and a SHA-256 digest.
- Saving an analyst research question created one My Research task bound to
  that exact CIK and accession, source receipt, question, and separate feed
  and retrieval clocks. After restarting the app against the same isolated
  database, My Research still showed the task. A readback from
  `GET /api/sec-filing-research-tasks` returned the same identity and clocks.
- No classification or account request was made. The UI's item-specific Luna
  confirmation remains required for private evidence; this check did not send
  private content anywhere. Exact-task resume after the accession rolls out of
  the current inbox was not exercised.

## Defect and retained regression

The live SEC submissions JSON returned issuer `cik` as a zero-padded string,
while the parser accepted only a JSON number. That caused inspection to reject
the exact current filing. `server/sources/sec.ts` now accepts only a safe
positive JSON number or a 1–10 digit numeric string, normalizes it, and still
requires exact equality with the requested CIK. `tests/sec-accession.test.ts`
retains the observed Trinity response shape and checks that malformed strings
remain rejected.

## Verification

- Focused SEC tests: 17/17 passed.
- Full Vitest suite: 123 files, 1,064 tests passed. One evaluator negative test
  emitted its expected refusal-to-overwrite diagnostic; it did not change the
  zero-exit suite result or qualify a Luna model.
- `npm run typecheck`, `npm run build`, and `git diff --check`: passed. Vite
  continues to report the existing >500 kB client-chunk advisory.
- Project recovery verifier: PASS, run
  `04e3e5a9-d6bb-4b10-a7da-5e821d13313f`; it uses verifier-only fixtures and
  makes no provider request.
- Live-data ETL verifier: PASS, 10/10 checks, run at
  `2026-10-09T07:05:00Z`. Its isolated real-source smoke persisted only
  temporary records and kept classifiers disabled. Google/Yahoo RSS and
  Yahoo quotes/charts succeeded. GDELT returned HTTP 429 and was surfaced as
  rate-limited; the smoke still met its documented source-coverage criteria.
  Current Nasdaq directory, SEC inbox protocol, replay, and failure checks
  passed.

## Private-note consent clarity

An independent finance reviewer found that a confirmation naming only issuer
and note title could not distinguish two same-titled notes. The API already
bound the analysis request to the selected note ID, but the confirmation gave
the user too little context to verify that binding. The panel now gives each
note-list button a distinct accessible name and displays issuer, title, source
label, optional user-asserted date, note ID, a SHA-256 prefix, and a sanitized
180-code-point preview before external-processing confirmation. The preview
collapses whitespace and replaces bidi/control characters. The mocked
regression selects the second of two same-titled notes and verifies only its
exact ID is sent; cancellation continues to make no analysis request.

- Private API/UI regressions: 14/14 passed; typecheck and production build
  passed; full-suite result is recorded in the current engineering receipt.
- No real user note or GPT-6 Luna request was used. Real private-note utility,
  account retention settings, and live model response remain unverified.

## Acceptance status

Independent whole-build review: **FAIL, 5.4/10** after incorporating the
fresh ETL receipt; 15 pass, 14 unverified, 3 blocked, 1 fail. The rendered
filing inbox and saved task close criteria 22 and 28. The refreshed live-data
receipt resolves criterion 13's stale-evidence concern. No-ticker small-cap
discovery remains a product-scope failure. A rolled-out filing task resume,
real Luna output and qualification, rights-qualified finance benchmark,
30-task AlphaSense study, intended-investor outcomes, and 4,700-row provider
usage reconciliation remain unverified or blocked. Opportunity Radar remains
disabled. Review the current `.engineering-evidence/alignment-review.json` for
the fresh one-to-one acceptance matrix and verdict.

## Final verification refresh — 2026-10-09 07:18 UTC

The final live-data ETL run passed **10/10 checks** at `2026-10-09T07:18:02Z`
with code fingerprint
`3ae3279d10481834fa32f6f90835bf1bafef26ca9967d0e1f26c9f88f7bc2345`. The
authorized keyless live smoke, storage-capacity check, current SEC Hub receipt,
Nasdaq directory replay, and recovery checks all passed. Jev and GPT-6 Luna
remained disabled; the smoke made no classifier request.

- The current full Vitest suite passed **123 files / 1,065 tests**. The SEC,
  private-note API/UI, and item-specific Luna consent focus passed **31/31**.
- The targeted project recovery verifier passed as run
  `41c8c5bb-3ebb-457a-95b3-07932f994b1a`; its evidence binds current product
  fingerprint `63e178de92f29233576db3032b4cbc984a7161dcaa9995b2829a0073972abfb4`
  and confirms owned-process and temporary-data cleanup. Its private-analysis
  adapter is a verifier fixture, not a real model result.
- The skill helper TypeScript check, repository typecheck, production build,
  and `git diff --check` passed. Vite still emits its existing large-client-
  chunk advisory.
- The retained `investor-ui-recovery` regression replay passed **26/26**.
  The regression covers the no-ticker filing recovery interaction, not the
  missing issuer-universe discovery workflow.
- An independent whole-build review still finds **FAIL, 5.4/10** with 15
  PASS, 14 UNVERIFIED, 3 BLOCKED, and 1 FAIL; request coverage is PASS. The
  exact-item consent ambiguity is resolved at the UI/test boundary, but live
  analysis of a real private note remains unverified.

No real private note or GPT-6 Luna request was used. The full build remains
open: tickerless small-cap discovery, a real-source Luna run and finance
benchmark, paired AlphaSense comparison, intended-user outcomes, and the
4,700-row provider-usage reconciliation are unresolved. Exact-task resume after
filing rollover and complete rendered focus/width proof also remain unverified.
Opportunity Radar stays disabled. These checks do not qualify the product for
release or close the active build goal.

## Real-source research case and restart recheck — 2026-10-09

The new research-only case path was exercised on a fresh isolated server at
`127.0.0.1:8798`, backed by `/tmp/sd-sec-case-live/desk.db`; the normal user
server and database were left running and untouched. The case came from the
current SEC filing inbox, not a fixture:

- Trinity Capital Inc. (`TRIN`), CIK `0001786108`, 8-K accession
  `0001193125-26-418097`, was in the current saved SEC feed and matched a
  current Nasdaq Trader listing receipt. Ten unmatched/ambiguous filings were
  withheld from the visible 29 rows.
- The live SEC ticker directory verified the issuer identity. Its receipt URL,
  retrieval time, digest, and full source identity are attached to the case.
  The live CompanyFacts snapshot retained 36 fact rows and the brief selected
  21 facts. Only operating cash flow was supported among the four requested
  metric groups; revenue, operating income, and net income remain unavailable.
  Five same-period comparisons were available, but CompanyFacts omitted
  reported decimal precision on the stored rows, so the UI labels differences
  as arithmetic only and does not claim an underlying change.
- The UI rendered the real case and a saved `insufficient_evidence`
  disposition. That disposition was written by the test operator solely to
  exercise persistence; it is not a user investment conclusion. After stopping
  and restarting the isolated server against the same database, the verified
  identity, partial snapshot (`f3299773-56a3-463c-898e-dd504a0c6a25`),
  decision (`946e1622-2bba-44c0-9b26-49b68a2a7835`), and 21-fact manifest were
  read back unchanged. The case was then closed and opened twice from the
  filing row; both rendered successfully.
- The finance reviewer spot-checked the operating-cash-flow fact against the
  official [SEC 10-Q statement](https://www.sec.gov/Archives/edgar/data/1786108/000119312526333907/trin-20260630.htm)
  and [filing index](https://www.sec.gov/Archives/edgar/data/1786108/000119312526333907/0001193125-26-333907-index.htm): issuer, accession,
  2026 H1 and 2025 H1 periods, USD-thousands source unit, values, and the
  arithmetic difference match. This is one fact spot-check, not a full audit
  of all 36 rows.
- The normal user-facing server at `127.0.0.1:8797` still reports zero eligible
  saved observations. Its UI correctly shows no sample chart or neutral score,
  states that Luna is paused because `OPENAI_API_KEY` is missing, and explains
  that saved data is not being replaced by archived or demonstration results.
  The workspace `.env` search found only example files; the authorized APIII
  file contains no non-placeholder OpenAI key. No public-source item or private
  note was sent to Luna, and no Luna request was made.
- The user has confirmed private data may be analyzed by GPT-6 Luna only after
  an explicit action naming the selected item and issuer. The existing UI/API
  consent boundary remains item-specific and the private-company boundary
  remains excluded. No private note was used in this real-source check.

The schema-version assertions now expect v17 for the additive SEC case
migration, and the future-version fixture uses v18 and verifies the database
remains at v18 after downgrade refusal. The final full suite passed **126 files
/ 1,079 tests**. `npm run typecheck`, `npm run build`, the verification-skill
TypeScript check, and the focused project recovery verifier passed; its current
run is `7c0a6ce0-33ee-4812-9784-97feebbbec42`, with cleanup PASS. The rendered
8798 case was reopened in the current browser and still showed the verified
issuer, real facts and source caveats, exact saved decision, and 21-fact
manifest. The regular 8797 Desk still has zero eligible sentiment records and
truthfully reports the missing OpenAI key; it shows no chart score in place of
real Luna output. The ETL receipt was stale when this review was first recorded;
the fresh receipt and verifier rerun are recorded below.

Independent whole-product reviews agree the result is still **not ready**.
The engineering reviewer scored coverage 3/10, source correctness 6/10,
benchmark advantage 1/10, operations/privacy 5/10, and workflow/UI 6/10. The
finance reviewer scored the full product 5.5/10 and this narrow case path 8/10,
with an official-source spot-check of its operating-cash-flow comparison.
These reviews treat the case as a useful, accurate partial research slice; they
do not establish tickerless small-cap discovery, broad public-signal coverage,
followed-company material change, Luna quality, benchmark superiority,
investor outcomes, or overall release readiness. The full build remains open.

## Whole-product re-review — 2026-10-09

An independent engineering reviewer re-opened the current 8798 case and 8797
operational health after the final suite. The TRIN case continued to show its
verified issuer, 36-row real SEC facts snapshot, 21 referenced fact IDs,
qualified comparisons, and persisted test-operator disposition. The Open action
remained functional. The normal Desk still reports zero eligible observations,
Luna blocked because `OPENAI_API_KEY` is missing, and Radar disabled.

The reviewer rated the whole product **FAIL**: coverage **3/10**, correctness
**6/10**, benchmarked value **1/10**, operations/privacy **5/10**, workflow/UI
**6/10**. Its 33-item alignment matrix recorded **14 pass, 15 unverified, 3
blocked, and 1 fail**. The principal unresolved outcomes are live Luna and
real-source quality evidence, no-ticker small-cap discovery, followed-company
material-change workflow, AlphaSense paired comparison, intended-investor
sessions, and 4,700-row legacy-provider usage reconciliation. A current ETL
receipt and GitHub push can update their corresponding operational criteria but
cannot clear these product-outcome blockers.

## Fresh verifier and live-data evidence — 2026-10-09 08:16 UTC

The project recovery verifier was rerun after the SEC research-case change and
passed as run `dd994f53-5d9e-48da-b4d5-9f1a6cea975c` (started
`2026-10-09T08:10:00.542Z`, completed `2026-10-09T08:10:01.693Z`). The product
fingerprint is `d6e5c5c312e7cae63192d0e04365def9a8bb60b4d4690fafa7007304b6130999`;
the verifier fingerprint is
`95bd40043f384ae2f2b67beea127d70d7801c7ce015bf33a83b61497fca18cc8`;
cleanup passed and removed only its owned server and temporary data.

The live-data ETL receipt passed all **10/10 checks** at
`2026-10-09T08:16:58Z`, against code fingerprint
`8bc12e5498e99d5b41b8b6e01e382254d4e17a6186fffdbe31dad523c07d5bbf`.
The keyless, isolated public-source smoke and recovery completed; the run did
not call Jev or GPT-6 Luna. The receipt is current for its declared source
adapters and criterion 13's previous stale-evidence finding can be reassessed.
It does not demonstrate sentiment classifications, tickerless discovery,
followed-company material change, or whole-product readiness. The desk at 8797
continues to show no synthetic or demo observations while the OpenAI key is
unavailable.

The previously retained `investor-ui-recovery` regression was replayed against
the current UI and relevant test sources: **2 test files / 26 tests passed**.
The full current test suite reports **126 files / 1,079 tests passed**;
typecheck, production build, secret scan, and focused project verifier also
passed. These checks verify the current candidate's implementation and do not
replace the missing live-model, comparative-benchmark, or intended-user
outcomes.
