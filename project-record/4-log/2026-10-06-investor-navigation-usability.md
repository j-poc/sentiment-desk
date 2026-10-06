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
