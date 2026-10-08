# Live SEC refresh and scoped readiness — 2026-10-08

## Scope correction

The user clarified that private data does not need to be integrated. Private
files, proprietary customer data, and private-company access remain outside the
build. The separate narrative-context record is documentation only; it does not
enable a source, account, upload, model call, or private-data workflow. This
does not waive market-price context or other live-data requirements.

## Live-source verification

The configured local Public Data Hub was stopped. Its existing installation
already had four enabled, free public profiles (ECB FX, U.S. Treasury yields,
World Bank indicator, and SEC latest 8-K), so the existing service was started
without adding a source or changing account settings. The health endpoint
returned `ok`. The Desk then read 40 rows from the current SEC 8-K receipt
(latest read at 2026-10-08 15:50 UTC):

- feed observation: `2026-10-08T15:45:54.000Z`
- local retrieval: `2026-10-08T15:45:54.404Z`
- source verifier made no provider call; it checked the saved Hub receipt.

`live_data_etl_gate.py verify` passed at `2026-10-08T15:50:38Z`. All nine
required checks passed, including the isolated keyless live Compose smoke,
failure recovery, the current Hub receipt, and retained-volume recovery. The
smoke observed 27 real quotes across 24 configured companies and 41 chart
points. The isolated verification container was stopped after the check; the
configured local Hub remains available to the Desk.

## Product readiness remains open

The live SEC fix resolves the stopped-Hub check only. Whole-build independent
reviews still find the core product unready: no-ticker small-cap discovery is
not supported by the fixed 24-company setup; no current real Luna classification
run or paired AlphaSense result exists; the 4,700 `legacy_unknown` records remain
quarantined but unreconciled to provider/account usage records; intended-user
task outcomes and a rendered end-to-end UI review are missing. The isolated
live quote/chart smoke does not prove that the full product UI presents a
current selected-company chart or a useful investor decision.

A first engineering-bullshit-detector review of this candidate scored the
weighted rubric **3.75/10** (confidence 7/10) and returned **FAIL**. Its
read-only local database inspection found zero saved Luna classifications and
zero followed-company baselines; 4,700 legacy rows remain quarantined; 383
CompanyFacts rows cover Apple only; and saved Yahoo price points stop at
October 6. It confirmed the SEC receipt and isolated quote/chart smoke, but did
not inspect a rendered UI or run a model/provider request. These local counts
and source-only review do not establish investor task completion.

No private data, synthetic product data, Jev classifier request, or Luna model
request was used in this refresh.

## Resume-flow usability repair

An independent investor UI review rated the saved-filing resume slice 6/10
before follow-up. It found that keyboard focus was not moved from My Research
to the exact resumed filing action, and that a saved question was only visible
in My Research when its filing was still present in the SEC inbox. The inbox now
shows the saved question beside that filing and focuses the exact “Inspect in
Desk” action after resume. The focused regression suite passes at 5 files and
31 tests; it checks visible question context and stable focus-target IDs. A
mounted React/browser journey and actual focus behavior remain unverified.

The repository suite passed on the same candidate with the controlled
single-worker run: 113 files and 923 tests. The unbounded parallel Vitest
attempt had earlier stopped at 389 passing tests with a worker callback
timeout; it is not the passing verification record.

## Whole-build acceptance review

A second independent engineering-bullshit-detector review of this candidate
scored the weighted rubric **4.35/10** (confidence 6/10) and returned **FAIL**.
The reviewer found the current 40-row SEC receipt, filing-task storage and
resume path, receipt-qualified followed-company baselines, and tickerless Saved
Sources/Recent Filings entry points. These remain partial: the feed is unranked,
the configured universe is fixed at 24 companies, and the product does not
establish small-cap status or research-worthiness. The reviewer also found no
integrated fundamental driver/counterevidence brief or actual material-change
judgment, zero evidenced saved baselines, no real Luna outputs, no paired
AlphaSense result, and 4,700 quarantined `legacy_unknown` rows without usage
reconciliation. No 5-investor/5-analyst task study or rendered end-to-end
inspection was available. The new focus target and question context are
statically present, but actual keyboard focus and the mounted UI journey remain
unverified. This review was read-only: no browser session, provider call, or
canonical database inspection was performed. Private data remains out of scope.
