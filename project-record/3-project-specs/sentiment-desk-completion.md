# Sentiment Desk completion plan

## Current execution objective

Complete Sentiment Desk as a real-data-only, locally operational investor
product under this plan and the current v2 `engineering-contract.json`. For
new classifications, use the accepted OpenAI GPT-6 Luna categorical contract
and complete its frozen real-source evaluation within finite
account-owner-approved request, byte, and USD budgets and the source, account,
usage, and retention gates; preserve historical Jev records separately. Verify
the full investor journey, including tickerless discovery, fundamental
research, and followed-company change, with authorized evidence, interruption
recovery, and rendered UI proof of persisted saved-state readback. Keep the
frozen Master Eval, investor outcome gates, and complete product ambition
binding; independent subagent references are diagnostic and do not replace
human ground truth or user-outcome evidence. Opportunity Radar stays disabled
until operational acceptance passes. Use only the explicitly authorized
`j-poc/sentiment-desk` repository on `codex/real-data-rebuild`; verify the
remote SHA after each reviewed checkpoint and preserve current repository
visibility. The native Goal objective remains unchanged because its exposed
control is status-only; the accepted Luna
direction supersedes its stale Jev-core wording for new classifications. This
documentation authorizes no model calls, source collection, or authority change.

## Highest-level product-success evaluation: Master Eval — BLOCKED

The intended users are serious individual investors and professional analysts,
including the product owner. Their main focus is long-term fundamental research
and small-cap companies; special situations, event-driven opportunities,
sentiment, and social trends also matter. The user reports that existing tools
feel overwhelming, make it hard to know where to start, and assume the investor
already knows a ticker or thesis. Sentiment Desk must give them a clear first
step, show why a company or change deserves attention with inspectable evidence,
and point to the next research action.

The primary information-advantage hypothesis is narrow and testable: for early
retail or consumer adoption and dissatisfaction shifts, Sentiment Desk can
surface a more decision-useful, independently supported signal than AlphaSense
by joining real public micro-observations, separating independent origins from
reposts or repeated coverage, preserving point-in-time evidence and uncertainty,
and linking the change to a company driver, counter-signal, and next check. This
is a hypothesis, not a current product claim. AlphaSense is the primary
comparator because its current official materials describe AI research and
monitoring, sentiment analysis, real-time alerts, early market signals, and a
10,000+ source library. Those are strengths to test against, not capabilities
assumed absent from Sentiment Desk or AlphaSense. Public materials checked on
2026-10-03:
[AlphaSense Platform](https://www.alpha-sense.com/platform/) and
[AlphaSense Market Intelligence Platform](https://www.alpha-sense.com/solutions/market-intelligence-platform/).
The exact AlphaSense product version, account entitlements, and in-product
access were unavailable during this review; no output comparison has run.

### Frozen comparison task and pass rule

For each of 30 prospectively registered real listed-company event windows,
across at least 15 issuers and 6 sectors, ask both systems the same question at
the same UTC cutoff: what materially changed in retail or consumer adoption,
dissatisfaction, or public discussion during the prior 7 days; what evidence
connects it to a long-term fundamental driver or risk; what contradicts it; and
what should the investor inspect next? Require each product to return no more
than three prioritized signals with original-source links, source and retrieval
times, independent-origin counts, uncertainty, counterevidence, and the next
research step. No buy/sell instruction or return prediction is in scope.

Freeze eligible events and cutoffs before either product output is viewed; use
one event per issuer when possible and never more than two. Both products get
the same task, 7-day window, and 20-minute analyst interaction allowance. Use
each product's authorized native sources and record its exact version, access
tier, settings, time, latency, and cost; native source breadth is part of the
comparison, so source sets need not be artificially equal. Preserve the output
and permitted source lineage. Do not retain licensed content that its terms do
not allow. No synthetic observations, generated examples, or post-hoc case
selection count toward the evaluation.

Two blinded review agents in separate, freshly initialized contexts score
anonymized outputs against the original source material. Use distinct
configured models where available, but do not claim model-family independence
without evidence of genuinely separate model lineages. Each independently
checks entity and time alignment, factual support, business-driver relevance,
source independence, duplicate/repost handling, counterevidence, uncertainty,
and whether the result could change the investor's next research action. A
third blinded agent adjudicates disagreements without choosing a new result
after seeing which product leads. Agent agreement is reviewer reliability
evidence, not human ground truth; correlated model errors remain a limitation.

A valid no-signal output explicitly says that no supported material signal was
found in the searched scope and time window, and reports actual source coverage,
freshness, material gaps, uncertainty, and the next check. Reviewers score it
against the same task; it is neither an automatic win nor an automatic error.
Missing, malformed, or unsupported outputs never count as wins and remain in
the task-level outcome and error denominators. Report missing, invalid,
no-signal, and supported-signal outcomes per product. Count material factual,
entity, source, and timestamp errors both per task and per asserted claim.

A task is a Desk win only when reviewers verify at least one additional
material and decision-relevant signal absent from AlphaSense, supported by
eligible point-in-time sources from at least two independent origins, not
duplicated or contradicted by unresolved material evidence, and accompanied by
a concrete next check. Define comparator wins symmetrically. If each product
has a unique supported material finding, the task is a tie; all other
non-wins are also ties unless the symmetric comparator-win rule applies.

Before seeing either system's output, freeze issuer, shared-event, and
time-window dependence clusters, the paired inference method, and both
significance thresholds; prefer one task per issuer. Compare paired task
outcomes with a two-sided exact test over discordant Desk/AlphaSense wins and a
predeclared dependence-aware paired inference that respects issuer and
shared-event dependence. Both tests must support a Desk advantage at two-sided
p<0.05. If defensible cluster-aware inference is unavailable, report
descriptive outcomes only and leave the statistical gate **UNVERIFIED**; a
completed non-supportive cluster-aware result is **FAIL**, even when the
unclustered test is significant. The Master Eval passes only with 30 completed
paired tasks, at least 10 Desk wins and no more than 2 AlphaSense wins, both
significance tests below 0.05, at least 80% pre-adjudication agreement on
task-level outcomes, and no higher material factual, entity, source, or
timestamp error rate than AlphaSense. Freeze the task and claim error
denominators before review. Any unsupported or false claim invalidates that
task's asserted win. This test establishes only the named information
category; it does not establish investment returns, broad superiority, customer
retention, or release readiness. Missing authorized access or output is
**BLOCKED**; inadequate or incomplete results are **UNVERIFIED**; a completed
comparison below threshold is **FAIL**.

### Practical investor-use acceptance

The information advantage is useful only if an investor can reach and act on
it without already knowing a ticker or preparing a thesis. Keep these three
separate end-to-end tasks in the acceptance plan:

1. **Discover without a ticker or thesis.** From a fresh profile with no
   uploaded or user-built dataset, the product uses its authorized,
   product-owned real sources to show a short, current set of companies worth
   investigating. Each item explains why it surfaced, links to inspectable
   evidence, labels freshness and uncertainty, and offers a next step. The
   starting set must represent the intended small-cap and fundamental use, not
   merely relabel the existing large-company watchlist. A source count or
   unexplained ranking does not pass.
2. **Decide whether a company merits more research.** Starting from a company
   selected in the product, the investor can inspect the relevant fundamental
   driver, new supporting evidence, independent-source status, counterevidence,
   missing information, and a concrete next research question, then decide
   whether to investigate further. The product makes no unsupported thesis or
   trade recommendation.
3. **Recognize a material change in a followed company.** Starting from a
   followed company, the investor sees what changed relative to its prior
   evidence, the event and retrieval times, supporting and contradictory
   source origins, whether coverage is repeated, what remains uncertain, and
   the next check. Stale history must not be presented as a live change.

Product-owned public or licensed information must be acquired through an
authorized programmatic route. A new investor should see useful evidence before
being asked to add a private watchlist or configure a ticker; personalized
watchlists remain user-owned. Agent walkthroughs and passing tests do not
establish practical value. Before claiming these tasks work for investors,
observe intended users complete the real UI paths without coaching; record
every attempt, completion, time to a source-checked result, corrections, and
remaining effort. Freeze these practical thresholds before sessions: at least
five serious individual investors and five professional analysts each attempt
all three tasks; at least 80% uncoached completion per task and audience; median
time to a source-checked result no greater than ten minutes; zero critical
source, entity, or time errors; and no more than one user-reported factual
correction per completed task. The product owner may count as one investor but
cannot be the sole investor evidence. If direct access or suitable current
evidence is missing, mark the task **BLOCKED** or **UNVERIFIED**, not passed.

Current Master Eval and practical-use status: **BLOCKED**. The saved-data
preview has 24 configured companies, no current Luna classifications, external
requests disabled, no verified Apple price points, and incomplete delivery
lineage on the paged historical Apple rows. Its four-day-old historical chart
does not prove current discovery or monitoring. No AlphaSense application
access or comparative output, no prospective task cohort, and no observed
professional-analyst session are available. Opportunity Radar remains disabled;
this acceptance does not authorize its expansion. The exact current findings
and next evidence are recorded in
`project-record/4-log/2026-10-02-luna-chart-completion-review.md`.

The engineering contract now requires private outcome reports at
`.engineering-evidence/outcomes/master-eval-report.json` and
`.engineering-evidence/outcomes/investor-workflows-report.json`. The shared
`scripts/check_product_outcome_evidence.py` command checks the frozen sample,
statistical and task thresholds, and binds each report to a private evidence
bundle digest. It does not authenticate source rights, evidence truth, evaluator
independence, participant eligibility, or the rendered product path. Those
claims remain subject to an independent review of the underlying evidence.
Missing reports return `BLOCKED`; incomplete evidence returns `UNVERIFIED`;
measured threshold misses return `FAIL`.

For each product and task, the ledger distinguishes `supported_signals`,
`no_signal`, `missing`, and `invalid`. A valid no-signal row may contain zero
claims, but it must bind hashed evidence for the searched scope, registered
window, source coverage and freshness, material gaps, uncertainty, and next
check. Missing and invalid rows cannot be treated as ties or no-signal results.
The default checker always exits nonzero after structural calculations because
local JSON, booleans, and hashes cannot authenticate source truth, evaluator
identity, subagent execution, or real participants. Its `--structural-only`
mode is for fixture diagnostics and is not acceptance evidence; matching a
locally authored review file never clears the authenticity gate. A product
with no asserted claims across the complete evaluation has an undefined
per-claim error denominator and cannot pass.

## Current user-directed rebuild — 2026-10-02

The user rejected the investment UI and explicitly replaced independent human
labels with independent subagents. This supersedes the human-label requirement
for the active product-cohort diagnostic; historical human statistical profiles
remain intact for readback. Agent references are not human ground truth or
broad population certification. The v2 engineering contract records the new
observable UI and diagnostic acceptance criteria.

The native goal service reports **active** as of October 2, 2026, but its stored
objective still names Jev as the core classifier. Available goal controls do
not expose objective editing. The user's later direction selects OpenAI GPT-6
Luna for new classifications while preserving historical Jev records; that
direction governs this continuation. Root owns chart/data integration, shared
records, runtime verification and Git, with isolated implementation and
independent whole-build, investor and UI reviews.

An earlier Jev account readback established no available credit, auto-recharge
off and no payment method; that does not establish OpenAI account access or
budget. The current shell has no direct OpenAI API credential, and no Luna API
request has been made. Source collection and blinded agent reference labeling
can proceed without paid model calls; new product classifications remain
pending until a finite OpenAI account budget is available.

Default preview remains saved data only. The UI must prioritize selected-company
history and supporting sources, preserve a useful visible true-empty first run,
and expose pending/failure/freshness/model-quality limitations. No synthetic
application records, new Radar expansion, license or release action is allowed.
The current continuation and chart review are recorded in
`project-record/4-log/2026-10-02-luna-chart-completion-review.md` and its
continuation TSV. The agent-reference extension and limitations are in
`project-record/4-log/2026-10-02-luna-agent-reference-extension.md`.

## OpenAI Luna replacement — current scope

The user explicitly requested research and replacement with OpenAI's Luna.
Official documentation confirms GPT-6 Luna supports Responses and strict
Structured Outputs. It is a categorical alternative to Jev; probability service
compatibility is not established. New records use a distinct categorical
profile; genuine historical Jev probabilities, numeric indices and archive
remain unchanged. No invented confidence or one-hot probability is permitted.

The current shell has no OpenAI API credential. Codex/ChatGPT model access does
not establish direct API access or billing; Jev account balance cannot be
carried over to OpenAI. Any paid dispatch requires a finite OpenAI request,
byte and USD cap with durable pre-dispatch reservation. There is no automatic
TypeSafe fallback. The frozen SEC cohort and blinded agent references qualify
only the exact Luna profile; fixture passes do not establish real
classification quality. The native goal remains active with stale Jev-core
objective wording because its status-only controls cannot edit that objective.

Two independent, blinded agents labeled all 48 items in the frozen SEC
reference frame, with a separate third agent reviewing the three disputed
cases. The original cohort contains 30 cases from 15 issuers; 18 additional
cases form a post-hoc diagnostic extension. Each primary reviewer assigned 27
neutral, one negative, one positive, and 19 null sentiment labels. Agreement
on all 48 sentiment values includes the 19 matching nulls. Each directional
class has only one case, and the extension was selected after seeing the
neutral-heavy pilot. This does not qualify three-class performance or
establish human ground truth. The new backend/UI and evaluator are integrated;
local tests and request/recovery controls do not replace a direct authorized
OpenAI run or provider usage/budget evidence. The actual integrated preview
remains saved data only. Final scoped ETL and pushed-source readback are kept
in their authoritative receipts; full build completion is not claimed.

The entries below are historical and do not supersede this current scope.

## Latest native goal status check — 2026-10-01

After the user's latest continuation, the goal service reports the existing
Sentiment Desk goal as **active**, superseding the earlier blocked readback.
Its full objective remains unchanged and unachieved. Current work repairs the
independent Jev evidence checker and restores access to health disclosures in
the true-empty Desk. The current evaluation, bounded real-source smoke, and
remaining inputs are recorded in
`project-record/4-log/2026-10-01-goal-resumption-audit.md`; the current
evidence-gate and health/snapshot recovery repairs are recorded in
`project-record/4-log/2026-10-01-jev-evidence-gate-repair.md`. The product remains
incomplete pending an independently reviewed real-source evaluation and
account/source evidence. Opportunity Radar stays disabled.

## Current continuation — 2026-10-01

The user explicitly authorized TypeSafe use for Sentiment Desk and said a
balance should remain. A single real-source SEC-to-Jev request then ran through
the application in a fresh process and isolated temporary SQLite database. The
run used a contact-bearing SEC User-Agent for that process, allowed only
`sec_edgar` text into Jev, pinned `jev-1.13.0`, capped the run at one request
and 40,000 request bytes per UTC day, and disabled other feeds and webhooks.
It collected 27 SEC receipts, which produced two filings from two issuers.
Jev returned one HTTP 200 classification. The other filing remained pending.

The scored Tesla 8-K was neutral, classified as `corporate_action`, with
`about=0.95`, `investor_relevant=0.97`, and directional impact `+29.0`. The
request used 2,978 input tokens and 387 output tokens. The app's estimated
input cost was `$0.000125076`; this is not invoice or balance evidence. The
separate saved-data UI preview showed the source receipt, classification, and
one chart point. The main `data/desk.db` was unchanged. The smoke proves one
real integration path, not classifier quality, 30-issuer coverage, or ongoing
live operation.

An earlier whole-build engineering-bullshit-detector returned **FAIL** for the
full goal and found no new reproducible local defect in that candidate. It confirmed unresolved
delivery links for the main database's identified legacy records, the lack of a
30-issuer real SEC cohort and independent human labels, no final spend artifact,
and no provider records for historical usage reconciliation. The GPT-6.1 Sol
xhigh advisor agreed that the TypeSafe permission is granted while the account's
Order, refill, telemetry/retention, limits, rejected-request billing, and
numeric spend ceiling remain unverified. No demo or synthetic product data was
added. Do not send more Jev input until the account spending exposure is
verified.

The exact smoke record and current goal gaps are in
`project-record/4-log/2026-10-01-goal-resumption-audit.md`. The ETL contract
still has `live_claim=false`; the one-request smoke does not change that claim.

## Zero-input continuation note — 2026-10-01

The whole-build review rated UX 8/10, local robustness 7.5/10, live readiness
2/10, and overall readiness 4/10. The investor/UI review rated investor
usefulness 6.5/10 and the reviewed empty-state UI 8.8/10. These are bounded
reviewer judgments, not customer validation or a 10/10 claim. The reviewer
found no further code-local issue in the current first-run slice; its external
evaluation, account, source-rights, SEC contact, and legacy-usage blockers
remain open.

The first-run archive now explains that its receipt and digest strings are
recorded references. A fresh Desk installation cannot resolve them because
the isolated run's SQLite records are not bundled. The SEC filing remains a
direct link, and the archive remains outside local observations, charts,
metrics, usage, and alerts. A focused component test passed after this wording
correction. Final browser, repository, and live-data gate results are recorded
in the goal-resumption trace and ETL evidence artifact.

In the clean offline browser profile, the 24-company catalog loaded with zero
saved source observations. Clicking Tesla changed the selected company panel;
the empty chart and gauge stayed hidden. The archived real filing and its
recorded-reference caveat appeared above it, and the operator next step was
visible. The first view had been an old browser document; the API returned
HTTP 200 and a hard reload loaded the current build. The screenshot then
revealed a duplicated “Next” prefix, which was removed before the final
rendered screenshot. External source and Jev requests stayed disabled. The
archive heading now says “run,” not “verification,” and the disclosure text is
slightly larger and higher contrast. The final production build passes with
the existing 614.48 kB JavaScript-chunk warning.

## Pre-smoke checkpoint — 2026-10-01T01:02:05Z

The schema-2 ETL receipt passed all five required checks at
`2026-10-01T00:58:07Z`, and a subsequent `live_data_etl_gate.py check`
confirmed a current matching fingerprint. The scope includes real Yahoo quote
and chart observations, real RSS/GDELT source delivery into a disposable
Compose database, fixture/failure/replay regressions, offline default-off
source gates, and saved-volume recovery. It does not claim general live
operation: optional credentialed sources and Jev were disabled in the smoke,
and the product remains **SAVED DATA ONLY** with external requests paused.

The first reviewed implementation checkpoint, `8d7a21a`, was pushed to
`origin/codex/real-data-rebuild` and its remote SHA matched local HEAD. The
separate `engineering_gate.py check` still fails with `missing evidence
receipt`. There is no independent real-source Jev run or blinded label set to
support the contract's evaluation acceptance item, so no alignment review or
passing engineering receipt has been manufactured. The investor review scored
saved-data workflow 8.6/10 and live readiness 2/10; UI was 8.6/10 overall and
8.5/10 for health/alert discovery; whole-build review was 8.5/10 UX, 7.5/10
operations, and 2/10 live. Nothing here establishes 10/10, broad scalability,
or production robustness.

The repository is getting this final gate/disposition record and a trace-only
checkpoint after the frozen check; its exact pushed SHA is given in the handoff.
The outstanding work requires authorized TypeSafe account-use, retention,
telemetry, billing/refill, limit, and spend-ceiling evidence; a contact-bearing
SEC User-Agent; two independent blinded real-source reviewers; a frozen,
provenance-backed sample covering at least 30 issuers and its authorized Jev
run; exact source-specific permission terms; and provider usage/billing records
to reconcile 4,700 `legacy_unknown` rows. User rights attestation is preserved
but does not replace those account and endpoint records. Opportunity Radar
remains disabled.

## Final local continuation — 2026-10-01T00:34:59Z

This continuation fixed the actionable alert and health gaps from the fresh
whole-build, investor, and UI reviews. The alert API now gives failures
priority, counts all outstanding outcomes, validates its older-page cursor,
and loads older rows without exposing webhook payloads. The collapsed health
summary surfaces source, Jev, ingestion, and alert degradation beside the Desk
controls at common widths. The webhook status now explicitly says
“webhook not configured” before any alert exists; its regression failed before
the fix and passes after it.

The refreshed Codex in-app preview at `http://127.0.0.1:8798/` is connected to
the real saved SQLite database. It shows `SAVED DATA ONLY`, paused external
requests, paused Jev, and no configured webhook. Direct 1280×720 interaction
confirmed that selecting Adobe changes the company view, and that selecting
Apple shows 334 saved scored records across 37 score-time buckets in 7D versus
zero scored records and buckets in 24H. The latest Apple evidence is about two
days old. The empty 24H view offers the saved 7D history. No eligible saved
Yahoo price points exist, so the interface does not draw a stock-price series.
No demo or synthetic records were added to the app database; fictional parser
and logic fixtures remain isolated to tests.

Fresh bounded reviewer results remain below 10/10. The investor reviewer scored
the saved-data workflow 8.6/10 and live readiness 2/10. The UI reviewer scored
the interface 8.6/10 and health/alert discoverability 8.5/10 after fixes. The
whole-build engineering reviewer scored saved-data UX 8.5/10, operations
7.5/10, and live readiness 2/10, and found no new reproducible local defect in
the final code-level re-review. The two independent reviewers could not operate
the coordinator's browser session; the coordinator separately verified the
rendered build and interactions. No task study establishes investor value or
10/10 readiness. The GPT-6.1 Sol xhigh advisor found no justified reason to
smooth the order-sensitive index without investor and real-label evidence.

The final local suite passed 333 tests across 46 files, typecheck passed,
production build passed, and `npm audit --omit=dev --audit-level=high` found
zero vulnerabilities. Gitleaks initially reported 26 token-pattern matches
only in the ignored mutable SQLite WAL. The repository now declares that
runtime `data/` is outside source scanning and is never checkpointed; the
redacted source scan then passed, scanning 9.88 MB with no leaks. Its 84 MB
database files exceed the scanner's 20 MB file limit and remain local mutable
data. Gitleaks v8.30.1 uses the checked-in path allowlist, based on the
[official Gitleaks configuration example](https://github.com/gitleaks/gitleaks/blob/master/.gitleaks.toml).

The previously recorded ETL `PASS` at `2026-09-30T21:21:29Z` predates this
candidate and is stale. The early current `verify` attempts stopped at
contract validation before any declared command or provider request: the first
identified missing acquisition paths and source-bound check coverage; the
second identified required network-plus-cache delivery states for timestamped
observations. The schema-2 repair records adapter paths, per-check source IDs,
and separates metadata locators from timestamped observations. Saved-value
fallbacks retain original source times, and the Yahoo chart memory cache has a
60-second delivery TTL. It sets `live_claim=false`: external requests are
default-off and the bounded smoke only exercises Google News RSS, Yahoo
Finance RSS, GDELT, Yahoo quote, and Yahoo chart. A successful smoke will not
claim that other providers, Jev, or the app generally are live.
The latest matching verify/check receipt in
`project-record/4-log/live-data-etl-evidence.json` is authoritative; its code
fingerprint must match the final candidate. The disposable Compose smoke sends
no Jev or webhook request and does not prove provider terms, complete source
coverage, or currentness of saved app data.

The full product objective remains unmet. The user's public-source rights
statement is recorded as an operator attestation; endpoint-specific use,
retention, display, processing, deletion, and coverage evidence is incomplete.
No authorized TypeSafe account-owner confirmation of permitted use,
telemetry/retention, billing/refill behavior, limits, and spend ceiling is
available. A contact-bearing SEC User-Agent, two independent blinded human
label sets, an authorized real-source Jev run and passing frozen evaluation,
and provider usage/billing records to reconcile 4,700 `legacy_unknown` rows
are still missing. The root engineering alignment receipt is separate from
the live-data ETL receipt. Opportunity Radar remains disabled until the
Sentiment Desk's research and operation gates pass. Checkpoint SHA and remote
readback are reported in the final handoff.

## Live-smoke runtime recovery — 2026-10-01T00:54:07Z

The schema-correct ETL run passed fixture, source failure/recovery, replay, and
offline-startup checks, but its keyless live smoke could not reach Docker: the
contract named the dedicated `colima-sentiment-desk-verify` context and that
preconfigured profile was stopped. The active context was Citrini, so it was
not reused. Starting only the existing Sentiment Desk profile without global
activation restored the named context. The exact declared smoke then passed:
27 real Yahoo quotes, 24 companies, a current collector sweep, and a real
Google News pending observation appeared in the disposable database; after
container recreation the same observation and database survived. No Jev,
optional credential, webhook, or user database was involved. A fresh complete
ETL `verify` followed by `check` is still required to bind these outcomes to the
current frozen tree.

## Historical goal state snapshot (earlier on 2026-10-01; superseded above)

The native goal remains **active** while the user asks Codex to continue. A
frozen-source gate passed at `2026-09-30T21:02:28Z`, and its subsequent
`check` confirmed the evidence binding. This update changes only documentation;
a final `check` confirms the same code and contract fingerprint. The broad
operational goal remains incomplete: no authorized
real-source Jev cohort or independent real-source label evaluation exists. The
user attested to rights for public sources and APIs on 2026-09-29; that remains
an operator attestation, not independent endpoint-terms evidence. TypeSafe
account-owner approval, telemetry/retention, billing/refill behavior, limits
and a spend ceiling; a contact-bearing SEC User-Agent; two independent blinded
real-source reviewers and a passing Jev evaluation; provider records for 4,700
`legacy_unknown` rows; and complete, source-specific coverage/right evidence
remain open. Do not expand Opportunity Radar until the Sentiment Desk gates
pass.

The saved-data interface was rendered and driven in the Codex in-app browser
at `http://127.0.0.1:8797/` against an isolated copy of the real saved
database. It showed **SAVED DATA ONLY** with external requests and Jev paused.
At 1280×720, Adobe 7D showed 58 scored source records across 23 15-minute
score-time buckets; the latest score and collection were 2 days old and there
were zero new source records in 24h. The fixed −100 to +100 index explains its
8-hour modeled decay and gives scored-record counts their own aligned pane. A
16-record bucket exposed individual impacts from −88 to +97 and a −17 index
value. The movement is a sequence over source records, not an observed crowd
vote or stock return. Price comparison correctly showed no saved
lineage-eligible Yahoo points. The keyboard table exposed saved score buckets,
source drilldowns, and an explicit empty price state. An independent whole-
build review also drove Adobe 3D, opened a seven-record bucket, and confirmed
that its seven historic rows had no delivery-receipt links. These sessions
establish saved-data UI behavior only; no demo or synthetic application data
was shown.

Current separate reviewer scopes: the investor reviewer scored the saved-data
workflow **8.8/10** and live research readiness **2/10**. The UI reviewer
scored hierarchy **8.5**, chart interpretation **9**, discoverability **8.5**,
responsive/mobile **8**, and accessibility **8.5** out of 10. The whole-build
engineering reviewer scored UI **8.5/10**, saved-data evidence workflow
**8/10**, and live readiness **2/10**, and found no reproducible local defect
in the paths inspected. These scores are not combined. No reviewer or user
study establishes 10/10. The GPT-6.1 Sol advisor at extra-high effort found
no justified local polish change: the index is order-sensitive by design, so
large movements need validation against investor tasks and real Jev/source
evidence rather than smoothing away. No investor task study or
assistive-technology session has been run.

The latest local changes preserve a separate latest-collected timestamp when
the 24-hour source count is zero, preserve the latest Jev completion time when
the selected chart window has no score arrivals, and show record volume in a
separate pane. Keyboard inspection includes saved price, currency, provider
source time, and collection time; Jev/price loading, failure, and confirmed-
empty states are distinct. Focused regressions cover these paths. The company
gauge remains separate: a source-record weighted mean over three hours with a
24-hour fallback. Repeated coverage may count more than once. New observations
require identified collectors and immutable delivery receipts. Historical
`legacy_unknown` rows remain quarantined from research reads and Jev dispatch;
their original provider/model use remains unreconciled. Current product writes
reject synthetic observations. No demo or synthetic product rows were added;
unreconciled historical unknowns are not claimed as real.

The code-bound ETL verdict, timestamp, and fingerprint are owned by
`project-record/4-log/live-data-etl-evidence.json`. The previously recorded
17:56 PASS predates the current changes and is stale. A valid final disposition
requires the newest matching `verify` and `check` after all code and project-
record edits are frozen; consult that artifact for its exact status and
fingerprint. The bounded keyless Compose smoke uses an isolated
temporary database with no provider credentials and no Jev request. It proves
only the scoped public-source delivery and persistence path, not Jev quality,
TypeSafe account approval, or complete coverage.

The API keeps Opportunity Radar disabled and returns 404 for its routes while
the Desk gate is incomplete. The native goal remains **active** and
incomplete. Continue authorized local work and push verified checkpoints; the
external evidence blockers still prevent operational completion. Detailed ratings,
rendered evidence, exact gate results, and the checkpoint decision are in
`project-record/4-log/2026-09-30-investor-ui-review-and-gate-refresh.md`,
`project-record/4-log/2026-09-30-final-checkpoint.tsv`, and
`project-record/4-log/live-data-etl-evidence.json`.

## Historical goal state snapshot (2026-09-29; superseded)

The native Sentiment Desk goal is **blocked** (confirmed from the goal service
on 2026-09-29). Local engineering and review can still address code and UI
defects; full readiness remains unverified pending external evidence.
Server-side feed filtering and keyset pagination
keep identified-source failed/pending Jev items reachable beyond the first 100
and beyond seven days. The saved-data browser check confirmed company selection
and older-page loading with source and Jev requests paused. Historical
`legacy_unknown` observations remain quarantined from research reads.

The chart now defaults to the fixed −100 to +100 Jev impact index, rendered on
one 15-minute score-time grid with one fixed eight-hour decay half-life across
all selected windows. The visible history is reconstructed from all previously
scored records for that company, so changing 6H/24H/3D/7D neither resets the
index nor changes a shared timestamp's value. Buckets expose counts and
within-bucket item ranges; dashed segments remain explicitly modeled decay.
Price comparison is opt-in. A new
SQLite migration labels old price rows with missing source lineage as
`legacy_unknown` and excludes them from the chart and reaction calculations.
New Yahoo chart/quote points require provider collector, currency, source time,
retrieval time, adapter version, and a matching immutable delivery receipt.
The gauge is explicitly distinct from the chart: the gauge displays a
source-record weighted mean over three hours, falling back to 24 hours, and
reports its contributing-record count. Repeated and syndicated coverage can
still count more than once. New live observations now link to the immutable request receipt that produced them; the pipeline rejects receiptless inserts and validates collector, company, and adapter against the receipt. Historical observations remain unlinked because their original receipt IDs were never stored; the detail drawer labels them as historical rather than inventing lineage. Item detail now distinguishes the most-likely sentiment class from directional impact, defined as P(positive) minus P(negative). The app respects reduced-motion preferences. This
is a defensible current design hypothesis, not a claim of “absolute best” or
10/10: no task-based investor usability study has been run. The latest AAPL
72-hour review found that repeated mixed-impact publisher records can move the
series materially; story/event clustering and real task comparison remain
open product work. Public forum feedback is anecdotal only. The isolated
saved-data preview checks presentation and selection behavior, not live
delivery or Jev quality.

The latest 1280×720 saved-data browser preview used the isolated temporary
SQLite copy with all external requests and Jev disabled. It selected ADBE and
confirmed the gauge, chart, and feed changed together. The view showed 10 ADBE
source records in 24h, four scored records in the 24h gauge fallback, and
three chart buckets; there was no lineage-verified ADBE price point. The API
reports Radar disabled and both Radar routes return 404 until the Desk gate
passes. No synthetic product data was added.

Current tests, typecheck, build, browser readback, and whole-build review are
recorded in
`project-record/4-log/2026-09-29-engineering-bullshit-detector-review.md`,
and `project-record/4-log/2026-09-29-sentiment-price-chart-product-decision.md`.
The final gate refreshes
`project-record/4-log/live-data-etl-evidence.json`; the code-bound result is
reported from that artifact. Remaining external
gates are authorized TypeSafe account use and a spend ceiling, a contact-bearing
SEC User-Agent, independent blinded labels and a passing real-source Jev
evaluation, provider records to reconcile historical `legacy_unknown` usage,
and source coverage that is explicitly finite and incomplete. The user's
public-source rights attestation is retained as such; it is not presented as
independent review of endpoint terms. Opportunity Radar remains downstream and
must not be expanded or promoted until the Sentiment Desk gate passes.

The TypeSafe, SEC, real-source evaluation, historical-usage, and coverage
gates need evidence from the authorized account owner, qualified reviewers,
and provider/account records. The goal remains blocked until those external
inputs arrive and the required paths pass. Local fixes may continue without
changing that status.

## Earlier consolidated status snapshot (historical)

The 2026-09-29 source-use and TypeSafe account-use gates are in
`project-record/4-log/2026-09-29-source-approval-runtime-gate.md`. Earlier
checkpoints recorded 212 tests across 28 files and 208 tests across 27 files;
those counts have been superseded by the current review trace. Earlier browser
checks and reaction-window findings remain useful historical evidence, but do
not prove live Jev operation or readiness. Recent provider hardening preserves
row counts and malformed-response state for RSS, GDELT, Reddit, and Finnhub,
rejects non-advancing X pagination, exposes missing SEC mappings, validates
Yahoo chart payloads, and persists Finnhub history retries. Current and
historical limits remain recorded in the traces under `project-record/4-log`.

## Historical saved-data and pipeline verification snapshots

Saved-data UI verification snapshot (2026-09-28): the isolated production-build
smoke remains valid: its backup database contained 2,281 real source-backed observations, zero
simulation observations, and 2,281 pending judgments with Jev disabled; the
browser selected Adobe and drew its real Yahoo 7D chart. That smoke does not
establish the provenance of the separate default local database. A read-only
aggregate audit of that database found migrated `legacy_unknown` observations
with saved Jev judgments. The explicit simulation markers were absent, but
unknown provenance is not proof of real source data. The latest code now
rejects new observations or deliveries without a known collector, quarantines
legacy unknown rows from research reads, Jev dispatch/retry, source health,
aggregates, Radar, and current operational usage totals. Their saved token and
cost fields remain in the historical rows for audit; they are not represented
as current, source-identified usage. Historical rows remain untouched.

The prior process audit later found neither port 8787 nor the earlier 8794
smoke server listening. To verify the current UI without restarting collectors,
the app now supports `EXTERNAL_REQUESTS_ENABLED=false`: it skips SEC lookup,
all collectors and Jev, serves saved price history from SQLite, and marks the
UI as “SAVED DATA ONLY”. A production build ran against an isolated SQLite
backup of the real local database. A server-side guard recorded zero external
fetch attempts; browser resource inspection found no origin outside localhost.
The API returned 24 companies and 100 AAPL records from identified collectors,
with no `legacy_unknown` or simulation rows in that result; 7D chart history
returned 2,853 saved points. Playwright selected Adobe, confirmed the company
heading changed, and showed both sentiment and price lines. A later named
Playwright session confirmed the 24H local-store chart and opened a saved failed
judgment: the drawer explained that retries are unavailable while requests are
paused and exposed no retry action. That browser issued only loopback GETs; its
console had zero errors. At 390×844 the earlier browser check measured both
document and body widths at 390px. Screenshots are kept locally in
`output/playwright/2026-09-28-offline-adobe-chart.png`,
`output/playwright/2026-09-28-offline-drawer-chart.png`, and the earlier
`2026-09-28-offline-saved-data-mobile.png`.
Those 2,853 saved price points predate the price-lineage migration and are not
verified Yahoo history; the migration later classified them as
`legacy_unknown`, and current research/chart reads exclude them. That earlier
two-line screenshot must not be cited as verified price-data evidence.

The application now also defaults to saved-data-only mode when
`EXTERNAL_REQUESTS_ENABLED` is absent. The repeatable
`npm run verify:offline-startup` check starts the production server in a fresh
temporary directory with every provider credential present but unused, reads
health and company endpoints, confirms Jev retry is unavailable, and blocks
and counts outbound `fetch` calls. The latest run served all 24 configured
companies, showed every source/quote/Jev health counter disabled, returned 503
for the retry attempt, and observed zero outbound fetches. Its empty temporary
database contains no sample observations; it uses only the configured company
universe.

The same verifier now launches nine additional isolated app processes, one for
each source collector, with the global switch on and only that collector in the
source allowlist. It checks the matching delivery/health state and expected
request path while a preload intercepts global `fetch` before network access.
The Yahoo quote and chart routes are verified separately. All nine probes
passed without external network access or Jev credentials. These checks prove
request gates and routing; they do not establish source rights or provider
response correctness.

Live requests now require two separate controls: the global
`EXTERNAL_REQUESTS_ENABLED=true` switch and a non-empty
`EXTERNAL_SOURCE_COLLECTORS` allowlist. Yahoo quote and chart requests are
separate entries, and RSS polling schedules only the allowed feed collectors.
The Jev forwarding allowlist remains separate. This permits a later SEC-only
collection/evaluation path without starting publisher feeds or Yahoo market
requests whose endpoint-specific rights remain open.

The prior offline UI checkpoint passed 156 tests across 24 files; typecheck and
production build passed, with the existing Vite chunk-size advisory. The
failed-row drawer now hides retry controls until both external requests and Jev
are enabled, and its health-state helper has direct regression coverage. An
independent read-only review found no actionable defect. The original database
still has migrated `legacy_unknown` rows whose provider and model-use history
are unaudited; the latest code filters them from research views. Generated
examples remain isolated to tests and frozen evaluations; they are not product
data or real-source model-quality evidence. This is not a 10/10 release:
non-SEC publisher rights, TypeSafe account/telemetry/billing terms, exhaustive
source coverage, legacy provider-use reconciliation, and real-source
classifier quality remain open. The offline smoke proves the saved-data UI,
not live collection or real-source Jev quality. Evidence:
`project-record/4-log/2026-09-28-real-data-only-runtime.md`,
`project-record/4-log/2026-09-28-sentiment-desk-readiness-continuation.md`, and
`project-record/4-log/2026-09-28-legacy-source-quarantine.md`. Offline runtime
evidence is recorded in
`project-record/4-log/2026-09-28-offline-saved-data-runtime.md`; the evaluator
gates and their limits are recorded in
`project-record/4-log/2026-09-28-jev-evaluator-hardening.md`.

## Historical checkpoint snapshot (2026-09-29; superseded above)

The durable goal remains incomplete. The latest code checkpoint is pushed to
`origin/codex/real-data-rebuild` at `12472ec`, after the `76b46c2` scoring and
reaction-window checkpoint. Raw provider counts and malformed
rows are represented in delivery health for RSS, GDELT, Reddit, and Finnhub;
repeated X pagination tokens fail without advancing the committed cursor;
missing SEC ticker/CIK mappings are visible invalid deliveries; Yahoo chart
responses are validated before caching; Finnhub history retry state is durable
and its earnings cache replacement is atomic. The Health panel discloses recent
coverage, provider row counts, degraded errors, and configuration-off state.
Operational Jev usage totals include only identified-source rows, and the
header distinguishes local app connectivity from paused source collection.
Top Movers distinguishes missing current scores from a scored watchlist with
no prior comparison window. The watchlist uses alphabetical order and disables
its movement-sort control while every comparison delta is null; when some
deltas exist, missing rows sort last and equal magnitudes use ticker order.

The earlier outcome endpoint carried forward stale market prices and reported
them as reactions, often as 0.00%; the 30-minute hit-rate denominator could
also include observations that had only a four-hour result. This checkpoint
requires each price endpoint to be within five minutes of its target, keeps
30-minute and four-hour sample counts separate, and uses only timely 30-minute
observations for the directional hit rate. The watchlist-wide correlation is
explicitly descriptive and unclustered. The isolated saved-data preview showed
AMD's chart and selected-company state; its outcome panel read `30m n=41`,
`4h n=7`, and `hit 37%`, and disclosed `top 8 of 41 measured items`. The
browser console had no errors. At watchlist level, the current readback had
736 timely 30-minute prices among 2,732 items; item-level rank IC was 0.032.
This is an exploratory statistic, not evidence of Jev quality or prediction.

The current implementation passed 209 tests across 27 files, TypeScript typecheck,
production build, `git diff --check`, and `npm run verify:offline-startup`.
The verifier served 24 configured companies with all sources and Jev paused,
returned 503 for a retry attempt, observed zero outbound fetches, passed all
nine isolated source-allowlist probes, and rejected a mismatched Jev/source
allowlist. A production browser check selected AMD and showed the saved
sentiment/price chart from an isolated SQLite copy with requests paused. The
follow-up UI check selected AMD from the watchlist, showed 166 saved mentions,
and displayed the saved sentiment/price chart. It confirmed the alphabetical
fallback and disabled comparison-sort control while all 24 company deltas were
null, plus the truthful Top Movers empty state. At the 2026-09-29 00:09 UTC
preview readback, source-identified usage and estimated cost for the new UTC
day were both zero; an earlier snapshot showed 3,165 source-identified
judgments and $0.293 estimated input cost, a historical estimate rather than an
invoice. Saved source rows were about six hours old and external requests were
paused. This proves saved-data presentation, not current provider delivery.
Synthetic examples remain confined to tests/evaluations and are not product
data.

The goal remains incomplete and must not be reported as 10/10 or externally
operational. No provider or Jev request was sent for this checkpoint. Remaining
gates are TypeSafe account-owner authority and applicable use/telemetry/
retention/rejected-request billing terms plus an approved request/cost ceiling;
a valid `SEC_USER_AGENT` contact; rights for each non-SEC publisher source;
independent blinded real-source labels and a passing frozen Jev evaluation;
audit of historical `legacy_unknown` provider/model use and billing; and
source-coverage completeness. A local inventory of all nine real external
collector IDs now records their query bounds, pagination/cap behavior, health,
rights state, and missing direct source families. The Desk exposes these limits
through its expandable “Collection scope and gaps” disclosure; this closes the
local inventory review, not the external completeness/rights gate. Opportunity
Radar remains downstream until the remaining Sentiment Desk gates pass. See
`project-record/4-log/2026-09-29-source-scope-disclosure.md` for details.

## Prior durable goal state (2026-09-28)

The native ultragoal remains `active`. The saved-data-only UI, retry-gating,
and explicit external-request opt-in checkpoints are pushed to
`origin/codex/real-data-rebuild`; the latest implementation checkpoint is
`549ad800174bbb221c17bb3b6b8b33456d503ee0` (`feat(config): require per-source
request allowlist`). A fresh-process verifier proves the absent-variable
saved-data default makes no external requests, then checks each of the nine
individual source allowlists behind a global-fetch interceptor. Local
implementation and verification are recorded as complete for this iteration.
The active attention state is
`awaiting_authority`: the authorized TypeSafe account owner and applicable
source-rights owners must establish permitted use, retention, telemetry,
billing, and an approved request/cost ceiling; a valid SEC User-Agent contact
and independent human reviewers are also required. This goal will not issue
new source/model requests while those facts are absent. A later read-only
aggregate audit found legacy unknown-source rows with saved Jev judgments in
the default local database; their original payloads and billing history remain
unreviewed and they do not count as controlled quality evidence. Resume with
the real, rights-cleared SEC cohort and blinded labels only after those gates
and the available budget are documented. Then execute the frozen real-source
evaluator, verify the live pending-to-scored UI path, and re-evaluate the
remaining coverage/release gates. The exhaustive source-coverage review and
historical TypeSafe usage reconciliation are still open. Opportunity Radar
stays downstream until Sentiment Desk passes its operational gates.

The offline UI runtime is available on `127.0.0.1:8794` against a temporary
backup of the local database, with all external requests disabled. It is a
saved-data inspection session, not a live collector or Jev runtime. Failed-row
retry actions are hidden until health confirms both Jev and external requests
are enabled. The original database was not changed. This checkpoint passes
156 tests across 24 files, typecheck, production build, the fresh-process
saved-data startup check, all nine guarded collector-startup probes, the named
loopback-only browser check, and independent read-only reviews of retry and
source gates.

Fresh application launches now default to saved-data-only mode. The Compose
configuration follows the same default, and live provider traffic requires
`EXTERNAL_REQUESTS_ENABLED=true`; the live Compose smoke script opts in because
its purpose is to verify public-source delivery. Source permissions, account
authorization, spending, and independent real-source labels remain separate
gates before that opt-in is appropriate.

## User and outcome

The user is a single researcher running a private local desk. They select a
company, inspect source items and Jev judgments, then decide what to investigate.
Phase 1 makes that workflow durable, source-attributed, time-honest, and
operational in the local application. Phase 2 adds an inspectable, narrowly
scoped comparison on that persisted evidence.

Jev remains the authority for the sentiment and event category of every
company-related source item. Deterministic application code owns source
identity, freshness, score post-rules, and later cross-item calculations.
Opportunity hypotheses, value-chain links, and counter-evidence remain separate
from Jev's per-item sentiment and event-type judgments. The first Radar release
does not generate opportunity hypotheses or value-chain links.

## Phase 1: make Sentiment Desk operational

- Keep the product local, single-user, read-only toward markets, and
  live-data-first. The application runtime has no demo or synthetic-data mode.
- Retain the existing public news, GDELT, SEC, quote, and optional Finnhub,
  Reddit, and X paths. Add configurable RSS/Atom feeds only if needed to make
  the live research workflow useful without arbitrary page scraping.
- Store one source-attributed record per company-related item. Exact replays
  are idempotent; separate publishers are not erased by title similarity.
- Keep source publication/filing time, provider observation time, retrieval
  time, and local ingestion time distinct. Missing source time stays unknown.
- Distinguish successful delivery from the age and completeness of the data
  delivered. Surface stale, delayed, unknown, and failed states through the
  same API/UI the researcher uses.
- Preserve Jev's fixed current rubric, model, cost, latency, and fail-closed
  behavior. Missing keys leave items pending. A storage migration must not
  requeue older scores or create historical model charges.
- Keep raw source bodies only where the source contract allows it. Record the
  strongest permitted response/item provenance and say whether replay uses raw
  input or only normalized local records.
- Verify real local collection, Jev behavior, dashboard operation, restart
  persistence, Docker build/run, and desktop/mobile rendering before Phase 2.
  A 2026-09-28 hardening pass also verified acknowledged failed-judgment retry
  and stale SSE/snapshot recovery at desktop and 390px widths. The ten-case
  synthetic evaluation and source/account rights gates remain separate and
  are not release evidence.

## Phase 2: Opportunity Radar on the operational base

- Compare current and prior equal-duration company evidence windows using the
  event taxonomy already assigned by Jev. Group exact-normalized headline
  copies and show each source row; this is not event identity or narrative
  clustering.
- Use Jev's item judgments as the sentiment inputs. Keep source records and
  event identities separate so syndicated copies do not count as independent
  publishers, and preserve opposing evidence.
- Keep direction disagreements, timestamps, source identity, and feed coverage
  visible. Do not represent category volume, source count, or sentiment as proof
  of alpha, causation, or investment merit.
- Keep later social, search, app-store, hiring, market-structure, and
  value-chain inputs out until supported data contracts, rights, and protected
  evaluations exist.
- Do not scrape App Store reviews, YouTube/podcasts, search trends, or arbitrary
  sites where a supported API, rights policy, and usable credentials are
  absent. Never present a missing feed as evidence of no activity.

## Shared boundaries

- Source code stays public without a LICENSE file, as the user chose. The
  README must state that repository visibility does not grant reuse or
  redistribution rights.
- The application remains local and single-user. No hosting, purchase,
  provider enrollment, publication, PR, or external message is authorized.
- The currently authorized GitHub checkpoint is the existing branch
  `codex/real-data-rebuild`.
- Do not use the Citrini, Meridian, or Porch container profiles. Use a new
  task-specific Docker profile for verification if one is needed.

## Phase 1 acceptance criteria and evidence

1. Docker Compose builds and starts the checked-out application with real
   source collectors, and SQLite survives container recreation.
2. Keyless public collectors deliver real observations through the local API.
   With Jev disabled, those observations remain pending; with Jev configured,
   one valid judgment follows the unchanged rubric and appears in the drawer.

   - Model identity hard gate: send the configured alias unchanged. For
     `jev-latest` or `jev-preview`, accept only a successful response whose
     `model` is a canonical versioned Jev ID (`jev-<major>.<minor>.<patch>`);
     retain that returned ID as the persisted judgment engine. When a
     versioned model ID is configured, require exact response equality.
     Continue rejecting malformed IDs, unrelated models, invalid answers,
     probabilities, or usage, and never automatically resubmit an
     outcome-unknown request.
   - Evidence: unit fixtures must prove alias request/response compatibility,
     exact pinning, unrelated/malformed response rejection, and one request
     per judgment. HTTP 429 and TypeSafe's documented HTTP 529 overload
     rejection must use the existing bounded persisted retry path; generic
     5xx and transport failures remain outcome-unknown. A permitted
     new-observation smoke must prove successful provider response, persisted
     resolved-model provenance, and visible judgment without replaying
     existing outcome-unknown rows.
   - Current repair gates (2026-09-27; evidence:
     `project-record/4-log/2026-09-27-jev-alias-version-compatibility.md`):
     - `PASS` — alias, pinned version, malformed/wrong model, 429/529 retry,
       generic 5xx/transport failure, and persistence fixtures; `npm test`
       passes 74 tests across 11 files.
     - `PASS` — one live TypeSafe request on a newly inserted synthetic
       observation resolved `jev-latest` to `jev-1.13.0`; a temporary SQLite
       row retained that model and rubric, the local API returned it, and the
       browser drawer displayed the score and exact resolved model.
     - `PASS` — the isolated smoke used a temporary database and made no
       public-source requests; no existing failed/outcome-unknown row was
       loaded or replayed.
     - `NOT RUN` — a controlled, rights-reviewed public-source-to-Jev
       evaluation with labeled quality review. An older loopback runtime later
       reported many failed Jev attempts, but its submitted payloads and
       provider usage were not audited; see the 2026-09-28 runtime follow-up.
       SEC's public-filing reuse basis is now documented, but SEC_USER_AGENT
       is not configured and TypeSafe account authorization, telemetry,
       retention, and permitted-use terms remain unreviewed. The synthetic
       smoke proves integration only, not classifier accuracy or calibration.
3. A duplicate delivery does not create another Jev charge. Two independent
   source records with similar headlines remain separately attributable.
4. Missing publication or observation time is never replaced by retrieval
   time. The API and UI show source time separately from collection time.
   - Current source-time regression (2026-09-28): Reddit `created_utc` is
     optional in the provider response; an absent or invalid value remains
     `null` through poller ingestion rather than becoming Unix epoch zero.
5. Provider failure, malformed data, restart, and stale-but-successful
   delivery leave prior evidence intact and visibly degraded.
   - Current-source finding (2026-09-28): GDELT returned plain-text content
     for some HTTP-200 requests and HTTP 429 for others. The adapter must
     reject non-JSON bodies without turning them into article records, report
     a bounded error, and preserve prior source evidence. Regression tests
     cover non-JSON bodies, provider rate limits, and valid ArticleList JSON.
   - Current result: `PASS` — GDELT non-JSON input is rejected with a bounded
     error, HTTP 429 remains a rate-limit failure, and valid ArticleList JSON
     normalizes. The current live source state shows HTTP 429; no post-fix live
     HTTP-200 non-JSON response was observed.
   - Cooldown result (2026-09-28): `PASS` — the poller stops the current
     company sweep on its first HTTP 429, persists a source-wide retry time,
     honors `Retry-After`, applies bounded exponential fallback, skips without
     emitting fake deliveries, and resumes cleanly after expiry. Tests cover
     restart persistence, corrupt cooldown state, recovery, and reset after
     success. See `tests/gdelt-poller.test.ts` and
     `project-record/4-log/2026-09-28-sentiment-desk-readiness-continuation.md`.
   - Cross-collector rate-limit result (2026-09-28): `PASS` — RSS, Yahoo
     quote/chart, SEC, Finnhub, Reddit, and X preserve provider reset guidance,
     stop the affected sweep, and persist a bounded source-wide cooldown.
     Yahoo quote/chart 429s are not retried inside the request; identical
     simultaneous chart misses share one in-flight request. Default RSS and
     quote cadence and RSS concurrency were reduced, with provider request
     starts paced. Tests use mocked responses and do not call providers. See
     `project-record/4-log/2026-09-28-sentiment-desk-readiness-continuation.md`.
   - SEC text-integrity result (2026-09-28): `PASS` — when an EDGAR filing has
     no primary-document URL or its document cannot be fetched, no
     metadata-derived fallback sentence is sent to Jev. The filing is omitted
     from scoring, the delivery is recorded as `partial` with a generic
     explanation, and the regular poll can retry. A poller-level regression
     proves both missing-text cases create no Jev inputs while an actual
     fetched excerpt still enters the normal pipeline.
   - Additional hard gate: a GDELT HTTP 429 stops the current company sweep,
     persists one source-wide next-attempt time across process restarts,
     honors a valid `Retry-After` value, and otherwise uses bounded exponential
     cooldown no shorter than the configured poll interval. Cooldown skips do
     not create empty/success deliveries or article rows. A successful resumed
     request clears the consecutive-failure state. Deterministic tests must
     prove sweep termination, bounded growth, restart persistence, cooldown
     expiry, successful recovery, and continued operation of unrelated
     collectors.
6. Desktop and narrow-screen flows let the researcher select a company, read
   the score/index, inspect the source and Jev rubric, and understand data
   health without hidden overflow or dead controls.
7. `npm test` (123 tests across 21 files), typecheck, production build, fresh
   keyless local start, 390px and 1280px browser passes, accessible mention
   drawer interaction, SSE shutdown, and isolated Docker persistence smoke
   pass. The source-data contract records what these checks prove and what
   remains unavailable.
8. Selecting a ticker from the tape, watchlist, or movers updates the selected
   company and its chart without blanking the app. With no completed Jev
   judgments, the UI shows price-only history and states that sentiment is
   unavailable; with no valid chart data, it shows a clear empty state. Verify
   multiple tickers in the running browser and inspect runtime errors and the
   resulting company/chart request.

   - User/job: the local researcher selects a company and inspects its recent
     sentiment and price history.
   - Constraint: preserve the selected time window, exact company identity,
     provider timestamps, and stale/cache labels; never invent sentiment or
     price observations, carry a quote into a later time bucket, or extend a
     window silently.
   - Assumption: a company with no completed Jev judgments is a supported
     state; unscored source evidence must not prevent price history or
     company navigation.
   - Hard gates: ticker control updates the company header and requests the
     matching `/series` and `/price`; the price API rejects a ticker that does
     not belong to the requested company; no previous company's chart remains
     visible under the new header while loading; no browser runtime error;
     empty Jev data
     produces an explicit no-score state while valid price data remains
     visible. The price API returns only real provider observations whose
     source timestamps fall inside the selected window, unchanged and in
     order. A stale-only response has no drawable values but retains its real
     latest-source timestamp for the stale label. No chart observations
     produces an explicit unavailable state.
   - Measure/evidence: browser click across at least two companies, matching
     API request/response and visible header, a negative mismatched-ticker API
     request, zero console errors, and chart state matching the returned source
     observations. Proxy limit: this verifies UI wiring and payload handling,
     not market-data accuracy or Jev quality.
   - Failure cases: all-null sentiment, stale but valid price history, stale
     observations outside the selected window, failed chart request, and
     fewer than two drawable points.
   - Subjective copy choice: explain missing sentiment as “No Jev scores in
     this window” and retain source-age detail near the chart.
   - Subjective interaction choice: when the selected window contains no
     source price observation but an older real quote exists, keep the range
     unchanged and offer an explicit action to view 7D history.
   - Prior-build hard-gate results (evidence:
     `project-record/4-log/2026-09-27-stock-chart-selection-fix.md`):
     - `PASS` — ADBE→NVDA selection returned matching 200 `/series` and
       `/price` responses and displayed NVDA on the latest built asset.
     - `PASS` — all-null sentiment with 97 valid NVDA price observations
       rendered the price line, explicit no-score state, source-age label, and
       zero runtime/console errors on a fresh browser reload.
     - `PASS` — empty history, one-point history, 503 price failure, and
       recovery each showed the expected state; recovery returned 200 from the
       local API.
     - `PASS` — a 390px viewport had no horizontal overflow.
   - Boundary: the deliberate failure and empty-history cases use Playwright
     response overrides to exercise UI recovery; normal selection and recovery
     use the live local API. This does not verify price accuracy or live Jev
     scoring.

   - Newly discovered issue and current pass (2026-09-28; evidence:
     `project-record/4-log/2026-09-28-real-data-only-runtime.md`):
     - `PASS` — the old price endpoint repeated 97 Friday-close values in a
       weekend 24-hour window. The corrected API returns only source-timestamped
       observations inside the requested window and preserves the actual
       out-of-window source timestamp as metadata.
     - `PASS` — on the fresh real-source run, ADBE 24H returned zero points
       with latest source time 2026-09-25 20:00 UTC; the browser showed an
       honest empty state and an explicit “View 7D source history” action.
     - `PASS` — selecting that action and selecting ADBE updated the window
       and company. ADBE 7D returned 67 source points, 67 distinct prices,
       spanning 2026-09-21 13:30 UTC through 2026-09-25 20:00:01 UTC; the
       browser drew the matching Yahoo series and showed “No Jev scores in
       this window.”
     - `PASS` — a mismatched AAPL ticker on Adobe's company ID returned HTTP
       409; no previous company's line remained under the new company header.
     - `PASS` — fresh browser console had no errors or warnings.

9. The application runtime admits and displays only source-collected company
   observations and provider-origin Jev judgments. No synthetic generator or
   simulated judge is available to the app. Legacy simulation rows remain
   preserved in SQLite but are excluded from consumer APIs, aggregates,
   retry scheduling, and usage. Real source items without an authorized Jev
   judgment remain pending with their provenance and timing intact.
   - User/job: the researcher investigates actual, attributable observations
     without fabricated stories, fabricated sentiment, or synthetic counts.
   - Hard gates: the application has no demo/synthetic runtime or UI mode;
     ingestion rejects the reserved simulation collector; persisted legacy
     simulation rows cannot enter the tape, company views, Radar, counts,
     automatic or operator retry path, or provider usage; test fixtures never
     leave isolated test databases; the live UI displays real source URLs and
     quote provenance.
   - Evidence: focused database/API regression tests, live API readback from a
     fresh isolated database with Jev and optional credentials explicitly
     disabled, and browser selection of ADBE with Yahoo quote/chart provenance
     and real RSS/SEC mention rows; no runtime errors.
   - Proxy limit: this proves origin/provenance boundaries for the tested
     path. It does not resolve source/model-use rights, data completeness,
     quote accuracy, or Jev classification quality.
   - Current result: `PASS` — the post-restart isolated database held 1,361
     real observations (1,119 Google News RSS, 241 Yahoo Finance RSS, and 1
     SEC EDGAR), zero simulation observations, zero simulated judgments, and
     1,361 pending source-backed judgments. ADBE API rows retained real URLs;
     browser rows showed “awaiting judgment.” Jev was disabled with zero
     health failures and zero usage. See
     `project-record/4-log/2026-09-28-real-data-only-runtime.md`.

10. Every company-dependent result shown with the selected ticker stays bound
   to that company's identity and relevant window. Selecting a new company or
   window must not leave the prior company's outcome summary or mention cards
   under the new header while data loads or after a request fails. Cached data
   may appear only under its matching company/window; failed reads must be
   labeled rather than presented as an empty result.

   - User/job: the researcher moves between companies and trusts that the
     visible mentions and forward-reaction panel belong to the selected name.
   - Constraint: preserve per-company and per-window identity through pending,
     success, failure, and out-of-order response states; retain the existing
     per-company outcome refresh throttle without blocking a new company.
   - Assumption: a matching result cached for the same company/window may be
     shown while its refresh is pending; another company's result may not.
   - Hard gates: after switching between two tickers, mentions and outcome
     results match the selected company; a deliberately delayed earlier
     response cannot replace current content; failed and pending mention reads
     have distinct, truthful UI states.
   - Measure/evidence: click two tickers in the live local browser, inspect
     matching `/mentions` and `/reactions` API responses and visible labels,
     then delay an earlier response and verify it cannot change the active
     company's content. Proxy limit: proves client selection/data binding, not
     correctness of the reaction calculations or source completeness.
   - Failure cases: delayed prior-company response, a recent cached result
     followed by a company/window change, and mention request failure.
   - Subjective copy choice: pending/failure copy should explain missing data
     without implying that the company has no evidence.
   - Current-build hard-gate results (evidence:
     `project-record/4-log/2026-09-27-stock-chart-selection-fix.md`):
     - `PASS` — NVIDIA `/mentions` returned only `companyId=nvidia`,
       `/reactions` identified ticker NVDA, and the visible outcome heading
       matched NVDA.
     - `PASS` — changing 24H→6H requested NVDA `/reactions?hours=6` and kept
       the outcome heading bound to NVDA.
     - `PASS` — delayed Adobe `/mentions` and `/reactions` responses did not
       replace NVIDIA content; a delayed Adobe series carrying a distinctive
       0.99 sentinel also left the NVDA no-score chart unchanged.
     - `PASS` — a controlled mentions 503 showed the failure state, then a
       retry through the live local API returned 200 and cleared the failure.

11. A newly retrieved quote is never presented as current when its exchange
    observation time is materially old or unknown.
    - User/job: the researcher compares companies using prices with visible
      timing and provenance.
    - Constraint: retrieval time and exchange observation time remain
      separate; a successful network fetch does not refresh an older market
      observation.
    - Assumption: with quotes polled every 45 seconds, an observation older
      than 15 minutes is visibly aged; a missing observation timestamp is
      visibly unknown.
    - Hard gates: aged or unknown quotes show source age or unknown timing in
      the ticker tape, watchlist, and selected-company header. A cached delivery
      retains both its last retrieval age and its original source time.
    - Measure/evidence: fresh-start browser with actual provider data, selected
      company state, the quote API payload and UI labels. `quote-age.test.ts`
      verifies the 15-minute boundary and unknown-time copy. Proxy limit: the
      age label does not prove the provider's market-price accuracy or rights.
    - Current result: `PASS` — the live API returned an exchange observation
      at 2026-09-25 20:00:01 UTC and a retrieval on 2026-09-28; the rebuilt
      browser visibly showed “source 2d ago” for ADBE in ticker tape, watchlist,
      and selected-company header.

12. With no configured Jev key, newly collected real observations stay
    pending without a failed judgment, a fabricated default score, or repeated
    health failures. The desk still reports that scoring is disabled and
    source delivery continues independently.
    - User/job: the researcher can collect real evidence before configuring
      Jev, without confusing unavailable scoring with rejected or failed work.
    - Constraint: an absent scoring engine must never make a provider request,
      update a score-attempt status, or increment Jev failure counters.
    - Hard gates: real collector rows remain `pending` with no score/error;
      explicit disabled status remains visible; Jev request and usage counts
      stay zero; repeated delivery does not generate scoring attempts.
    - Measure/evidence: null-judge unit/API regression plus live keyless
      browser/API readback and health snapshot after a clean backend restart.
      Proxy limit: proves only the unconfigured-engine path, not Jev model
      quality or provider access rights.
    - Failure case: fresh pending items repeatedly cycle through a failed state
      or appear as Jev errors while the engine is disabled.
    - Current result: `PASS` — after the fix, the post-restart source database
      held 1,361 pending real judgments, Jev health was disabled with 0
      successes, 0 failures, and no last error, usage was zero, and real source
      deliveries continued. The null-judge regression verifies there is no
      score attempt or synthetic fallback. See
      `project-record/4-log/2026-09-28-real-data-only-runtime.md`.

13. A configured Jev credential alone never authorizes forwarding every stored
    publisher item. The runtime fails closed unless the operator explicitly
    configures an allowed collector set and a finite request budget; new
    observations, pending drains, retries, and recovery paths all enforce the
    same admission policy. The default allowlist is empty. No pending backlog
    drains on startup or by timer while no collector is admitted. Budget
    exhaustion leaves source evidence pending and visible, without fabricated
    failures. A source-specific admission setting is an operator assertion,
    not proof of legal rights; record the exact source basis and account-use
    authorization separately before a real-source Jev quality run.
    - Current source finding (2026-09-28): the SEC Webmaster FAQ states that
      public EDGAR filing content is free to access and reuse, and SEC website
      policy permits copying/further distribution without SEC permission.
      SEC fair access caps traffic at 10 requests/second across machines; the
      app paces one process at 8 starts/second. `SEC_USER_AGENT` is not
      configured in this checkout, so live SEC collection remains off. Google
      News RSS, Yahoo endpoints/publisher snippets, GDELT-linked publisher
      text, and optional X/Reddit/Finnhub content remain unapproved for Jev
      forwarding. TypeSafe's current MCA permits broad perpetual use of
      derived telemetry, including classifications, consumes credits per
      submitted input, and restricts using its service/output to develop a
      similar or competing service. The account owner must confirm that the
      intended app use, telemetry terms, and rejected-request billing are
      acceptable. Details are recorded in
      `project-record/3-project-specs/live-data-etl.json`.
    - Current result: `NOT RUN` — no real source content was sent to Jev.
      Real-source label quality, TypeSafe account authorization, telemetry
      acceptability, retention and billing, SEC User-Agent configuration, and
      non-SEC source rights remain unverified.
    - Admission implementation result (2026-09-28): `PASS` — Jev dispatch is
      off by default and requires a key, explicit collector allowlist, and
      finite per-UTC-day request/body-byte caps. A SQLite transaction claims
      the eligible real row and reserves its budget atomically; duplicate or
      hidden rows cannot spend budget. Retry, scheduled drain, and ingestion
      use the same admission rules. Hard maxima are 100 attempts and 400,000
      serialized input bytes per day. Tests cover default-off behavior,
      allowlist enforcement, concurrent claims, restart persistence, corrupt
      counters, and exhausted budgets. This implementation does not clear
      source rights or account authorization and no real source was sent.

### Real-source Jev evaluation contract (prepared; blocked before execution)

This is the frozen evaluation design for determining whether Jev's existing
per-item labels are reliable enough for the desk. Synthetic fixtures do not
enter this evaluation and cannot satisfy any of its gates.

- **Scope:** The first cohort is actual public SEC EDGAR filing observations
  from `sec_edgar`, limited to content covered by the documented EDGAR reuse
  policy and the application’s actual normalized Jev input. It evaluates
  company-specific `sentiment` and `event_type`, plus the existing `about` and
  `investor_relevant` inclusion boundaries. The result does not generalize to
  Google/Yahoo/GDELT publisher text, social feeds, other media, market impact,
  or investment performance. Add another source only after its exact rights
  and retention/model-processing path are documented and cleared.
- **Pre-run gates:** No source text is sent until the authorized account owner
  confirms the current TypeSafe agreement, permitted Sentiment Desk use,
  telemetry, retention, account limits/auto-refill, and rejected-request
  billing; any ambiguous similar/competing-product restriction is resolved.
  Configure a descriptive SEC User-Agent and keep the evaluation allowlist to
  `sec_edgar`. Confirm a request and spending ceiling against the account's
  current pricing/settings. The application's request/byte maxima are safety
  limits, not spending authorization. Keep label creation local; do not send
  source text to a second model or hosted grader.
- **Population and sampling:** Freeze a timestamped snapshot of eligible,
  source-backed SEC observations with source IDs, accession numbers, company,
  filing type, separate filing and acceptance times, collector/parser version,
  excerpt digest, and SHA-256 of the exact normalized Jev request body
  (`{model,state,questions}`). Deduplicate to the filing/company unit, group
  related observations by accession and issuer for sampling and uncertainty
  estimates, and document exclusions before model output is visible. Preserve
  provenance for every eligible filing plus the eligible and selected counts
  for each filing-type/calendar-quarter stratum. The evaluator verifies a
  deterministic SHA-256 rank sample within every declared stratum, using the
  frozen seed and no Jev scores. Run a blinded label-only pilot to estimate prevalence and
  reviewer disagreement. Then calculate the final sample size from the frozen
  decision, observed prevalence/variance, issuer-level dependence, class
  coverage, and the approved cost ceiling. Target 95% interval half-widths of
  at most 5 percentage points for overall exact agreement and 10 points for
  each class the release claim covers. Freeze sample IDs, random seed, rubric
  hash, analysis code, thresholds, and budget before any Jev output is opened.
  If the available corpus or budget cannot meet those precision targets, report
  the affected claims as `UNVERIFIED`, not as a pass. The blinded pilot may be
  included only if it follows the same sampling and labeling protocol.
- **Independent labels:** Two independent qualified human reviewers label
  each selected item while blind to Jev output. They use the fixed product
  rubric and the source material permitted for this study to label company
  relevance, investor relevance, directional business implication, and
  dominant event type. Do not use Jev or another model as a reviewer. Preserve
  both raw labels and short evidence-grounded rationales; adjudicate
  disagreements without deleting either original label. Report
  pre-adjudication reviewer agreement so weak or ambiguous ground truth is
  visible. Attach each label to the observation ID, accession, source URL,
  company, item/excerpt digest, exact request-body digest, separate filing and
  acceptance times, production `strictAbout` identity decision, labeler, and
  adjudication record.
- **Measures:** For sentiment and event type, report the complete confusion
  matrices, per-class precision/recall/F1, macro-F1, exact agreement, and
  comparison with a source-cohort majority baseline. Estimate intervals with
  resampling clustered by issuer/filing rather than treating syndicated or
  same-filing items as independent. For `about` and `investor_relevant`, report
  false-inclusion and false-exclusion rates at the unchanged production
  cutoffs, per item: `about >= 0.50` and `investor_relevant >= 0.35`, or
  `about >= 0.80` and `investor_relevant >= 0.50` for the strict ambiguous-
  identity path. For sentiment probabilities, report multiclass Brier score and
  reliability by confidence band; call calibration `UNVERIFIED` if support is
  too sparse. Report eligible-item completion, all terminal failures and
  unknown outcomes, request count, provider-reported tokens, latency, estimated
  cost, and the exact model/rubric/code/data digests. Provider token estimates
  are not an invoice. No aggregate may conceal a weak class or a missing
  source/time slice.
- **Decision rule:** Pass the scoped cohort only when both primary tasks have
  macro-F1 of at least 0.80 with a cluster-aware 95% lower confidence bound of
  at least 0.70; every claimed class has at least 0.70 precision and recall
  point estimates and enough support to meet its interval-width target; the
  cohort has at least 30 issuer clusters and each claimed class appears across
  at least 10 issuer clusters; and performance exceeds the majority baseline with a confidence interval that
  excludes no improvement. `about` and `investor_relevant` must each achieve
  at least 0.90 precision at the current production cutoff, with recall and
  class support reported. Any unrepresented class, failed privacy/rights gate,
  unexplained missing case, model/rubric mismatch, duplicate request, or
  unknown-outcome request without provider-usage reconciliation fails the
  release gate. Calibration is a separate claim and must not be called
  verified from accuracy alone. These thresholds evaluate a research-triage
  label, not a trading signal.
- **Stop and reporting:** Stop on unexpected data egress, a rights/account
  ambiguity, budget exhaustion, repeated provider errors, model/rubric drift,
  or an outcome-unknown request. Do not automatically replay unknown outcomes.
  Store a redacted, access-limited report in the project record with the frozen
  manifest digest and per-case terminal status; do not commit source excerpts,
  credentials, or account identifiers. A passing EDGAR cohort is a scoped
  result, not general Jev certification or completion of other source rights,
  coverage, or historical usage gates.
- **Current state:** `BLOCKED` — this design is prepared, but no real source
  text has been sent to Jev and no independent real-source labels exist.
  Current blockers and evidence are tracked in
  `project-record/3-project-specs/live-data-etl.json`.

### Offline evaluator implementation (2026-09-28)

`npm run evaluate:jev-labels -- --labels <local-json>` produces a blinded,
label-only pilot report. Add `--run <local-json>` only for a frozen `stage=final`
label set. The CLI reads local JSON only and makes no network, source, database,
or model calls. Its strict schemas reject raw source text and unrecognized
fields. A final run must join the exact label-artifact digest, sorted
provenance-manifest digest, rubric SHA, frozen code revision, item IDs, each
exact request-body digest, and analyzed model-run artifact digest. The label
set carries and hashes the complete provenance-only eligible population frame,
the sampling window, and per-stratum
counts; parsing checks that selected labels are a deterministic seeded sample
from that frame and cover every declared eligible filing-type/time stratum.
The manifest binds SEC CIK/accession/URL, filing and acceptance times,
collector/parser versions, excerpt digest, exact request digest, and the row's
strict-identity setting. The tool reports two-reviewer agreement before
adjudication, class prevalence, complete confusion matrices, missing outputs as misses, boundary precision and
recall, provider usage, costs as estimates, latency, and a per-case terminal
status ledger without copying rationales or source excerpts into the report.

Final labels must freeze an account-owner budget attestation before the sample
freeze: a maximum request count, maximum estimated USD cost, exact input/output
unit rates, approval time, and a digest of the approval record. The run must
match those rates; missing token usage leaves cost compliance `UNVERIFIED`, and
request or estimated-cost overruns fail. The local tool can validate the
attestation's shape and timing but cannot verify the underlying account-owner
approval or provider invoice. Each sampled observation permits at most one
submitted Jev request, so a second call after a response or rejection is
rejected during input validation.

The model-run digest identifies the exact analyzed JSON but does not
authenticate a TypeSafe receipt or independently verify the caller-supplied
scores and token counts. Preserve separately auditable provider records before
treating a classifier `PASS` as evidence about live Jev performance.

`about` and `investor_relevant` report the mixed-cohort results for context,
but the standard and strict-identity paths each have their own precision gate.
Each path needs at least 10 positive human labels across 10 issuer clusters;
otherwise that path stays `UNVERIFIED`. This prevents a strong standard-path
aggregate from hiding errors on ambiguous identities.

The final report uses 2,000 deterministic percentile-bootstrap replicates,
resampling issuer CIK clusters. Overall agreement needs a 95% interval no wider
than 0.10; class precision and recall intervals need widths no wider than
0.20. The 30-issuer overall and 10-issuer-per-class floors prevent degenerate
bootstrap samples from being presented as verified precision. The frame is a
provenance artifact, not proof that upstream SEC collection was complete; that
limit remains explicit in the report. The tool does
not auto-select a final sample size from the pilot: the issuer design effect,
eligible class coverage, account-owner-approved request/cost ceiling, and
available corpus must be documented and frozen before model output is opened.
Calibration remains descriptive because no calibrated-probability acceptance
threshold has been frozen. Even a scoped classifier `PASS` cannot clear rights,
account, retention, billing, User-Agent, source-coverage, or release gates.

## Phase 2 acceptance criteria

The initial Radar code and local acceptance were completed before the current
phase order was reaffirmed. This is historical evidence only: the current Desk
operational gate is not passed, so no further Radar work or promotion is in
scope until it is.

The first-release contract is frozen before implementation in
`opportunity-radar-acceptance.md`. It defines the current/prior windows,
publisher/headline proxies, every evidence field, missing-time behavior,
coverage status, hard gates, measures, scenarios, and subjective review points.
The implementation uses persisted Jev judgments and makes no second model
call. The contract's test, API, type, build, browser, and final isolated Compose
recovery gates passed.

## Independent readiness review and hardening gates

Three read-only reviewers completed a fresh pass after hardening. Their
separate qualitative ratings were 8.5/10 for source operations and overall
scoped readiness, 8.5/10 for local Jev implementation (7/10 for release
readiness), and 9/10 for UI/Radar. A later fresh-context Jev review rated
release readiness 7/10 after confirming the alias and synthetic integration
path; it kept real-source rights/retention and representative classifier
quality open. These are qualitative judgments, not a composite score or proof
of quality. The current checks directly verify:

1. Malformed Jev choice answers, invalid probabilities, and invalid token usage
   must fail closed; no default category or clamped probability may become a
   stored judgment. Keep the rubric and classifier identity unchanged.
2. Transient Jev exhaustion must have a bounded, persisted recovery path. Honor
   a valid provider `Retry-After` delay when present and otherwise use
   exponential backoff. Bad credentials and invalid model output must not
   retry forever; restart and recovery must not duplicate judgments or charges.
3. Scheduler shutdown must await in-flight collection before SQLite closes.
4. Radar evidence pagination must use the exact overview time and ingestion
   snapshot so page totals and groups cannot drift while the view is open.
5. The 390px company picker works with keyboard and assistive technology; the
   mention drawer traps focus, isolates the background, and restores focus on
   close.

The baseline issue on 2026-09-27 was an alias/version mismatch:
`jev-latest` was sent unchanged, TypeSafe returned `jev-1.13.0`, and the old
client rejected it. That repair is complete: the resolved model is persisted
and the isolated provider→SQLite→API→browser path passed. See
`project-record/4-log/2026-09-27-jev-alias-version-compatibility.md` for the
current evidence. This historical mismatch is not an open bug.

The remaining local operations gap is terminal-failure recovery. A failed
judgment must expose an operator-controlled retry that makes a new request only
after a clear acknowledgement that provider usage may be charged. An
outcome-unknown request is never automatically replayed; the UI must tell the
operator to check provider usage before authorizing another attempt. A duplicate
submission must not queue two requests. Do not retry corrupt stored judgments.

The live synthetic Jev integration smoke proves protocol compatibility and
storage/UI wiring only. A frozen, fictional case set will probe obvious
sentiment/event categories and the existing namesake/sector/consumer boundaries.
Retain every case result and report the exact resolved model, rubric hash,
case-set digest, code revision, usage, cost, latency, and failure state. These
synthetic cases are a sanity check, not representative real-source labels,
accuracy/calibration evidence, or an investment-quality claim. No real
publisher text is to be sent to Jev until its source rights and the account's
retention terms are reviewed. Release readiness also remains gated on provider
billing semantics and those source/account terms.

## 2026-09-28 continuation acceptance

### User, workflow, and constraints

The local researcher opens a failed mention, understands whether the provider
may have processed it, then decides whether to send one new Jev request. Jev
remains the only authority for per-item sentiment and event category. Keep the
rubric, post-rules, market-read-only behavior, no-license decision, and existing
source evidence unchanged. The evaluator uses only fictional synthetic items
in temporary SQLite and never reads or modifies `data/desk.db`.

### Hard gates

1. A retry is available only for a failed, non-corrupt judgment. It requires an
   explicit operator confirmation that each submitted Jev input consumes
   provider credits and a new request may consume another; for an
   earlier request that did not produce a saved score, the confirmation also
   requires a provider-usage review because 429/529 billing semantics are not
   documented. No UI or server path automatically retries an outcome-unknown
   request.
2. The server performs a single atomic failed→pending transition. Duplicate or
   stale retry requests cannot queue another call; retrying, scoring, scored,
   off-target, and corrupt rows cannot be requeued.
3. The normal persisted pipeline performs the authorized retry. Its resolved
   response model and rubric provenance remain visible. Provider rejection,
   unknown outcome, and recovery remain distinct after the request.
4. The frozen synthetic evaluation runs through the actual Jev client and
   persisted pipeline on a fresh temporary database. No case is silently
   skipped or replaced. It records per-case output and terminal status, exact
   response model, rubric SHA, source/case digest, code revision/dirty state,
   request count, tokens, estimated cost, latency, and errors without secrets.
5. Evaluation cases are all fictional and human-labeled before the first model
   result is read. They cover seven unambiguous in-scope directional/event
   cases plus three boundary cases: an ambiguous namesake, a sector-level item
   mentioning the company only in passing, and non-investor consumer coverage.
   Pass the synthetic sanity check only if all seven clear cases match both
   expected sentiment and event type, both out-of-scope cases score `about <
   0.5`, and the consumer item scores `investor_relevant < 0.5`. Report every
   label and boundary result separately. This ten-case synthetic pilot is not
   a production classifier-accuracy or calibration gate.
6. `npm test`, typecheck, production build, and the browser retry workflow pass;
   browser checks cover desktop, confirmation/cancel behavior, and
   outcome-unknown quarantine; the separate API tests cover duplicate
   submission and rejected-request recovery. Keep the retry panel within the
   viewport at 390px.

### Objective measures and limits

- Hard-gate completion is independent per item; one failed recovery or case
  cannot be hidden by an aggregate score.
- Report exact sentiment/event matches on the seven clear cases and separate
  pass/fail on the three boundary cases. The pilot informs whether a gross
  rubric or serving defect is present; its small synthetic sample cannot
  support claims about production accuracy, calibration, alpha, or real-world
  value.
- Record end-to-end latency and cost for the complete per-case run, including
  bounded retries. Do not rerun unknown-outcome failures.

### Representative failure/recovery cases

- An SSE judgment update for an already-loaded mention replaces the matching
  item in the tape, company list, and open drawer without changing other
  companies' rows.
- Retry confirmation cancelled: zero calls and the original failure remains.
- Two retry submissions race: at most one persisted transition and one new
  provider call.
- A prior unknown-outcome failure: no automatic resubmission; a new request can
  start only after the explicit usage-check acknowledgement.
- Any submitted request that ends without a saved score, including an explicit
  429/529 rejection, requires provider-usage review before a deliberate manual
  retry while billing semantics remain unverified.
- A new explicit 429/529 rejection: existing bounded retry semantics remain;
  terminal state and next operator action stay visible.
- A manually accepted retry that reaches the byte budget before dispatch stays
  pending and emits that persisted state to the desk's event listeners; no
  provider call is made for the over-budget input.
- A valid `Retry-After` delay: the persisted retry is not scheduled earlier
  than the provider's requested time; absent or malformed headers fall back to
  bounded exponential backoff.
- A company mentions response captured before a new Jev SSE event but returned
  afterward cannot replace the newer event in the company list.
- An initial tape snapshot captured before a new Jev SSE event but returned
  afterward cannot replace the newer event in the tape.
- Invalid output or malformed persisted judgment: score is withheld and a
  corrupt row has no retry control.
- Off-target/namesake and sector-only synthetic items remain separate from
  unambiguous sentiment/event cases; do not hide them in the aggregate.

### Subjective review point

Keep retry language calm and explicit in the current dark desk design. Show the
source and failure reason next to the control; make the charge warning clear
before the operator authorizes a new request.

### 2026-09-28 continuation gate status

- `PASS` — focused route/pipeline tests prove missing acknowledgement does not
  send a request, unknown and rejected submitted attempts require usage review,
  a successful acknowledged retry persists Jev's returned model, concurrent
  requests admit one retry, and scored/corrupt rows cannot be requeued.
- `PASS` — valid integer and HTTP-date `Retry-After` values are parsed;
  malformed values fall back to exponential backoff, and the persisted retry
  is not scheduled early.
- `PASS` — an isolated SQLite/API regression reproduces a manual retry whose
  exact serialized input no longer fits the remaining byte budget. The row
  stays pending, no additional Jev call is sent, and the SSE stream receives
  the persisted pending state so an open drawer does not retain its old failed
  view. A registered Hub listener receives the exact mention payload.
- `PASS` — loopback browser workflow used a temporary SQLite database and an
  in-process synthetic judge. Cancel left the failed item intact; after the
  two required acknowledgements, one request changed it to scored. The open
  drawer, company list, and tape showed the SSE judgment. Both a company-list
  response and the initial tape response captured before the SSE update were
  delayed for two minutes; after each stale snapshot arrived, the new score
  remained visible. A separate local API read returned HTTP 200 with the
  persisted `scored` judgment and `synthetic-jev-fixture` label. No external
  Jev call or real-source text was used in this browser check.
- `PASS` — 82 unit/API tests across 12 files, typecheck, and production build.
- `PASS` — Playwright browser at 390×844 opened the retry confirmation and
  completed one synthetic retry. The drawer fit within the viewport, document
  width remained 390px with no horizontal overflow, both acknowledgements
  gated Send, the resulting score appeared in the open detail drawer, and the
  console reported zero errors or warnings. The accepted local retry endpoint
  returned HTTP 202. Temporary SQLite and an in-process fictional judge only.
- `PASS — synthetic sanity only` — all ten frozen fictional cases reached a
  terminal state in ten requests. All seven clear direction/event labels and
  all three boundary thresholds passed; returned model was `jev-1.13.0` with
  the frozen rubric hash. The ledger is
  `project-record/4-log/2026-09-28-jev-synthetic-sanity.json`; this is not
  production accuracy, calibration, alpha, or release-readiness evidence.
- `OPEN` — non-SEC publisher rights for retention/display/model processing,
  TypeSafe account authorization/telemetry/retention and rejected-request
  billing semantics, configured SEC User-Agent, and representative
  real-source Jev quality are external release gates.

## Grounded architecture

The current flow is `server/schedule.ts` pollers -> `Pipeline.ingest` and
`Pipeline.scoreOne` in `server/pipeline.ts` -> SQLite in `server/db.ts` -> the
read-only API/SSE in `server/app.ts` -> `web/src/App.tsx` and its evidence
components. `server/rubric.ts` owns Jev's fixed contract. `server/scoring.ts`
validates that judgment and owns deterministic impact, weight, event strength,
exclusion, and index math.

At the starting baseline, the `mentions` row coupled source item and score,
cross-source titles were destructively merged, missing source times could be
filled locally, and startup could re-score completed judgments. The implemented
observation/judgment ledger, persisted delivery receipts, and read-only
compatibility projection remove those failure modes. The source design is
documented in `sentiment-desk-phase1-architecture.md`; Radar is a separate
Phase 2 consumer.

## Historical work log (earlier phase acceptance)

The checked items below preserve the earlier implementation history. They do
not mean the current Sentiment Desk operational goal or release gates passed.
At the time of this historical work log, the goal was blocked; see the current
status at the top of this document. Opportunity Radar code from the earlier
phase remains parked until the Desk gates pass.

- [x] Read project records and compare them with current branch/code.
- [x] Trace source collection, Jev persistence/API, and dashboard workflow.
- [x] Confirm the user's phase order and Jev authority.
- [x] Compare the ledger and mention-row architecture options; choose the
  smallest Phase 1 design that keeps each source item attributable.
- [x] Fix item identity and time semantics; preserve score history without
  automatic rescore.
- [x] Record provider deliveries and expose delivery/freshness state.
- [x] Add meaningful regression tests and update README/project records.
- [x] Verify local keyless live data, Jev fixture behavior, desktop/mobile
  browser UI, and isolated Docker persistence. A later permitted synthetic
  provider smoke resolved `jev-latest` to `jev-1.13.0` and verified persistence
  and rendering; public-source-to-Jev remains unrun pending source/account
  rights review.
- [x] Freeze Phase 2 inputs and acceptance after the Phase 1 gate passed.
- [x] Build and verify Opportunity Radar over persisted judgment records.
- [x] Finish local hardening verification: 74 tests across 11 files,
  typecheck, production build, fresh browser pass, and isolated Compose
  live/recovery smoke.
- [x] Checkpoint the earlier Phase 1/2 reviewed implementation (`b9b6528`).
- [x] Checkpoint later chart reliability and Jev alias repairs
  (`a685c2a`, `4996759`) with evidence updates (`c4004cb`, `c636736`) to
  `origin/codex/real-data-rebuild`.
- [x] Add and verify acknowledged operator retry for failed judgments, while
  keeping outcome-unknown requests out of automatic retry; require usage review
  for submitted failures while rejected-request billing is unresolved.
- [x] Freeze ten human-labeled fictional Jev cases and a per-case isolated
  pipeline runner.
- [x] Run and record the ten-case synthetic Jev pilot; report every case
  without promoting it to real-source quality evidence.
- [x] Add saved-data-only production mode, verify stock selection and the
  sentiment/price chart against persisted records, and suppress failed-row Jev
  retry actions until external requests and Jev are confirmed enabled.
- [x] Record 156 passing tests, typecheck, production build, named browser
  network evidence, an independent retry-gating review, fresh-process
  saved-data-only startup proof, and the source-specific request allowlist.

## Current continuation state — 2026-09-30

The native goal is active because the user asked to continue. This continuation
adds a reproducible saved-data API capacity verifier and its package command;
the app's server behavior is unchanged. The check measures the real saved
database through an isolated online-backup clone, confirms that external
collectors and Jev are disabled, and records latency without a pass threshold.
The corrected eight-worker workload interleaves routes; repeated local runs
varied, so the measurements do not establish a general capacity limit. Exact
database/build hashes, workload results, advisor disposition, and boundaries
are in `project-record/4-log/2026-09-30-local-read-capacity.md`.

The full objective remains incomplete. No Jev request or human evaluation was
performed. The existing evidence gaps still include account-owner confirmation
of TypeSafe use, telemetry, retention, billing, limits, and spend ceiling; a
contact-bearing SEC User-Agent; two independent blinded real-source reviewers
and a passing frozen Jev evaluation; provider usage evidence for the 4,700
`legacy_unknown` rows; and endpoint-specific rights and finite-coverage
evidence. The user's rights statement remains an operator attestation. Keep
Opportunity Radar disabled until the Sentiment Desk acceptance gates pass.

## Agent-upgrade handoff reconciliation — 2026-10-01

The source-backed handoff keeps the current single-item classifier architecture
and does not justify a framework migration. Reconciled against the current
code, the saved database, and the frozen evaluation contract:

- **Already met:** each admitted source observation receives at most one
  immutable Jev judgment; exact same-collector replays are idempotent; content
  revisions are retained separately; persisted delivery receipts gate new
  observations; ambiguous-company rules and deterministic post-rules are in
  code; scoring claims reserve the bounded daily budget atomically; and the
  local queue and operator retry behavior have regression coverage.
- **Current work:** the real-data-only saved-data API capacity check and the
  five-check frozen-source gate both pass. The keyless live smoke persists a
  real source item across container recreation, but Jev remains disabled in
  that smoke. It does not prove live classification quality or useful alerts.
- **Open:** the real-source label cohort, two independent human reviewers,
  account-authorized Jev run, baseline/model comparison, per-dimension
  usefulness and calibration, and the real observation-to-alert path. The
  default local database contains only three `sec_edgar` observations from one
  company, below the frozen evaluation's 30-issuer minimum. The separate
  database read found 1,864 same-company exact-normalized-title groups across
  5,304 identified observations; 569 groups cross collectors. These are
  headline matches, not verified event identities.
- **Conditional:** evaluate exact-headline grouping or other event identity
  only on a frozen, independently reviewed real-data task. Preserve every
  source row, keep disagreement visible, and do not change index weights
  without a separate versioned policy experiment. Market-reaction tests must
  keep first-available time and incomplete price coverage explicit; they do
  not establish alpha or causation.
- **Superseded or out of scope:** a graph/framework rewrite, additional model
  calls, and Opportunity Radar expansion are not prerequisites for this
  milestone. The existing research graph proposal is not adopted for a
  one-observation classification task.

The next complete milestone is a rights-cleared, SEC-only Jev evaluation with
at least 30 issuer clusters, two blind independent human labels per item, and
the existing frozen rubric, sample, cost, and class-support checks. It must
compare Jev with a deterministic baseline, then verify saved judgments in the
actual company/feed UI and measure alert precision and missed material events.
Before any Jev request, obtain authorized account-use, telemetry, retention,
limit, refill, billing, and spend evidence; a descriptive SEC User-Agent
contact; qualified reviewers and their label artifact; and provider records
for the 4,700 historical `legacy_unknown` rows. Continue authorized local
work while those inputs are unavailable; the latest native goal status is
recorded at the top of this plan. Do not replace them with synthetic
observations or model-generated labels.

### Handoff quiz

1. **Current task and preserved work:** complete the local, real-data-only
   Sentiment Desk before expanding Opportunity Radar. Keep the fixed rubric,
   immutable per-observation judgments, delivery receipts, deterministic
   post-rules, bounded scoring queue, fail-closed states, and existing UI.
2. **Evidence, finance, permission, and publication owners:** the frozen ETL
   `verify`/`check` and actual consumer path own source and persistence proof;
   `rubric.ts` and `scoring.ts` own classification contract and deterministic
   post-rules; source allowlists and finite atomic Jev budgets own request
   admission. A model proposes labels only. The researcher retains all
   investment decisions, and configured alerts do not authorize trades.
3. **Decisive falsifier and comparison:** once authorized, follow one real
   observation through receipt, Jev output, persisted judgment, selected-company
   feed/chart, and alert handling. A wrong entity, duplicate request, missing
   judgment, stale or missing source time, lost restart state, or missed
   qualifying alert falsifies success. Compare Jev with a fixed deterministic
   baseline under the existing blind-label and budget contract.
4. **Conditional inputs:** public-source rights are the user's attestation;
   exact endpoint terms are not independently reviewed. TypeSafe account-use
   and spend authority, SEC contact, two qualified human labelers, sufficient
   real-source issuer coverage, and provider records for legacy usage remain
   absent. No Jev request, additional provider call, or framework migration is
   authorized by the handoff.

## Current continuation update — 2026-10-04

The user's later direction selects OpenAI GPT-6 Luna for new classifications
and preserves historical Jev records. Their direction replaces independent
human labels with blinded independent subagent labels for the active evaluation;
agent agreement remains diagnostic evidence, not human ground truth or proof of
population quality. Opportunity Radar remains disabled until the Sentiment Desk
passes its operational gates.

The user attests to rights for public sources and APIs. The attestation is
recorded in `project-record/3-project-specs/live-data-etl.json`; it is not
independent verification of each endpoint's terms. One bounded local run on
October 4 collected real data through Google News RSS, Yahoo Finance RSS,
Yahoo quote and chart, and GDELT. It added 1,118 receipt-linked observations,
all pending, and 1,584 price points plus 21 new quote points. GDELT returned a
failure and a rate limit. No classifier or alert request was made. The exact
receipt, source-time, restart, and replay evidence is in
`project-record/4-log/2026-10-04-local-verification.md` and the private local
artifact named by `TRACE-20261004-sentiment-desk`.

This collection milestone does not satisfy the completion predicate. Luna has
no direct API key or verified finite account budget, the real-source Luna run
artifact is absent, the 4,700 legacy-unknown price rows remain quarantined, and
the small-cap discovery, fundamental research, linked historical lineage, and
observed investor/analyst outcome gates remain open. The selected-company UI
now serves recent real pending evidence and saved Yahoo price history in
offline mode, but no fresh rendered-browser proof was available because the
in-app browser rejected the local URL.

## Current usability follow-up — 2026-10-04

The user asked that remaining work prioritize changes that improve real
investor use. The view displays the SEC filing date as a calendar date while
acceptance and retrieval retain their actual times. The annual revenue chart
labels its unit-aware linear range and offers a keyboard-accessible table of
source-returned values, units, and reported precision. It withholds the plot
when metric or unit consistency fails. Empty states do not gain fabricated
points.

Precision metadata is optional and never inferred. When missing, comparisons
remain arithmetic on returned values and percentage change is withheld. Invalid
metadata withholds the comparison; declared precision uses a conservative
two-value bound before describing a change as directional. The table no longer
labels returned values “exact.” Fictional source-shaped rows exist only in
isolated technical tests and temporary databases; they never seed or render in
the product and do not count as real-source evidence.

The whole-suite/build validation and fresh independent review are still being
completed. A real populated SEC response has not been rendered in the active
Desk because this process lacks its own SEC contact identity; local tests do not
satisfy live-source or full-product acceptance. Higher-priority usability gaps
remain tickerless discovery, evidence tied to business drivers and
counter-evidence, live Luna operation, price-lineage reconciliation, broader
source coverage, and observed investor task outcomes. Opportunity Radar stays
off.

The analyst queue's set-aside action now removes a source from the default
selected-company scan while retaining it in local evidence summaries, the
historical tape, charts, and source counts. A visible company-feed control
reveals set-aside records, and the source drawer restores them. Disposition
updates travel to connected clients without analyst notes, so live/reconnect
paths cannot put the row back into the working scan. This is a focused scan
efficiency improvement, not a resolution of the broader usability or
operational acceptance gaps.

## Current usability evidence — 2026-10-05

Trace: `TRACE-20261005-usability-path`. The rendered saved-data path was
verified against the actual isolated app, not just component tests. “Model
material” discloses that its Jev threshold and Luna flag are model criteria,
not independently validated findings. The held-match review button opens the
retained history with a specific identity-screen explanation and real-source
attribution. The historical Jev chart is switchable, explicitly six days old,
and distinct from the empty Luna chart. No demo or synthetic observations were
introduced. Exact browser evidence and local preview identity are in
`project-record/4-log/2026-10-04-issuer-review-usability.md`.

This improves source review and signal interpretation; it does not make the
Desk complete. Current small-cap discovery, fresh market prices, live Luna
operation, provider and legacy-usage reconciliation, and uncoached investor and
analyst outcomes remain open. `engineering_gate.py check` has no bound evidence
receipt, and the code-bound live-data ETL check remains FAIL. The current
independent whole-build review remains about 4/10. Opportunity Radar remains
disabled.

## 2026-10-05 chart navigation acceptance — clarified 2026-10-06

On the saved-data Desk, Luna is the current classifier and stays selected while
its matching company/window snapshot is pending, failed, mismatched, or has
eligible classifications. After a successful zero-category Luna result, make
one bounded local lookup for the same company's newest saved Jev week. If that
archive is populated, keep the current Luna view selected and show a deliberate
Historical Jev action with the exact saved UTC week, score count, and latest
score timestamp and age. Open the chart only after an explicit action or tab
selection. Keep the saved-source recovery action first. Never present archived
output as current Luna sentiment, independent investor opinion, prediction,
or share-price return.

The historical view states its full UTC week, latest score timestamp and age,
and the matching Luna category count for the selected rolling evidence window.
The 6H/24H/3D/7D controls continue to filter current source evidence; they do
not change the fixed UTC Jev week. A deliberate tab choice remains authoritative
for the selected company through polling, window changes, and late responses;
switching companies resets to automatic selection. When Jev is chosen before
its archive has been checked, load the latest saved week and show pending,
unavailable, empty, and retry states honestly. The saved-source-feed action
remains the first recovery step in Luna's empty state. Verify the rendered
company transition and archive with retained real data, plus 320px/390px
layouts without horizontal overflow. Do not create or display demo data.

## 2026-10-05 Historical Jev archive access

The Historical Jev action opens the newest UTC week containing eligible saved
real Jev scores, even when those scores fall outside the current 7-day window.
The chart states its exact UTC date range, the latest eligible score timestamp,
and its age. Older and newer controls navigate between populated weeks, and a
latest control returns to the newest one. Each request is bounded to one
half-open UTC week and bucket evidence remains bound to the selected company,
week, score snapshot, and exact 15-minute bucket. Empty intervals remain gaps.
This archive read is local-only; it does not alter the Luna, source-feed, price,
or other global time windows and makes no source or model request. Historical
price comparison stays unavailable unless it can be read from verified saved
prices for the exact same week. Loading, error, no-history, stale-snapshot, and
recovery states remain distinct. Keyboard navigation and narrow layouts are
required. Acceptance uses the protected local database plus isolated boundary,
eligibility, request-race, and pagination tests; no synthetic or demo data may
appear in the running app.

The history request is either `latest` or one canonical UTC Monday week. A
response carries `{ companyId, weekStartMs, fromMs, throughMs, points,
latestEligibleScoreAtMs, olderWeekStartMs, newerWeekStartMs, latestWeekStartMs
}`. The accepted read covers at most one half-open seven-day interval. A chart
and every bucket request use that exact response identity; bucket pages also
retain their existing snapshot hash, impact-band, and cursor identity. Only
eligible real Jev rows determine the latest score, chart bars, and populated
week navigation. The chart range is state separate from the existing global
`windowHours`.


## Cross-company saved-source context recovery — 2026-10-06

When an investor opens a saved row in its issuer Desk and closes its detail,
returning to Saved Sources preserves the current search, company filter, and
loaded-result position for the current tab. This prevents repeated
cross-company triage and applies whether the source review switched issuers
or stayed on the current issuer. Preserve the existing read-only request
boundary. Verify a real search result and a later page in the rendered app
through the full open-return journey; a component remount test is supplemental
evidence.

## Private-company narrative scope — 2026-10-08

The shared v1.0 private-company research specification is integrated as the
separate scope record in
`project-record/3-project-specs/private-company-narrative-slice.md`. The current
Desk slice is public-source narrative context inside existing listed-issuer
evidence. It does not add a private-company coverage universe, claim extraction,
private financial data, or thesis alerts. The new scope record maps present,
partial, missing, inapplicable, and unverified capabilities and defines the
real-source acceptance needed before runtime support. No SEC/Compose, source,
account, retention, or spending gate is changed; the wider private-company
workflow remains unimplemented and unqualified.
