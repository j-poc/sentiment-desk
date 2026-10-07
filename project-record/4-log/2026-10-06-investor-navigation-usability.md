# Investor navigation usability — 2026-10-06

## Acceptance exercised

The company selector must cause an observable research transition from every
company-oriented view. A selected company must appear in the Desk, with its
name and available saved evidence visible at the top. Loading historical chart
data must never move the reader away from that company. Reopening Desk for the
already selected company also returns to the top. Same-company background
updates preserve the current reading position. These checks use only the
existing retained records; no demo or synthetic product rows were added.

## Defects repaired

1. Completing a historical Jev chart lookup could scroll the Desk away from
   the selected issuer heading. The automatic reveal was removed; intentional
   chart-tab navigation still reveals the chart. A company change resets the
   research pane to the top.
2. From **My Research**, the desktop watchlist and mobile picker changed the
   selected-company state while leaving the queue on screen. All company
   selection routes now persist and open **Desk**, including watchlist clicks,
   mobile selection, keyboard navigation, Top Movers, and queued-evidence
   opening. Entering Desk resets the pane even when the selected company did
   not change.

## Rendered proof

Verified in the local app at `http://127.0.0.1:8797/` using the in-app browser
on 2026-10-06:

- From **My Research**, the mobile company picker selected Adobe and visibly
  changed to Desk with an Adobe heading, the saved historical chart, and 17
  retained source rows. The chart disclosed 51 saved Jev records across 20
  populated buckets; the interface identified the archive as historical and
  not current Luna analysis.
- From **My Research**, the desktop watchlist selected Apple and visibly
  changed to Desk with the Apple heading and its saved evidence.
- The page reported **SAVED DATA ONLY**, connected local app status, Luna
  paused, and no source records retrieved in the prior 24 hours. No provider
  or classifier call was triggered by these UI checks.
- Regression checks cover a different-company selection, same-company refresh,
  same-company entry into Desk, a missing scroll region, and the navigation
  route transition from My Research.

## Verification and limits

- After the final route-navigation patch: full Vitest suite **695 tests across
  92 files passed**. The focused navigation/chart/research queue suite also
  passed **16 tests across 4 files**; `npm run typecheck` and production build
  passed.
- A scoped live-data gate run at `2026-10-05T22:44:47Z` recorded fixture,
  failure/recovery, replay, offline-request, storage, inbox protocol, and inbox
  failure checks as PASS. It recorded
  `authorized_keyless_live_smoke` and
  `sec_filings_current_hub_receipt` as FAIL. The smoke did not establish a
  current accepted feed observation; the local current SEC Hub receipt was not
  available. This run predates the final UI route patch and must be refreshed
  before using its code fingerprint as final evidence.
- The independent whole-build reviews still rate the complete product as not
  ready. This navigation repair does not supply current GPT-6 Luna labels,
  source-backed no-ticker small-cap discovery, saved filing facts, a complete
  followed-company change conclusion, usage reconciliation for quarantined
  `legacy_unknown` rows, or uncoached intended-user outcome evidence. Keep
  Opportunity Radar disabled and do not call the product complete or 10/10.
- GitHub checkpoint, secret scan, final contract alignment, and the fresh
  engineering/ETL evidence receipts are recorded after their final runs below.


## Cross-company source triage recovery — 2026-10-06

### Observable acceptance

From Saved Sources, searching a real retained record, opening it in its issuer
Desk, closing its detail, and returning to Saved Sources preserves the search
query. The same path preserves an explicit company filter and the number of
loaded rows. It performs no provider or classifier request. Search and paging
must recover from component remounts within the current browser tab.

### Rendered verification

Used the built application through the in-app browser at
`http://127.0.0.1:8797/`. Searching `McDonald` returned one of the 60 locally
retained real records; its card showed Walmart attribution, publisher/feed
time, separate retrieval time, pending judgment, and a title/link relevance
warning. Opening the exact row showed its saved request receipt, stored
publisher/host, excerpt, and collector path in the Walmart Desk. After closing
the detail and reopening Saved Sources, the `McDonald` query and one-of-one
result remained. A separate pass selected Walmart, loaded 24 of 45 saved rows,
opened a row from the second page, returned to Saved Sources, and observed the
Walmart filter plus `Showing 24 of 45 loaded matches` still selected.

The UI exposed saved-data-only mode, zero source records retrieved in the prior
24 hours, and zero Luna requests. This path did not fetch data, start a model
request, or modify research records. The focused regression and state-boundary
unit checks passed, the current web bundle was rebuilt, and the final whole-app
review and gates remain pending. This proves navigation recovery only; it does
not prove current market-wide coverage, current classifications, or readiness
for investment decisions.

## Independent investor-task review and current source proof — 2026-10-06

Two independent read-only reviewers assessed the whole app around investor
outcomes rather than visual polish. Their highest-priority finding is a cold
start failure: `/api/companies` contains only the fixed 24-company roster, the
reviewed roster has no source records retrieved in the prior 24 hours, and
`/api/sec-filings-inbox` is `unsupported` with collection unavailable because
the connected Hub does not implement `sec.latest_filings_8k`. Saved Sources
searches bounded evidence for companies already in the Desk; it cannot discover
market-wide or small-cap candidates. The no-ticker workflow therefore does
not work yet.

The selected-company route and source-open/return recovery work in the rendered
app, but current evidence is insufficient to decide whether a company merits
research: there is no current source retrieval, selected-company filing facts
are absent, and the fundamentals panel does not interpret business drivers,
materiality, persistence, or counterevidence. Followed-company capture and
comparison expose newly eligible saved evidence, not an interpreted material
change. Their current copy correctly disclaims that conclusion. Saved-source
freshness labels, publisher/retrieval clocks, relevance cautions, and return
state are useful for inspecting retained evidence; this is the strongest
verified investor path, but it does not compensate for missing coverage.

The live-data gate run on 2026-10-06 passed fixture, failure/recovery, replay,
offline-request, bounded keyless live smoke, storage, inbox protocol, and inbox
failure checks. The actual keyless smoke used only the five declared RSS, quote,
and chart feeds. `sec_filings_current_hub_receipt` failed: no accepted Hub
receipt exists for the unsupported all-filers 8-K dataset. The connected Hub's
implemented SEC submissions profile is CIK-scoped, and the pinned shared
connector package has no approved all-filers feed route. An app-local SEC
client would bypass the shared ingestion and policy boundary, so the desk keeps
the visible unsupported state and does not synthesize candidates.

This is a product/data blocker, not a visual-design opportunity. Completion
requires a separately qualified shared PID/Hub all-filers connector, permitted
private analyst display, configured SEC fair-access identity, and a fresh
accepted live receipt. The current saved-evidence journey remains available;
Opportunity Radar stays disabled. Independent reviewers estimate overall
investor-task readiness at about 4/10 and do not support a 10/10 or complete
claim. No provider or classifier call was made by these reviews.

## Chart meaning and selected-company recheck — 2026-10-06

The current Luna chart remains the automatic view. When its matching saved
snapshot is empty, the user sees an honest empty state plus a separate
Historical Jev action that gives the score count, exact UTC week, and age before
opening that archive. The October 5 design note also records an earlier
candidate that automatically opened a saved Jev chart after a confirmed Luna
empty result. The active version-2 engineering contract and latest model
direction keep Luna primary; an archive with unlinked source receipts should
not take the place of the selected current classifier. The explicit action
still makes the real archive inspectable without presenting it as current
sentiment. This choice favors a truthful current-data state over avoiding one
deliberate chart click.

After a full page reload in the built local app, Apple opened on Luna. The
rendered view said there were no saved GPT-6 Luna classifications, that this
does not mean neutral sentiment, and that new classifications were paused. Its
separate archive action disclosed 245 scores, the UTC week
`[2026-09-28, 2026-10-05)`, and a latest score seven days old. Clicking it opened
the labeled Jev histogram with 32 populated buckets. The chart says bars group
model completion time, repeated coverage can count more than once, empty
intervals stay blank, and the scores are not price returns or validated
investor opinions.

Opening Apple's 09:45–10:00 UTC interval returned 50 scored records with a
weighted mean of −23.2 impact points and observed record spread −100 to +97.
The full-interval detail showed 44 normalized titles, 11 records in repeated
title groups, and 0/50 delivery-receipt links. Jev completed these scores from
09:50 to 09:59 UTC while source/feed timestamps span the prior evening to
09:51 UTC. These values are real stored model outputs, but the plotted bar is
not a 15-minute measurement of investor or publication sentiment; batching,
repeated coverage, and unverified source-to-delivery linkage materially limit
its interpretation. Reopening the bucket loaded its evidence and removed a
stale interval message left in the earlier hot-reloaded browser session. A
clean reload restored the Luna-first state. The archive-versus-rolling-refresh
regression remains covered by `series-chart-state.test.ts`.

The same rendered pass selected Adobe from the watchlist. The page changed to
Adobe Desk, displayed its 17 saved records as pending Luna judgment, and showed
a separate dated action for 51 historical Jev scores. No classifier or source
request was made. The independent `engineering_bullshit_detector` whole-build
review remains **FAIL**: it agrees that company selection and source inspection
work, but finds no-ticker discovery and current research evidence missing. It
recommends an automatic historical fallback because the October 5 note
proposed that behavior; two earlier focused reviews and the active engineering
contract favor Luna-first with an explicit archive action. This pass retains
the contract's safer current-classifier default and records the disagreement
instead of turning a displayed archive into current sentiment.

The full native suite passed **730 tests across 93 files**. The retained
`investor-ui-recovery` replay passed 9 tests, and the typecheck and production
build pass on this candidate. These checks prove code and the inspected
navigation path; they do not qualify source lineage for the 50-record archive,
provide current Luna judgments, or establish investor outcome quality. The
current dataset displayed here is stale, the saved-source count retrieved in
the prior 24 hours is zero, all-provider requests are paused, and only the
fixed 24-company roster is available. The separate whole-build review remains
about 4/10. Exact final ETL and engineering receipts and the GitHub checkpoint
must be recorded after this trace and candidate are frozen.

## Usability priority and reference access — 2026-10-06

The acceptance target is investor task completion, not visual novelty: (1) find
a company worth investigating without first knowing its ticker; (2) inspect
fresh, provenance-linked evidence for a selected company; (3) distinguish
current Luna judgments from old Jev history without a misleading signal; and
(4) return from a source detail to the same company, query, and reading
position. The rendered saved-data proof supports only tasks 3 and 4, and task 3
only as a clearly dated archive. It does not establish tasks 1 or 2. The
highest-value remaining work is a permitted, current broad-market discovery
feed through the shared Public Data Hub, followed by live Luna classification
on rights-cleared inputs; chart decoration or another empty-state control will
not unblock those investor jobs.

Mobbin was opened in the Codex in-app browser on 2026-10-06. The requested
finance-app discovery URL redirected to its public landing page, which offered
Log in/Join for free and described Finance+ as a paid plan. It did not show
product screens or a usable analyst journey; the public Explore navigation
attempt timed out. Reference research is `BLOCKED`. No sign-in, purchase, or
unsupported reference claim was made. The current rendered Sentiment Desk flow
and the user's supplied dashboard examples are the available design evidence;
because this continuation changes no visual system, a gated reference library
does not justify speculative UI.

OpenAI's official model documentation was checked on 2026-10-06. It lists
`gpt-6-luna`, the Responses API, and structured outputs, with standard text
rates of $0.10 per million uncached input tokens and $0.50 per million output
tokens. The current adapter targets that model and `/v1/responses`. This
confirms model/API fit only; it does not prove account eligibility, budget,
source-forwarding permission, live request success, classification quality,
or usefulness. No model request was sent.

## Current usability verdict

The company-selection, saved-source inspection/return, and historical-chart
meaning slice is verified against the real rendered local app and retained
records. Overall professional usability remains **FAIL / about 4 of 10**
because the app cannot start with a tickerless discovery task, its saved source
evidence is stale and currently unrefreshed, Luna has no live output, and the
whole investor research outcome has not been measured. No demo or synthetic
data was added to the product. Radar remains disabled.


## Per-bucket lineage at the chart — 2026-10-06

Independent chart review found that Apple’s latest notable archive bucket represented 50 scored rows, with zero linked source-delivery receipts and 11 rows in repeated exact-title groups. Those facts were available only after opening the selected-bucket detail. Each historical archive point now carries receipt-link and normalized-title-group counts reconciled to the exact saved rows used to compute the plotted score. Hover tooltips show the matching per-bucket counts; the keyboard table includes the same values and clarifies that title matches do not prove duplicate stories or independent origins. Rolling series without this archive summary are labeled “Not summarized for this series,” never zero. No source data, score, or runtime behavior was fabricated.

The fix improves interpretation of existing history, but it cannot validate Jev sentiment or make the archive current. Luna remains unconfigured and external calls paused; the app still lacks tickerless discovery because the shared Hub has no current all-filer filing route. Targeted regression and typecheck results are recorded in the completion checkpoint.

## Rendered usability recheck — 2026-10-06

The built production client was freshly inspected in the Codex in-app browser at
`http://127.0.0.1:8787/` with the canonical saved-data runtime. The header said
`SAVED DATA ONLY`, `0 source records retrieved in 24h`, and `APP CONNECTED`;
external requests were paused. Selecting Adobe from the watchlist immediately
showed Adobe Desk. Its 7-day source panel showed 17 saved rows, all 17 awaiting
Luna judgment, with the latest retrieval two days earlier. The page's separate
Historical Jev tab showed 51 scores across 20 populated buckets for the UTC
week `[2026-09-28, 2026-10-05)`, with the latest score seven days old. The
visible caveat distinguishes score-completion time from publication or
investor activity and states that this is neither current Luna analysis nor
validated investor sentiment. The chart's selected bucket also exposes its
record count, spread, delivery-receipt links, and repeated-title cue. SEC facts
and aligned price history were unavailable. No provider or classifier request
was made and no demo or synthetic product rows were introduced.

This recheck verifies the task-level behaviors the screen can currently
support: select a known company, see which saved rows still need review, and
inspect dated historical model output without presenting it as current. It
does not clear the more important missing-data gates: the 24-company watchlist
cannot satisfy tickerless discovery, there is no current Luna classification,
current source retrieval is paused, and the shared Public Data Hub lacks a
supported all-filers route. The 733-test/94-file full suite passed in this
candidate. Fresh code-bound live-data evidence passes all declared checks
except `sec_filings_current_hub_receipt`. The independent whole-build verdict
remains FAIL; this rendered check does not establish intended-user outcomes or
overall readiness.

## Checkpoint and verification record — 2026-10-06

The reviewed source candidate is checkpointed at commit
`350f79c92e453a2d1f0454aa3863140825f50b32` on the existing public repository
`https://github.com/j-poc/sentiment-desk`, branch `codex/real-data-rebuild`.
After push, `git ls-remote origin refs/heads/codex/real-data-rebuild` returned
the same commit as local `HEAD`; the worktree was clean. The commit contains
reviewed source, tests, and project trace only; the local database, credentials,
and private `.engineering-evidence` receipts were excluded.

The full suite passed 733 tests across 94 files. The retained investor UI
recovery replay passed 9 tests, and all 13 affected focused quality-loop checks
passed with current input fingerprints. Gitleaks scanned 12.15 MB of source
and found no leaks; the ignored 97 MB local database was skipped and remains
excluded from Git. `npm audit --omit=dev --audit-level=high` found zero
vulnerabilities. Final `engineering_gate.py verify` is still pending and its
GitHub checkpoint check must run against the clean pushed tree. The live-data
ETL receipt remains FAIL solely because the shared Hub does not expose the
required current all-filers route; no provider or model calls were made for
this usability review.

A fresh independent usability reviewer found no further UI edit justified by
current evidence: the visible gaps are missing fresh source/model inputs and
the unsupported discovery route. A separate `personal-acceptance` judge
invocation exited before producing a verdict; its packet is saved locally but
is not counted as acceptance evidence. The independent subagent review and
rendered app observation remain the usability evidence. Overall product
readiness remains FAIL, not complete or 10/10.

## Usability follow-up: watchlist quote readability — 2026-10-06

Acceptance was set before editing:

1. A positive market-price change renders one leading plus in both the visible
   watchlist value and its accessible company-selection description.
2. A negative change retains one leading minus in both representations.
3. Selecting a watchlist company continues to expose that company’s current
   quote and source-backed evidence; the fix does not alter source or model
   data.

The running app confirmed the defect: the visible watchlist showed `++8.0%`
while the accessible description said `+8.0 percent`. Historical quote and
classification states remain subject to their existing freshness and evidence
caveats. This narrow repair does not resolve the paused Luna classifier or the
larger no-ticker discovery gap.

## Selected-stock chart recovery — 2026-10-06

### Investor-facing acceptance

Selecting another listed company must visibly change the selected-company desk
without carrying the old company's chart into the new view. If the matching Luna
snapshot is confirmed empty, show a separately titled real Yahoo price chart;
when its first saved observations arrive, initialize the chart rather than
leaving a blank panel. The chart must show source and retrieval times, disclose
gaps, reject unverified values, and preserve saved observations when a refresh
fails. A failed refresh must expose an action labeled as a retry.

### Rendered and regression evidence

The live app at `http://127.0.0.1:8787/` was inspected after selecting AMD. Its
current Luna state showed zero saved classifications and 100 of 100 loaded
source rows pending; the reason was the missing OpenAI API key. The selected
company view showed a distinct **Share-price context** panel, explicitly labeled
“Market context only. This is not sentiment.” Its accessible chart description
identified 71 receipt-verified Yahoo observations for the 7-day window. It
reported observation and retrieval clocks separately and five line breaks for
gaps of six hours or more. The latest plotted observation was from
`2026-10-06T16:25:22Z`; the separately displayed quote was retrieved later.
The chart response said `local_store`, so this inspection does not claim the
plotted series itself was newly fetched from the network. No demo or synthetic
points were introduced.

The live selection trial began with the new company's history still loading,
then showed the chart when receipt-verified saved observations arrived. The
initialization effect now reruns when the verified-point state changes and the
chart host becomes available. A stale-cache fallback and long-gap break remain
covered by `tests/market-price-context-chart.test.tsx`; server tests cover
refresh failure and preservation of eligible saved points. The failure-state
action now reads **Retry price history**.

Focused chart, price API, chart accessibility, chart preference, and watchlist
checks passed: 48 tests across five files. `npm run typecheck` passed after
handling the currency formatter's optional precision value. The production
client build passed; Vite still reports its existing large-bundle advisory.

### Limits and next value gap

This makes selected-stock price context usable while Luna has a confirmed empty
result. It does not make the main sentiment task operational: there are no live
Luna classifications because this process has no OpenAI API key, and the
independent whole-build review still finds no-ticker discovery, saved SEC facts,
and an interpreted followed-company material change incomplete. The SEC all-
filers receipt and intended-investor outcome evidence also remain unverified.
The chart is not evidence of investor sentiment or an investment conclusion.

## Current usability reconciliation — 2026-10-06, 20:06 EEST

The live in-app view now has external requests enabled. At this observation,
Google News RSS and Yahoo Finance RSS reported current deliveries across the
24 configured companies; Yahoo quotes also reported 24/24 coverage. Yahoo chart
delivery was partial across that roster. On AAPL, the selected 6-hour view
showed 25 saved source rows awaiting Luna, zero Luna classifications, and a
separate Share-price context chart with 49 receipt-backed Yahoo observations.
The plotted Yahoo series was served from local storage; its latest source time
was 2026-10-06 16:58:29 UTC and its retrieval time was 16:58:31.805 UTC. The UI
states that the chart is market context, not sentiment, and reports these
clocks separately. The screenshot interface still returns a zero-sized
viewport, so this continuation verified the rendered page through its live
accessibility tree, not pixels.

The AAPL Historical Jev archive contains 245 scored source records across 32
populated 15-minute buckets for `[2026-09-28, 2026-10-05)`. Its latest score
was completed at 2026-09-28 17:47 UTC. The saved-record weighted-mean impact
values across those buckets range from -100 to -2.02 impact points. This is
seven-day-old model output, not a stock return, current Luna result, or
validated investor opinion; repeated coverage contributes multiple records.
The current view uses discrete histogram bars with no connecting line or
interpolated gaps and explains those limits alongside the chart.

The current ticker-free Saved Sources tape is real but bounded to 60 latest
rows; nine require issuer review. Its visible samples include a listed-company
option quote and general stock commentary, all marked pending or needing an
issuer check. That view is useful for source inspection, but it does not rank
companies by investment merit or supply broad-market discovery. The independent
whole-build reviewer still rates readiness about 4/10 and names the unsupported
all-filers discovery route, unavailable Luna classifications, and missing SEC
facts as the largest gaps. This is where usability work should go next; further
chart styling would not close those investor tasks.

The same reviewer made one ADBE price-history GET while probing a route; it
returned a network delivery and persisted real Yahoo observations. It stopped
additional price requests after finding that side effect. The public-source
request is within the user's source authorization, but the probe is recorded
here so that it is not mistaken for a read-only browser inspection.

## Saved SEC fiscal-period comparison — 2026-10-06, 20:09 EEST

The actual saved Apple snapshot `d6c74477-577d-4085-9e20-cf998a5d95b3`
contains 183 persisted CompanyFacts values. Before this change, the live API
matched none because it required exact calendar-anniversary boundaries. A
read-only comparison through the revised service against a temporary, consistent
backup of the same real SQLite database returned 24 unique same-filing matches
under `sec-period-comparison/2`, with no ambiguous pair. The source database was
not written, and provider and model requests were disabled in the verification
server.

The rebuilt Desk rendered the June 27, 2026 Apple filing with the exact current
and prior periods, SEC filing link, filing/acceptance/retrieval clocks, and a
next check. Its 39-week revenue result is a $50.662 billion difference between
the returned values, not a growth claim. It also shows the 13-week revenue
difference ($15.381 billion), operating income ($7.493 billion), net income
($6.355 billion), and operating cash flow ($35.242 billion). Every shown
comparison identifies the same-filing 52-week boundary shift and exact ranges;
the UI states each window's length. Because SEC precision metadata is missing,
it withholds percentages and any inference about underlying direction, cause,
materiality or investment merit.

The final focused chart and fundamentals run passed 116 tests across 11 files;
the production build passed. A separate typecheck was started but its command
session ended without returning an exit status, so its result remains
unverified pending a clean rerun. The independent whole-build review found no
code-local flaw in the new alignment rule and rated whole-product readiness
about 4/10. The remaining high-value gaps are no-ticker discovery beyond the
fixed 24-company roster, usable current Luna judgments, and source-linked
drivers/counterevidence. The original app process on port 8787 has not yet been
restarted; it still runs the pre-change backend. The rendered verification was
the rebuilt offline saved-data instance on port 8788.

## Filing triage placement across issuers — 2026-10-06

Independent review found that putting a blocked SEC panel first for every
issuer would delay the chart and source evidence for 23 of 24 companies. The
selected-company research layout now leads with concise SEC triage only when
that selected issuer has persisted SEC facts. With no saved facts, the chart
and saved source evidence come first and the explicit blocked/empty SEC state
follows. Facts are scoped to the current company, so a prior issuer's SEC data
cannot move the panel to the front.

The current production build was loaded in the Codex in-app browser at
`http://127.0.0.1:8787/` against the existing local desk and database. On Apple,
the saved filing comparison appeared before the chart: the latest quarter
reported $109.417B versus $94.036B for the matched prior period, a $15.381B
reported-value arithmetic difference. The UI retains the filing link, separate
filed/accepted/retrieved clocks, missing-precision limitation, and no-causality
caveat. On Adobe, the chart and 51 saved, real source rows appeared before the
SEC panel, which correctly said no values or chart are shown without persisted
SEC facts. The same selected-company view loaded 73 receipt-verified Yahoo
price observations for its seven-day market context; no price values were
inferred or carried forward. The classifier remained paused with an explicit
missing-OpenAI-key message, and no Jev fallback or synthetic product data was
introduced.

The regression suite now asserts both placements. The complete native suite
was rerun after this change and is recorded in the current terminal receipt;
typecheck, production build, focused placement tests and `git diff --check`
passed. The independent reviewer confirmed the conditional layout is sound,
but could not inspect the browser itself. This pass also manually verified the
rendered accessibility order in both issuer states. The screenshot API returned
zero viewport width, so pixel-level first-fold measurement remains unverified.

Whole-build usability remains **NOT READY**. The highest-impact gap is still
research discovery without a known ticker: the desk only exposes a fixed
24-company roster. New Luna judgments also remain blocked because the active
process has no OpenAI API key; historic Jev scores do not replace those
judgments. The broader acceptance review and current-source receipts remain
gating; no overall completion or 10/10 claim is made.

## Final candidate gate and checkpoint status — 2026-10-06

After the conditional ordering fix, `npm test -- --reporter=dot --maxWorkers=1`
passed 767 tests across 98 files. The new selected-company-order regression and
SEC triage tests passed 15/15; `npm run typecheck`, `npm run build`, and
`git diff --check` passed. The retained investor-ui-recovery quality-loop
regression replay passed 10/10 tests.

The fresh live-data ETL run passed fixture, failure/recovery, replay, offline
request-gate, authorized keyless live-smoke, storage-capacity, SEC inbox
protocol, and inbox-failure checks. Its only failure is the actual SEC Hub
receipt: the read-only `npm run verify:sec-filings-hub` returns
`state=unsupported; rows=0; reason=The connected Hub does not yet provide the
SEC 8-K feed.` This is a live source-availability blocker, not a failed parser
or simulated data substitute. The live smoke used the already-running
`colima-sentiment-desk-verify` context after the selected Docker context was
found to point at a stopped, unrelated verification VM; the disposable smoke
container was removed by the script's cleanup.

The engineering gate's first invocation stopped before running its checks
because the saved alignment review hash was stale. Alignment inputs were
recomputed after the candidate changes; a fresh independent scope-map review
is required before rerunning that gate. The engineering gate has therefore
not yet passed. The whole-build reviewer still rates the product not ready;
tickerless discovery, current GPT-6 Luna classifications, and supported broad
SEC feed coverage remain incomplete. Browser accessibility readback verifies
the issuer order, but the Codex screenshot API reports zero viewport width, so
pixel-level first-fold positioning is unverified.

The configured GitHub remote `https://github.com/j-poc/sentiment-desk.git` is
currently **public**. The user has explicitly directed regular GitHub
checkpoints and pushes, so this reviewed in-scope checkpoint is authorized for
publication after secret scanning and final verification. Repository visibility
will not be changed.

## Chart availability and responsive readability — 2026-10-07

The selected-company Yahoo panel is now independent of Luna snapshot status, so
loading, failed, empty, and populated sentiment states no longer hide available
price context. Its placement is based on the selected-company chart column's
width: stacked by default, side by side only once that column is 640px wide.
This avoids squeezing both plots merely because the overall browser viewport is
wide. The price panel remains explicitly separate from sentiment, uses only
receipt-verified Yahoo observations, keeps source and retrieval clocks visible,
and leaves six-hour gaps unconnected.

Local-only verification read the running app with external requests disabled.
The AAPL price endpoint returned 154 saved `local_store` observations and every
point carried a collection receipt. The app has 24 configured companies; GPT-6
Luna is the selected classifier but is not configured or enabled in this
process. The current saved rows and explicit paused/empty states are real data;
no sample or synthetic product data was introduced and no provider request was
made. Opportunity Radar remains disabled.

The targeted chart/API/accessibility/selection suite passed 54 tests across 6
files, the production build passed, and the earlier typecheck passed before
the final CSS-only layout change. The production build still reports the
existing 806.64 kB minified web bundle warning. The in-app browser rejected the
reload under its security policy, so this pass does not claim rendered
acceptance of the 640px container threshold or the 1440px/390px layouts.

The product remains incomplete on the investor job that matters most: there
is no usable tickerless discovery source from the connected Public Data Hub,
and there are no current Luna judgments without an OpenAI credential and
enabled source/model path. A Yahoo price chart is context only and does not
replace current sentiment. Current engineering and live-data source receipts
must still be refreshed after the candidate is frozen.

## Mobile investor workflow rendered recheck — 2026-10-07

A fresh rendered recheck supersedes the earlier note that this layout lacked
viewport proof. In the live local app at 390×844, Apple selection showed a
receipt-verified Yahoo chart with 154 saved points, its exact observation and
retrieval clocks, and the explicit “Market context only. This is not
sentiment.” label before the empty GPT-6 Luna state. The empty state says zero
saved classifications is not neutral sentiment and keeps saved-source review
as its primary next action. Selecting Adobe independently changed the company
header and chart; Adobe displayed 83 receipt-verified saved points. On desktop
at 1880px, the reviewer saw source evidence beside the chart and fundamentals
below without clipping. At 390px, the picker, chart controls, plot, empty-state
copy, and saved SEC filing triage remained legible with no horizontal overflow.
No provider request or model request was made; the rendered rows and prices
were existing real saved records.

The original browser trace exposed a separate flex-shrink defect: the expanded
SEC card rendered 28px tall while containing about 471px of content. The card
now keeps its natural height and can scroll with the page. When saved prices
exist but the current Luna chart has no saved classifications, the verified
price context leads the chart column so the investor sees real market context
before an empty sentiment plot. A saved-source review action remains directly
available from that empty state. The native tests now retain regressions for
the panel sizing and responsive order, and the engineering contract records
the corresponding 390px behavior.

The independent UI reviewer identified one remaining mobile tradeoff: actual
source rows sit below the chart cards, which takes additional scrolling, while
the empty Luna panel offers a direct action to open them. We keep the chart
first because users explicitly reported missing charts, the displayed price
series is real and receipt-verified, and the one-action evidence route remains
visible; future user testing could reverse that order. This review is agent
judgment, not an investor usability study. Tickerless discovery, current Luna
judgments, and uncoached completion by serious individual and professional
investors remain unverified or blocked, so this layout fix does not establish
whole-product readiness.

## Startup inventory clarity — 2026-10-07

An independent rendered review found that the watchlist briefly showed “0
companies · no saved history yet” while its company inventory request was still
loading. The main pane also said “Connecting to the desk…” while the header had
already confirmed “APP CONNECTED.” The same review found the watchlist's
accessible name said “Market price unavailable” even when a real saved price
history chart was available.

The startup state is now named for the actual operation: loading saved company
inventory, inventory unavailable with a retry action, or a confirmed empty
inventory. The watchlist no longer presents loading or failed inventory as a
true empty desk, and missing quote copy refers specifically to the latest quote.
The old `DeskConnectionState` name and file were removed. Regressions exercise
loading, failure, a confirmed empty response, and the exact accessible quote
state; the engineering contract maps these checks to investor navigation.

The live 390px browser view now shows the connected app, 24 loaded companies,
Apple's receipt-verified saved Yahoo price chart, and the explicit zero-current-
Luna state without horizontal overflow. The chart reports 154 actual stored
observations with four six-hour gap breaks; 45 saved source rows are visibly
unclassified by Luna. The loading transition itself is retained as a component
regression because it resolves before an ordinary live-page snapshot. No source
refresh or model request was made; external requests were paused in the app.

This closes a startup-state usability defect, not the core product gap. The
independent full-build review still found no ticker-free discovery beyond the
24-company roster, no current Luna classifications, an unsupported current SEC
filings Hub feed, no completed followed-company material-change workflow, and
no measured investor task outcomes. The entire build therefore remains not
ready; this slice is not a 10/10 claim.

## Small-screen chart-label legibility — 2026-10-07

An independent UI pass rated the saved-data interface 7/10 and flagged the
categorical chart's 7px x-axis labels as too small to read comfortably at phone
width. The mobile label size is now 9px. The label container still caps each
date at one third of the plot width and ellipsizes overflow. The 390px layout
was rendered, but the saved window has no real Luna categories, so the actual
x-axis label size cannot be visually verified with product data. This addresses
a specific reading cost where labels render, not the lack of current Luna labels
or ticker-free discovery.

## Saved-data refresh controls and status wording — 2026-10-07

A live accessibility-tree review found two confusing states: a saved-history
read was described as a Luna “refresh” even though no classifier request was
running, and the price card left “Check prices” active while the desk was
explicitly in saved-data-only mode. The last-read line also repeated “ago.” The
Luna header now names the local history read and reports its last confirmed
count/read time without implying model work. Price refresh is enabled only when
health confirms the global request switch, Yahoo chart source, and storage
readiness; otherwise the saved chart remains visible and the control explains
why refresh is paused. Repeated price polling is disabled while those controls
are paused.

The 390×844 rendered view still shows the actual saved Apple chart (154
receipt-verified observations, latest 16h old), clearly separated from the
zero-classification Luna empty state. The UI reviewer confirmed the duplicate
“ago” is gone; the overall saved-data experience remains 7/10 because it has no
current Luna classifications or ticker-free idea discovery. Focused status,
price-refresh, and startup-recovery checks passed 17 tests across 3 files, and
TypeScript typechecking passed. No source refresh or model request was triggered
by the rendered browser review.
