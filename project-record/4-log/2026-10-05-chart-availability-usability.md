# Chart availability after company selection

Status: chart-availability and sparse-archive usability slice verified; overall desk remains incomplete

## User outcome and evidence

After selecting a company, show the best eligible real sentiment chart without
requiring a second chart-navigation click. Prefer saved GPT-6 Luna categories
when they exist. If a matching Luna snapshot is successfully empty, use the
saved Historical Jev archive only when it contains eligible records. Keep the
two methods separate and make historical age and model limits visible.

Reproduced in the in-app browser against the isolated real-data preview. Clicking
Adobe changed the selected company and its source records. Its Luna panel then
showed zero classifications and external requests disabled. A separate click on
Historical Jev loaded a real saved chart for UTC week 2026-09-28 to 2026-10-05:
51 scored records, 20 populated 15-minute buckets, latest score 2026-09-28.
Therefore selection works; the chart is hidden because the application starts
on Luna and fetches the archive only after explicit tab selection. No external
request was made.

## Acceptance

1. While the selected Luna snapshot is loading or has failed, keep Luna selected.
2. A matching successful Luna snapshot with eligible categories keeps Luna
   selected, even when historical Jev data also exists.
3. A matching successful zero-category Luna snapshot may open Historical Jev
   automatically only after a populated saved archive for the same company is
   confirmed. An empty or failed archive leaves the truthful Luna empty/error
   state and its saved-source recovery action available.
4. A deliberate Luna or Jev tab choice remains authoritative across polling,
   company changes, window changes, and late responses.
5. Historical Jev stays visibly named and separate. Show its exact UTC week,
   latest score and age, saved-record/bucket counts, blank time gaps, and that
   it is neither a current Luna classification nor an independently validated
   investor opinion. Never fill gaps or add synthetic observations.
6. Verify the original stock-selection path and rapid company changes in the
   rendered app. Focused regressions cover auto selection, manual preference,
   empty/error/loading states, and company identity. No provider calls.
7. Sparse archives default to a score-focused plot that includes every scored
   bucket while staying inside the selected UTC week. A visible, keyboard- and
   touch-operable Full week control restores the complete selected interval;
   the exact week and age remain visible in either view.

## Decision and domain shape

The selected chart is either automatic or manually chosen:

```ts
type ChartView = "luna" | "jev";
type ChartViewPreference =
  | { kind: "automatic" }
  | { kind: "manual"; view: ChartView };
```

Automatic resolution uses a successful Luna count keyed to the selected company
and window plus a populated Jev archive keyed to the selected company. Zero
Luna rows alone never trigger the fallback. Manual choice takes precedence over
all later data refreshes. A bounded local archive read starts only after a
matching empty Luna snapshot.

Candidate comparison:

- Data-aware tab resolution reuses the existing Historical Jev panel, keeps
  semantics and accessibility aligned with the selected tab, and adds only one
  local archive lookup after a verified empty Luna result.
- An inline Jev chart below the Luna empty state would show two different
  classifier views in one tab and risk putting the chart below the visible
  area.
- The current CTA-only behavior preserves classifier separation but hides an
  available real chart behind an unnecessary second choice.

The data-aware option is selected from current browser evidence and independent
investor/UI review. The implementation retains Luna as the loading and
successful-data default, waits for archive proof, respects manual choice, and
adds a visible historical-quality note. This revises the older prohibition on
an automatic historical fallback; it does not change classifier, collection,
or source semantics.

## Sparse archive view decision

The rendered 7D Adobe archive had 51 scores in 20 populated buckets, all
compressed into one morning of the selected week. Full-week scaling preserved
the long empty interval but made the nonempty chart look blank at phone width.
Two credible views serve different questions: full-week scale preserves every
hour of the archive context; score-focused scale makes the actual observations
readable. The initial view now fits every eligible score bucket with modest
time padding, while a nearby Full week control keeps the complete interval one
tap away. The selected UTC week, latest score time, and age are unchanged and
remain visible. Reconsider the default if investor sessions show that the long
no-observation interval is more important than reading score variation.

## Throughput checkpoint

- **Blocking first steps.** Read the active acceptance and runtime; reproduce
  company selection and chart states; verify existing archive data and identify
  source/API side effects before editing.
- **Independent workstreams.** Read-only investor/UI review is complete. App
  state, regression tests, and the linked acceptance item form one dependency
  chain; one implementation owner and the parent integrate and verify.
- **Shared mutable state.** Chart preference, selected-company/window snapshot,
  archive request identity, focus, and scroll are shared in `App.tsx`; serialize
  these edits and preserve stale-response guards.
- **Smallest safe decomposition.** Add one typed chart-view policy and focused
  tests; change only the chart selection orchestration, its contract criterion,
  and this trace. No provider clients, collection changes, or chart data
  transformations.

## Verification and limits

In the in-app browser at 390 CSS pixels, the automatic historical archive view
rendered a real Apple archive with 245 saved scores in 32 populated buckets.
Fit scores showed the observed bars at readable width; selecting Full week
restored the exact week timeline and showed the long empty period; selecting
Fit scores again restored the readable plot. The visible range controls and
historical qualification stayed available, and no provider request was made.
The chart legend wraps rather than clipping at narrow widths.

Focused checks before the plot-span refinement: `npx vitest run
tests/series-chart-state.test.ts tests/series-chart-accessibility.test.tsx
tests/chart-view-preference.test.ts` passed 36 tests; `npm run typecheck` passed.
The independent product review confirmed the historical baseline component and
server workflow exist. This review did not create or read back a real issuer
baseline or validate a material-change task outcome. Overall product readiness
remains blocked by no fresh real-source records, GPT-6 Luna unconfigured and
paused, no current SEC 8-K Hub feed, no saved SEC fundamentals for the rendered
issuer, no tickerless small-cap discovery, and no investor task outcomes. The
30-case independent-agent references are not a Luna classifier run or human
ground truth. No demo or synthetic runtime data was added.

## Plot-span and touch-control refinement

The focused browser review found that “Fit scores” changed the plotted UTC
interval while only the archive week remained visibly named. It also found the
range buttons smaller than the 44px touch target used elsewhere. The archive
chart now prints the plot interval as a half-open UTC span separate from the
selected week, preserves full ISO timestamps in its accessible label, and gives
both scale controls 44px minimum height and width. A targeted regression first
failed because the plotted interval label was missing. The rendered result was
rechecked in the Codex in-app browser at 320px wide. Fit scores shows `Sep 28
07:41:15 to before 20:03:45 UTC`; its accessible name retains the exact ISO
millisecond bounds and states the separate selected week
`[2026-09-28T00:00:00.000Z, 2026-10-05T00:00:00.000Z)`. Full week switches the
plot label and bounds to that selected week; Fit scores restores the focused
span. Both controls render with 44px minimum height. Selecting ADBE in the
company picker changed the heading and chart to its saved 51-score, 20-bucket
archive, and selecting AAPL restored the original 245-score chart. The app
remained connected in the final rendered check and external requests stayed
disabled.

The new focused assertion was first run red because the visible plot span was
missing. After implementation, the chart suite passed 36 tests across
`tests/series-chart-accessibility.test.tsx`, `tests/series-chart-state.test.ts`,
and `tests/chart-view-preference.test.ts`; `npm run typecheck` passed. The
contract JSON parses, all 25 acceptance items map exactly once, and
`git diff --check` passed. The production build was not repeated for this small
UI refinement because only 2.0 GiB remained free on a full filesystem. The live
Vite app rendered and exercised the changed code. No product data, provider
requests, or demo/synthetic records were added.

The full product remains unready. The application review still finds no
tickerless small-cap discovery, no fresh real-source/Luna evidence, no current
SEC 8-K Hub feed, and no investor outcome evidence. CompanyFacts and
followed-baseline UI and server paths exist, but this rendered pass did not
establish current filing-backed triage or perform a real baseline read/write
and material-change journey. The 30-case agent references are not Luna output
or ground truth. The live-data and engineering completion receipts are not
passing, and the current native Goal objective still names Jev as the new
classifier even though the accepted product contract selects GPT-6 Luna.

## Current investor workflow readback — 2026-10-05

The in-app browser at `http://127.0.0.1:8797/` reports a connected, saved-data
only desk. Apple shows 245 saved Historical Jev scores in 32 populated buckets
for `[2026-09-28, 2026-10-05)`, with the latest score at
`2026-09-28T17:47:12.141Z`. Its separate 7-day source window has 10 saved rows
and no scored records; new Luna classifications are paused. SEC facts are not
refreshed because external requests are disabled. No Apple follow baseline
exists; the UI reports 20 receipt-verified records eligible and 574 real-history
rows withheld by provenance or ingestion checks. These are visible limitations,
not simulated product results.

The independent whole-product readback found the zero-ticker filings feed
unsupported with zero rows, Adobe SEC fundamentals blocked with zero facts, no
saved Adobe baseline, and GPT-6 Luna unconfigured with zero classifications.
The Recent Filings UI is candid that its unranked 8-K page is not a small-cap
screen. The desk therefore still fails its discovery, current fundamental
triage, Luna-operation, baseline-change, and investor-outcome tasks.

Current focused verification passed the retained investor UI recovery case
(2 files, 9 tests), historical chart UI (3 files, 36 tests), source history
(8 files, 62 tests), first-run evidence (4 files, 25 tests), followed baseline
(3 files, 9 tests), fundamentals triage (6 files, 60 tests), analyst research
(9 files, 38 tests), filings inbox (3 files, 10 tests), categorical chart
(7 files, 37 tests), RSS clock semantics (9 files, 78 tests), Radar disabled
(1 file, 2 tests), archive-week navigation (6 files, 50 tests), and TypeScript
typecheck. These offline checks do not prove live provider operation or product
outcomes. `engineering_gate.py check` still reports a missing evidence receipt;
`live_data_etl_gate.py check` still fails stale code-bound evidence and missing
passing live-smoke/current-Hub receipts. The filesystem had about 510 MB free,
so full build/VM-backed verification was not run. No provider/model request
was made and no product database was changed.

## Decision supersession — 2026-10-06

The October 5 proposal to automatically switch from an empty Luna result to a
historical Jev chart is superseded by the active version-2 engineering contract
and the later user direction to make OpenAI GPT-6 Luna the current classifier.
The live archive has old, batched Jev scores and incomplete delivery-receipt
linkage; automatic substitution would save one click while making the current
screen easier to mistake for present-day sentiment. The accepted interaction
keeps the empty Luna state explicit and offers a separate, dated Historical
Jev action with score count, UTC week, latest score, and age.

The current rendered recheck supports that choice: Luna says there are no saved
classifications and explicitly warns that empty is not neutral sentiment; the
archive action exposes the real stored history with method and age context.
This is the best supported current interaction, not proof of market-wide
coverage or decision quality. Mobbin research is `BLOCKED`: on 2026-10-06 its
in-app browser showed only the public landing page with Log in/Join and a
Finance+ paid tier; it did not expose finance-app screens or flows. The
separate public Explore navigation timed out. No Mobbin pattern is claimed or
inferred. Existing rendered investor tasks and user-provided dashboard
preferences remain the evidence for this interaction.
