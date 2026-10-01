# October 2 recovery and acceptance pass

The independent review found two actionable local defects: first-evidence recovery
accepted an HTTP-success company response even when it still contained no saved
history, and the 390px header clipped the clock outside its visible bounds.

The recovery controller now clears pending work only when the applied company
snapshot contains saved source history. Its observer runs on the history poll,
so applying a stale snapshot cannot create an immediate retry loop. Selected
mention and evidence pages refresh once on first arrival. The reused full
backend snapshot also reads its bounded rolling tape, quotes and health on
recovery; this is not a company-only request. Header spacing and text adapt to
narrow screens, and the redundant header clock is hidden below the small-screen
breakpoint while saved-data and connection status remain visible.

Root integrated isolated worker commits b6c84b5, c7d6ea4 and 0c0c08d as
90863a4, 3ca4552 and64dd4e1. The integrated focused suite passes29 checks in
five files; typecheck, production build and diff hygiene pass. Controller
regressions distinguish stale HTTP-success, failure, caught-up application,
no repeated first-arrival feed revision and later retry. Fixture results prove
controller behavior, not real market observations.

Actual Codex in-app browser checks on the rebuilt candidate establish:

- 390x844: document width390, rightmost visible header edge382; phone company
selection updates NVIDIA heading, actual historical chart and saved evidence.
- 1440x900: document width1440; selected NVIDIA, 7D window, real historical Jev
chart and three supporting headlines are visible together. Headline bottoms
are638,693 and748px; chart canvas ends at496px. These are old saved records,
not current market facts or new Luna output.
- Desktop stock click and native J/K move between NVIDIA and Oracle. The chart's
keyboard table opens a real saved bucket and its source record/detail drawer.
The selected historical item explicitly shows an unlinked receipt and a saved
Finnhub provider URL; publisher identity and source time are not invented.
- The fresh isolated database initially returns zero eligible observations;
history HTTP503 is shown as unknown rather than confirmed empty. On recovery,
the actual archived SEC example is separately inspectable and supplies no chart.
- One maintained Tesla Yahoo RSS cycle stores13 identified real observations
linked to one actual version3 delivery receipt. No constructed source records,
Jev outputs or Luna outputs are inserted. Scoring stays pending.
- The fault proxy replays an exact previously returned empty companies response
at first arrival. The next15-second history poll retrieves Tesla history,
without reloading selected evidence pages. The archive disappears.
- A separate fault phase fails every company read with HTTP503. History polls
retry every15 seconds while retaining saved research, then normal HTTP200 and
real read-only POST lookup restore state automatically. The stale warning
clears. No provider or model request is made by the served API.

The initial GET-only verification proxy omitted the application's read-only
POST lookup and therefore caused a legitimate stale warning. The partial
artifacts remain; the final proxy forwards only that bounded lookup path and
its successful recovery is separately recorded. The first-arrival trace's
second company503 belongs to the spark reader and is not claimed as a failed
backend snapshot. The separate all-company-failure phase supplies that proof.
Private runtime manifests bind source revision64dd4e1, executable hash, exact
source/receipt records, API states, browser captures and proxy event logs.
Main data/desk.db is not modified by these UI/recovery observations.

A fresh bounded local read run on the protected online backup of data/desk.db
identifies c2d9e982 and the unchanged server bundle. It reads12,509 observations,
12,509 judgments,101,032 receipts and69,316 price points. Source DB/WAL hashes
match before and after, copied core counts and SQLite integrity pass, and
outbound guard attempts are zero. Default workload:96 serial reads in4,315ms,
96 eight-worker interleaved reads in2,004ms, and24 company-series reads in46ms.
All24 first-page mention checks return2,301 identified rows. Mixed-route p95
is233-247ms. The health report's row count denotes SSE clients; it is not a
health-record count. This short saved-data run is not sustained, multi-tenant,
write, production capacity or an SLO claim. Later UI-only changes do not alter
the measured server executable, database or read paths.

Pstack autonomous-run and feature guidance route this pass; personal acceptance,
data-pipeline and AI-evaluation preserve the existing real-data, no-demo and
bounded-evidence requirements. No new architecture or financial calculation is
introduced. Root owns contracts, records, runtime, integration and Git; one
writer uses the reused investor-ui worktree, with read-only independent review.
Worktrees separate checkout state, not filesystem access. Public Data Hub guide
and locator were read and its loopback health returned200; no profile expansion,
refresh, provider-client migration or source freeze change was performed.

The requested Sol/xhigh advisor recommends freezing all18 unused retained SEC
cases as a separate exhaustive diagnostic extension if more reference coverage
is pursued. Those inputs have no established negative stratum. This pass does
not select cases by desired label, modify the original30-case pilot/references,
or attribute fresh labels to old reviewer identities. New API qualification
remains blocked by absent direct OpenAI credentials/account budget evidence,
missing actual classifier outputs/usage reconciliation, and missing required
three-class reference coverage. Product value, sustained scale and broad live
operation remain unverified; Radar stays disabled. Original pilot/source bytes
remain intact. Independent whole-build review and final scoped ETL results are
recorded separately; local repairs do not turn full acceptance into a pass.

Independent engineering-bullshit-detector review passes the scoped recovery,
phone layout and desktop first-screen repairs and retains full-build FAIL for
missing live Luna and required reference coverage. It independently recomputes
all20 runtime-proof artifact hashes after the observer and guarded API stop;
zero mismatches remain. Observer tab, proxy and guarded API were owned and are
closed/stopped; the saved-data preview remains available. These results are
bounded engineering evidence, not an arbitrary10/10 endorsement.

The final source/docs freeze requires fresh scoped ETL verify/check and reviewed
GitHub readback. The gate owns its separate receipt with exit statuses and
fingerprint. Native alignment retains blocked/unverified full acceptance; a
local repair cannot waive the real-source Luna criterion or authorize release.
Source staging and push exclude private normalized source data, observer logs,
credentials, databases, dependencies and generated builds. Existing GitHub
visibility is PUBLIC and permission ADMIN; no visibility/access change, merge
or deployment is performed. The exact pushed SHA is established by readback,
not an embedded self-referential commit identifier.
