# Sentiment Desk goal resumption audit — 2026-10-01

Trace ID: `TRACE-20261001-goal-resumption-audit`

## Request and goal state

The user asked Codex to update the Ultragoal if needed, then continue. The
existing objective still matches the product acceptance contract, so it was
left unchanged. `get_goal` returned status `blocked` for thread
`01a0d521-e46b-7061-8bc6-3dc5ec5c994f`. The available goal controls expose no
resume-to-active operation. This turn continued under the user's direct
request, but automatic continuation after this turn is not established.

The current Git branch is `codex/real-data-rebuild` at
`786b19720ea0a28df6272cc65c530389eb6accfd`; `git ls-remote` returned the same
SHA for `origin/codex/real-data-rebuild`. The earlier `b4238bb...` value was
stale and is corrected here.

## Saved-data evaluation capacity

The default local database is `data/desk.db`, last modified
`2026-09-28T20:47:59+0300`, SHA-256
`31cf091e29f5fdab9eca5852ff82776bc8e40c9c0fd93f76e74c6d993374e798`. It is
runtime data and is not committed. The database quick check returned `ok`.
A read-only aggregate over `companies` and `source_observations` found 24
registered issuers and 7,809 identified observations: Google News RSS 4,349,
Finnhub 2,876, Yahoo Finance RSS 581, and SEC EDGAR 3 from 1 issuer. None of
those 7,809 observations has a stored `delivery_id`. The database also has
4,700 `legacy_unknown` observations, which remain quarantined.

The frozen Jev evaluation is SEC EDGAR scoped and requires at least 30 issuer
clusters. The saved database has only 3 SEC observations from 1 issuer, and the
company registry has 24 issuers total. Across the 7,809 identified
observations, no row has a persisted `delivery_id`. The saved SEC rows would
still need their evaluator-required filing provenance checked; they do not
provide the required 30-issuer cohort. The prior keyless Compose smoke used
and deleted its own temporary database; it did not create an evaluation
cohort or call Jev. No product database was changed during this audit, and no
synthetic application data was added.

Reproduce the database counts without reading observation text:

```sql
PRAGMA query_only=ON;
PRAGMA quick_check;
SELECT count(*) FROM companies;
SELECT collector, count(*), count(DISTINCT company_id),
       sum(CASE WHEN delivery_id IS NOT NULL THEN 1 ELSE 0 END)
FROM source_observations GROUP BY collector ORDER BY count(*) DESC;
SELECT count(*) FROM source_observations WHERE collector='legacy_unknown';
```

## Acceptance status and next action

The prior live-data ETL receipt passed its five declared checks at
`2026-10-01T09:15:58Z`, before this trace update. It proves only the scoped
fixture, recovery, replay, offline-gate, and disposable keyless-source smoke
paths; it does not prove Jev quality or general live operation. A fresh
`verify` and `check` are required after these record edits.

The whole-product goal remains unverified. The user explicitly authorized
TypeSafe use for Sentiment Desk and stated that balance should remain. That
clears the user's permission to use Jev, but not the account-specific accepted
Order, refill threshold and amount, actual balance, applicable limits,
telemetry/retention terms, rejected-request billing, or a numeric spend ceiling.
The user also attested to rights for the public sources and APIs. Exact
source-specific collection, display, retention, and model-processing terms
remain open outside the narrow SEC filing path.

### Bounded real SEC-to-Jev smoke — 2026-10-01

After the permission update, a fresh app process used a separate temporary
SQLite database at `/var/folders/x7/dbq628s16yd1sks27jtgy5jr0000gn/T/sentiment-desk-jev-smoke-xhn7yk2j/desk.db`.
The process enabled only SEC EDGAR collection, supplied a temporary
contact-bearing SEC User-Agent, pinned Jev to `jev-1.13.0`, admitted only
`sec_edgar` input, limited Jev to one request per UTC day and 40,000 request
bytes per day, and disabled other providers and webhooks. The main
`data/desk.db` was not changed; it still has zero Jev request attempts.

Between `2026-10-01T09:41:27Z` and `09:41:35Z`, the temporary database recorded
27 SEC delivery receipts: 5 successful and 22 empty. They produced two actual
filing observations from two issuers. The Tesla filing at accession
`0001628280-26-063820` linked to delivery
`dca6b627-8b86-4288-bc01-6e88bf3bd072` and the public filing
`https://www.sec.gov/Archives/edgar/data/1318605/000162828026063820/tsla-20260929.htm`.
One Jev request returned HTTP 200 at `09:41:29Z`; AMD's observation remained
pending because the one-request cap was exhausted. The Tesla result was
`neutral`, `corporate_action`, `about=0.95`, `investor_relevant=0.97`, with
directional impact `+29.0`. It used 2,978 input tokens, 387 output tokens,
290 ms, and a 10,138-byte request. The application stored an estimated input
cost of `$0.000125076`, matching the public `$0.042` per million input-token
rate for Jev 1.13; this is not a provider invoice or account-balance
reconciliation. The request digest was
`4af7c9e7f2d0e2d5fbfc943ecf87c0a883eb1f082c07da6e504df597fefc70ee` and rubric
digest `0fcc7e5e785bd431b47789a38843a8840fe66c5fc285241a106ff18fccd6755b`.
SQLite `quick_check` returned `ok`.

The Codex in-app preview then ran against that same saved database with
external requests and Jev disabled. Selecting Tesla showed the SEC attribution,
delivery receipt, one persisted classification, and a one-point chart. The
filing was from September 29, so it did not populate the 24-hour source window.
This verifies one isolated real-source path and its saved-data presentation. It
does not satisfy the frozen evaluation's 30-issuer minimum, provide independent
labels, prove model quality, or establish ongoing live operation. The current
checkout still has no configured `SEC_USER_AGENT`; the temporary run did not
save its contact value.

The whole-build engineering-bullshit-detector returned **FAIL** for the full
goal. It found no new reproducible local defect, but confirmed that the main
database's 7,809 identified observations have no delivery links, the
4,700 `legacy_unknown` observations remain quarantined, there are only three
saved SEC observations from one issuer, and final real-source labels, reviewer
artifacts, budget evidence, and historical provider usage reconciliation are
absent. It could not verify a current main-app runtime. The separate GPT-6.1
Sol xhigh advisor confirmed that TypeSafe permission is granted but account
facts, a numeric spend ceiling, the SEC contact, and two human reviewers remain
unverified. No AI reviewer can replace the two independent human labels.

No demo or synthetic application data was added. The temporary smoke database
contains real SEC-derived records and remains separate from the main database.

The next product step is to freeze a qualifying receipt-linked SEC sample across
at least 30 issuer clusters, gather two independent blinded human label sets,
set an account-confirmed spend ceiling, and reconcile the historical 4,700
unknown rows against provider usage records. A valid SEC User-Agent contact
must be configured for further acquisition. Exact non-SEC source terms also
remain open. Until the frozen evaluation and operational gates pass,
Opportunity Radar stays disabled. The fresh ETL result after this record freeze
will be recorded in `project-record/4-log/live-data-etl-evidence.json`.

## Read-only architecture scan — 2026-10-01

Reviewed checkout `786b19720ea0a28df6272cc65c530389eb6accfd`, recent commit
hotspots, the selected Phase 1 architecture record, and the collection,
accounting, evaluation, and alert code. No repository `GLOSSARY.md` or
`docs/adr/` directory was present. The report is
`/var/folders/x7/dbq628s16yd1sks27jtgy5jr0000gn/T/architecture-review-20261001-125755.html`.

The top recommendation is to concentrate collection progression because
provider loops in `server/schedule.ts` repeat receipt, ingestion, health, and
recovery decisions that can drift across the real source-to-observation path.
The second strong candidate is a Jev attempt-and-budget ledger owning reservation,
dispatch, response, uncertain outcomes, and retry admission across
`server/db.ts` and `server/pipeline.ts`. Evaluation artifact review and alert
delivery are lower-priority candidates. The scan is architectural inference,
not a defect report; it found no ADR conflict and did not propose method names,
implementation changes, or an interface shape. User selection remains pending.

This survey does not reduce the real-data blockers: the main database has no
receipt links on its 7,809 identified observations, and the Jev quality gate
still needs a qualifying SEC cohort, two independent human label sets, and
account-confirmed usage controls. The proposed collection refactor would not
backfill historical receipt lineage.

## Zero-input archived-evidence UI — 2026-10-01T10:49:25Z

The user reiterated that product data must be real and must not be demo or
synthetic. The first-run surface therefore uses one actual archived SEC-to-Jev
run rather than seeded observations or a fabricated empty-state example. It is
explicitly described as a separate historical run, excluded from the current
installation and all Desk statistics, and independently unreviewed. The actual
filing title and filed date are visible. The SEC URL is linked; copied source,
collection and scoring times plus receipt, request, and rubric identifiers are
shown as recorded run references. The isolated SQLite run record is not bundled
with a fresh installation, so those identifiers are not resolvable there. The
model and uncalibrated model-reported confidence are shown with that caveat. No
filing text is republished in the archive card.

Before exposing this record, the coordinator and GPT-6.1 Sol xhigh advisor
queried the temporary SQLite database read-only. `PRAGMA quick_check` returned
`ok`. The saved Tesla observation has source URL
`https://www.sec.gov/Archives/edgar/data/1318605/000162828026063820/tsla-20260929.htm`,
filing date `2026-09-29`, SEC source timestamp `2026-09-29T20:38:50Z`,
retrieval `2026-10-01T09:41:29.506Z`, delivery
`dca6b627-8b86-4288-bc01-6e88bf3bd072`, and receipt digest
`695a0b359e553f25b39d47b4d9e96bf35df72f8ae9d373f7d5e938e5c84466ee`. The
Jev request attempt has digest
`4af7c9e7f2d0e2d5fbfc943ecf87c0a883eb1f082c07da6e504df597fefc70ee`, model
`jev-1.13.0`, and rubric digest
`0fcc7e5e785bd431b47789a38843a8840fe66c5fc285241a106ff18fccd6755b`. The
persisted result is `neutral` / `corporate_action`, model confidence `0.54`,
`about=0.95`, `investor_relevant=0.97`, and impact `+29.0`. The first candidate
had a request-digest typo; direct readback found it and the application code
and exact-value API test now use the stored digest. Confidence calibration and
classifier quality remain unevaluated.

The backend uses the existing `REAL_MENTION_FILTER` for an all-time eligible
observation count and only returns the typed archive at zero. It never inserts
the archive into the SQLite observation store or metrics. Historical eligible
rows suppress it even when stale. The browser also hides it immediately when a
local real observation appears in the stream, watchlist counts, or loaded feed;
loading/error do not count as empty. Displaying the archive calls only the
read-only local endpoint and makes no source or Jev request. Test-only parser
fixtures and quarantined-row assertions are isolated in temporary test
databases and are never used as product data.

The v1 engineering contract was migrated to version 2 using the global
template command, with `design.first_run` classifying SEC and Jev data ownership,
acquisition, the zero-input result, and blocked/error behavior. `public_release`
is true because `j-poc/sentiment-desk` is a public GitHub repository. The user's
attestation permits public sources and API use, and TypeSafe use was explicitly
authorized. Account-specific refill, spend ceiling, retention/telemetry, and
Order evidence remain unverified; no further Jev request is part of this work.

### Throughput checkpoint

1. **Blocking first steps.** Validate all displayed archival fields against the
   actual isolated database and keep external provider calls off.
2. **Independent workstreams.** The implementation worker owned the API, DTO,
   component, styles, and behavior tests. The coordinator owns contract,
   product records, system integration, runtime/browser proof, release gates,
   and the final Git checkpoint.
3. **Shared mutable state.** Code and acceptance-record writes were assigned to
   disjoint owners; the worker did not edit the contract or project records.
   Integration and shared-branch mutations remain serialized by the coordinator.
4. **Smallest safe decomposition.** One separate read-only `ArchivedRun` DTO,
   all-time count endpoint, and conditional React brief reuse the existing
   SQLite and UI boundaries; no seed path or provider request was added.

Focused UI/API tests now cover the real archive constants, stale-history
suppression, quarantined/demo-row exclusion, loading/error versus empty,
accessible disclosure, and immediate hide after a local observation. The first
focused run passed 4 tests; a typecheck initially found a props-union mismatch,
which was corrected. Full-suite, clean-profile browser/network inspection,
production build, offline/live-data gates, final independent whole-build review,
and push SHA readback are still required. The final commitment state will be
recorded after those checks. The frozen real-source Jev quality gate still
requires its separately sourced 30-issuer run and two independent blinded
human-label sets; this one real classification is not an evaluation dataset.

## Independent trace review

The independent reviewer confirmed that `live_data_etl_gate.py check` passed
for the saved receipt at `2026-10-01T09:03:19Z` and accepted the distinction
between SEC evaluator provenance/sample size and delivery receipt lineage. It
flagged the draft timestamp format and an overstatement about what the
isolated replay proved; both trace issues were corrected before this
checkpoint. A second pass also flagged a stale instruction to keep the native
goal active; that wording now points to the current status record. The reviewer
could not inspect the current-turn transcript, so
earlier command details and goal-service events are supported by the local
records and command outputs rather than an independent transcript audit. A
fresh final ETL verifier/check is required after these record edits.

## Zero-input whole-build review and evidence-boundary correction — 2026-10-01

The whole-build engineering-bullshit-detector reviewed the entire current
application and returned **FAIL** for operational readiness: UX 8/10, local
robustness 7.5/10, live readiness 2/10, and overall 4/10. It found no
additional reproducible code-local defect in this first-run candidate. The
investor/UI reviewer rated investor usefulness 6.5/10 and the true-empty UI
clarity 8.8/10. These scores are bounded reviewer judgments, not user research,
customer acceptance, or evidence of 10/10 readiness. The whole-build and
investor/UI reviews remain separate from the earlier design comparison scores.

Reviewing the rendered archive wording exposed one more accuracy gap: the
isolated run's SQLite database is not bundled with a fresh installation, so
the receipt and digest values visible there cannot be resolved from that
installation. The UI now calls them recorded run references, states that they
are not locally verifiable, and labels each identifier accordingly. The filing
URL remains linked. This preserves the actual SEC-to-Jev example without
claiming that its original receipt/scoring records are locally inspectable.
The focused `tests/first-run-evidence-brief.test.tsx` suite passed all 5 tests
after the copy correction. No provider call or synthetic product record was
made.

The v2 acceptance contract and project completion record now encode this
evidence boundary. Final full-suite, browser, security, dependency, live-data
ETL, GitHub, and whole-candidate checks are pending and must bind to the final
tree. The current agent board records the two whole-build scores and the
coordinator's pending verification status.

## Clean-profile interaction proof — 2026-10-01

The built app ran at `http://127.0.0.1:8795/` against a fresh isolated SQLite
file with `EXTERNAL_REQUESTS_ENABLED=false`. SQLite reported `quick_check=ok`,
24 registered company rows, zero `source_observations`, and zero `price_points`.
The read-only first-run endpoint returned HTTP 200, an eligible observation
count of zero, and the actual archived SEC-to-Jev record. No provider request
was enabled or made by this preview.

The first accessibility snapshot came from a pre-reload browser document; the
endpoint was healthy, and a full page reload displayed the current build. In
the refreshed UI, clicking Tesla changed the selected ticker and company
heading. It showed “No local chart data” and no gauge or time-series chart,
while the real filing and recorded-reference caveat remained separate. The
expanded disclosure labeled receipt and digests as recorded references. A
screenshot revealed a duplicated “Next” prefix in the operator action; the
copy was corrected and the 12 focused API/component/recovery tests passed. The
final screenshot showed one “Next step” label, the selected Tesla state, the
filing link, and no empty chart. The preview tab is marked to remain available
for user inspection.

This verifies the clean-profile UI contract, not live source acquisition or
Jev quality. The application remains externally paused. The source/recorder
terms, TypeSafe account spending behavior, SEC contact, real-source evaluation,
independent labels, and legacy usage reconciliation still block operational
acceptance.

## Final presentation wording — 2026-10-01

The archive title was changed from “verification” to “run” because the
one-item smoke establishes an integration path, not Jev model quality. The
recorded-reference disclosure font increased from 10px to 11px with stronger
text contrast after screenshot inspection. The final production build passed,
typecheck passed, and the focused first-run suite passed all 12 tests. Vite
continues to warn that the current JavaScript chunk is 614.48 kB after
minification; the existing build has no enforced size limit. Final acceptance
still depends on the remaining whole-build and operational gates below.
