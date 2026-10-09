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
