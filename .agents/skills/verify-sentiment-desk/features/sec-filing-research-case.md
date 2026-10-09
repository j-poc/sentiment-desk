# SEC filing research case

A case starts from one real filing in Recent Filings after current Nasdaq Trader
listing verification. It is a separate, source-bound research workspace; opening
it does not add the issuer to the watchlist, sentiment collection, private-note
workflow, or Opportunity Radar. The 8-K inbox is bounded source browsing, not a
complete issuer universe, small-cap screen, or investment ranking.

## Acceptance

- The filing row identifies issuer, CIK, accession, exchange/listing receipt,
  and SEC source URL. Missing filing or acceptance clocks stay explicitly
  unavailable; feed refresh time is not a filing time.
- The case binds the filing accession, verified SEC issuer identity receipt,
  current listing receipt, and its own fundamentals snapshot. It retains
  incomplete CompanyFacts coverage, period/unit/precision limits, and supported
  sources for every displayed comparison. An arithmetic difference is not
  described as an underlying change, cause, materiality, or sentiment.
- Saving a research disposition creates a new version bound to the selected
  case and exact fact manifest. Closing and reopening the case resumes the same
  source snapshot and decision history. Test-operator writes on isolated data
  must be identified as test actions, not attributed to the user.
- Failure, ambiguous identity, missing metrics, and missing source precision
  remain visible and do not turn into a company match or positive/negative
  judgment. The case does not create a public sentiment observation.

## Checks

- Run `npm test -- --run tests/sec-filing-research-cases-api.test.ts tests/sec-filing-research-case-panel.test.tsx tests/sec-filing-case-inbox-ui.test.tsx` for API persistence/binding, rendered case states, and inbox entry behavior.
- Inspect the rendered Recent Filings row, open the case, inspect citations and
  caveats, close and reopen, and verify its case ID, fact-snapshot ID, selected
  fact IDs, and latest decision through read-only API calls. Do this only in an
  isolated database with real public-source inputs; never seed demo filings or
  alter the user's database.
- The 2026-10-09 real-source run is recorded in
  `project-record/4-log/2026-10-09-sec-filings-rendered-inspection.md`. It used
  Trinity Capital Inc. (`TRIN`), CIK `0001786108`, 8-K accession
  `0001193125-26-418097`, an official SEC identity receipt, a current Nasdaq
  listing receipt, and a real CompanyFacts snapshot. An independent finance
  review checked one operating-cash-flow comparison against the official SEC
  10-Q. This spot-check does not validate every CompanyFacts row or broader
  research completeness.
- Keep the saved outcome scoped to “does this issuer merit more research?”
  and preserve unsupported drivers as unknown. No sentiment label, small-cap
  claim, private-company coverage, or investment recommendation is inferred.
