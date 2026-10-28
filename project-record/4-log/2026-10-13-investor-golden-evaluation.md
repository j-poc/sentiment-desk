# Investor golden evaluation — 2026-10-13

## Readiness decision

The product is ready for operational use only when all seven frozen cases pass
on the intended production route. Each required criterion must be evidenced by
the observed investor task and its saved state. Any `FAIL`, `BLOCKED`,
`UNVERIFIED`, missing evidence or duplicate verdict means not ready. A fixture,
code review or empty chart cannot make a user case pass. Price is optional.
Opportunity Radar remains closed until this gate passes.

This gate establishes completion of the requested app workflows; it does not
establish investment returns, product superiority, customer retention or scale
economics. The AlphaSense comparison and repeated-use study remain later
product-value questions.

## Frozen cases

Two independent Codex subagents reviewed the investor jobs and false-pass
risks. The prosumer review specified the real tasks; the engineering review
challenged lineage and readiness claims. Their findings led to the v3 variant
criteria and fail-closed readiness checks. These reviews are challenge input,
not user-study data or subjective model-quality labels. The v3 acceptance
criteria were frozen before the v3 golden run; the earlier v2 run is not a
baseline for these criteria. Empty states satisfy only the matching negative
variant and cannot pass a positive-evidence or populated-chart requirement.

| Case | Required task evidence |
| --- | --- |
| G1 — Find a starting point | A fresh investor can start without a ticker or upload. A source-backed lead must include coverage, freshness, limitations and a next check; if none is supported, only the explicit no-relevant-source variant may pass with an honest empty result and the next check. A roster or unsupported empty state fails. |
| G2 — Select a company | Select A → B → A on desktop and narrow screen. Heading, sources, chart and decision must keep the selected issuer when earlier responses arrive late. |
| G3 — Read real sentiment | An explicit current provider result for genuine source evidence is durably saved, appears on a populated selected-issuer sentiment chart, reconciles to independently computed buckets, and opens the same receipt-linked source. Empty, simulated and stale results fail. |
| G4 — Check and recover evidence | Page and reopen the original source and its separate source/retrieval/ingestion clocks. A refresh failure keeps last-good evidence visible; recovery creates a new receipt. |
| G5 — Make and resume a research decision | Use a nonempty real evidence set with a material contrary item. Every decisive statement has support and limits; next action is clear. Save it, restart, and reopen the exact source snapshot and decision. |
| G6 — Understand a followed change | Compare two genuine snapshots against an immutable baseline. Distinguish a real changed development from a repost, late retrieval or later ingestion; preserve the old baseline. |
| G7 — Keep private evidence controlled | For a configured public issuer, keep a selected private item issuer-scoped and separate from public counts. Only explicit item-level send can leave the app; verify the actual returned provider/model. Private companies are out of scope. |

Each case is conjunctive; no averaged score can hide a required failure. The
frozen individual requirements and grader are in `scripts/investor-golden-cases.ts`.
Adversarial grader tests ensure missing/duplicate evidence and fixture-only
results cannot pass. These tests validate the rule; they are not product passes.

## Baseline and current run

No prior run used these frozen tasks and rules, so the golden baseline is
`UNVERIFIED`; no earlier test score is promoted as a baseline. The native runner
backs up the existing local SQLite file to a disposable directory, loads the
current configured public-issuer roster, prevents all network requests, and
reads existing receipt-backed source, decision and baseline state through the
Hono API. It closes and reopens the database to verify exact retained readback.
It creates no source, classification, analyst decision or baseline records. The
user's stored database and active services are not written. No model key is
loaded or used.

Run with `npm run evaluate:golden`. The case report is mode 0600 under the
ignored `.engineering-evidence/investor-golden/` directory and binds app source
hashes, route, retained source inventory, task readbacks, status and limits. It
exits nonzero until the complete intended route is observed and all seven cases
pass.

The optional `--journey-evidence` package can preserve two subagents’ structured
review claims against a build fingerprint. The loader checks schema, private
file modes, completeness, agreement and file hashes, but a local JSON file
cannot prove who authored it or that its screenshot shows the claimed outcome.
Accordingly, package `PASS` claims are downgraded to `UNVERIFIED`; package
`FAIL` and `BLOCKED` findings remain conservative blockers. The package is
review context, not acceptance authority. The runner also recomputes readiness
from native binding findings, so supplied case statuses cannot erase an actual
runtime blocker. An eventual passing journey must be captured by a trusted
in-process UI evaluator; the present runner has no such capture path, so it
cannot certify route-level acceptance yet. Grader unit tests use disposable
fixture artifacts only to test fail-closed behavior and never count as investor
passes. Subagent reviews do not establish statistical model accuracy.

Latest run, 2026-10-13 16:58 UTC, against a disposable copy of `data/desk.db`:

- **Case readiness: 0 PASS, 0 FAIL, 1 BLOCKED, 6 UNVERIFIED.** G3 is blocked
  because the retained seven-day real Apple window has zero eligible saved Luna
  classifications. The UI chart is present in the local build, but no rendered
  route or authentic classification was observed. No model result is fabricated.
- **Native real-data API steps: 4 PASS.** Two configured public issuers were
  selected A → B → A; source identities and clocks matched retained rows; the
  saved research brief and existing followed baseline survived close/reopen;
  and the empty sentiment query read correctly. No saved analyst decision
  exists, so decision resume remains unverified. The runner attempted zero
  external requests.
- **Current product evidence:** 4,700 `legacy_unknown` observations remain
  quarantined; both classification tables have zero rows; the latest retained
  Google/Yahoo RSS receipts are from October 11 and do not establish current
  collection freshness. No production browser route was observed.
- **Unresolved user outcomes:** tickerless discovery, rendered issuer switching,
  browser source archive and failure recovery, a saved analyst decision with
  contrary evidence, a changed-event follow comparison, the explicit private
  evidence/provider journey, and cloud persistence.

The first v2 run found the CloudResearchDesk chart absent; the local build route
was corrected to mount the full Sentiment Desk, while Vercel explicitly selects
the separate SEC-only cloud surface. The follow-up engineering review found a
false-ready path: a locally authored all-PASS journey package could overwrite
the native no-classification blocker. The grader now treats file-based reviewer
PASS claims as UNVERIFIED and recomputes readiness from binding native failures
and blockers. V3 also requires each case variant to be separately observed and
binds native failures to the user outcomes they invalidate. Regressions cover
fabricated reports, the exact no-Luna-result case, native failure binding, and
caller-supplied all-PASS statuses. These repairs do not produce a provider
result or replace the missing browser journey.

### Current v3 run — 2026-10-13 17:28 UTC

`npm run evaluate:golden` ran against a disposable copy of the user's database.
It returned **0 PASS, 0 FAIL, 1 BLOCKED, 6 UNVERIFIED**; readiness is false and
the report records zero attempted external calls. Native API checks passed for
real issuer selection, receipt-backed source clocks, persistence after reopen,
and the current sentiment-series read. G3 is blocked because both saved Luna
classification tables contain zero rows. The remaining browser-only criteria
have no authenticated in-process route capture; user-authored decision and
private-item journeys also remain unobserved. No classification or investor
decision was generated for the evaluation.

The local UI was separately opened with external requests disabled after the
additive evidence-assessment migration. The sentiment chart rendered its
truthful no-classification state, and the evidence-assessment endpoint returned
HTTP 200 with no browser console errors or warnings. This browser smoke check
does not count as a golden user-task pass because it is not captured and graded
by the in-process evaluator.

## Limitations and promotion

The existing retained source database contains real provider rows but also
4,700 quarantined `legacy_unknown` observations. Those records remain excluded
and the runner does not count raw inventory as eligible evidence. The captured
source rows are at least two days old at this run, so current collection
freshness is not established. No usable saved real Luna classification is in
the selected window. The user's API key/account is never read by this runner.

Golden case PASS means the specified product task worked with the observed real
inputs on the observed route. It does not prove general investor value. If a
later decision concerns superiority, repeat use or scale, run a separate
prospectively specified comparison with real investors, cost, time, uncertainty
and failure denominators. Do not mix that future study into this operational
gate or infer it from agent reviews.
