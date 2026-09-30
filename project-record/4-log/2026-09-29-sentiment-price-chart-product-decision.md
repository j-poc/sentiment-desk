# Sentiment and price chart product decision — 2026-09-29

Trace ID: `TRACE-20260929-sentiment-price-chart-product-decision`

## Follow-up: cross-window consistency and swing interpretation — 2026-09-29

The answer to “is this the absolute best UI decision?” is still **no**. It is a
more honest current baseline, but it has not been compared with investors doing
real research tasks. A whole-build review found that the old implementation
changed a shared AAPL point from −5.07 at 24H to −36.58 at 3D and −64.77 at 7D.
The series reset to neutral at each window start and varied its decay half-life
with the selected window. That defect is fixed: all windows use the same
15-minute score-time grid and fixed eight-hour decay half-life, and the series
reconstructs state from that company's full saved score history. Tests verify
the common grid; the fresh saved-data API returned zero difference across eight
recent buckets shared by 6H and 7D. The fixed eight-hour choice preserves the
old 24H behavior, where the prior rule's half-life was eight hours.

The chart's visible swings are real changes in the saved model output, but they
are **not measured stock moves or investor opinion**. In the 2026-09-29 7D
Adobe view, the isolated saved-data copy returned 58 scored source records over
23 buckets, with a latest score about 23 hours old. One bucket contained 16
records whose individual impacts ranged from −88 to +97. An exact normalized
headline appeared up to nine times in the selected seven-day records. A later
bucket with one +100 individual impact moved the sequence to +67.79. That
sequence is designed to update quickly; duplicated/syndicated coverage can
therefore make a burst look like a large collective swing. The UI now labels
the decay rule, shows bucket counts and impact ranges, and says repeated
coverage may count more than once. It still lacks story-level breadth and
disagreement as first-class measures.

Public product evidence is directional, not a user study: [Stocktwits' message
volume guidance](https://help.stocktwits.com/c/faqs/faqs/message-volume)
separates message volume from sentiment and participation; its [community
rules](https://stocktwits.com/about/rules/) identify repetitive or near-
identical posts as spam, and [stream filters](https://help.stocktwits.com/c/key-features/features/stream-filters)
let users reduce noisy post types. This supports testing source volume beside
distinct exact-headline coverage and disagreement, but does not establish that
an event-cluster chart is preferred or accurate. The current chart remains a
bounded research view. A story/event timeline with one story, distinct-source
breadth, directional mix, and traceable source links is the strongest next
candidate for task comparison; do not promote it as validated signal without
real label and user-task evidence.

The fresh in-app-browser preview at `http://127.0.0.1:8798/` used an isolated
copy of the saved real database, with external requests and Jev off. It
selected Adobe, switched 24H → 3D → 7D, and visibly rendered the fixed-scale
chart and saved source feed. Its old-schema startup migration passed after the
observation-receipt index was moved to run after the migration adds the column.
The UI preview proves selection, chart, and migration behavior only. It does
not prove live operation, Jev quality, or UI preference.

## Current follow-up and product read — 2026-09-29

This is a defensible pre-validation layout, not an evidenced “absolute best.”
Keep the fixed-scale, score-time step chart as the default for now, with an
optional aligned price pane that only admits lineage-verified points. A
dual-axis overlay would still invite false comparisons between unlike units.
The chart's label now says Jev Impact Index and explains that the series is
model-derived, uses score-availability time, and can count repeated coverage.
Its accessibility description also states the item equation: P(positive) minus
P(negative); the value is an event-updated index that decays between score
arrivals, not a price return or a poll. Mention cards label the signed value as
directional impact, and the detail drawer separates it from Jev's most-likely
sentiment class. This covers neutral items with a nonzero probability
difference.

The latest whole-build re-review found that newly collected observations did
not reference the immutable request receipt. New writes now record the
successful or partial receipt before ingestion; `Pipeline.ingest` requires the
receipt, and the database checks collector, company, and adapter identity.
Existing rows keep a null receipt because those IDs were never saved. The
detail drawer identifies these as unlinked historical observations; no
receipt is invented. The linked live-observation path still needs a fresh
keyless live smoke and final code-bound ETL check after this change.

The gauge and chart are two different summaries. The company gauge is a
weighted mean over scored source records available in the latest three hours;
it falls back to the trailing 24 hours when that window has no scored records.
The chart is a sequential index that decays between score-time buckets. The
API now reports the gauge window and contributing-record count, and the UI
prints them under the gauge. Its accessible description says repeated or
syndicated records can count more than once. This prevents readers from
mistaking two different computations for one synchronized value.

The remaining design risk is more important than visual styling: syndicated
coverage can make publisher-record count look like independent confirmation.
In a reviewer read of the current AAPL 72-hour series, one bucket contained 50
records spanning individual impacts from −100 to +97 and had a value of −55.75;
another contained 26 records spanning −100 to +100 and had a value of +0.07.
These are record-weighted model outputs, not measured swings in the share price
or investor opinion. The chart and gauge now disclose the record grain, but
they still do not cluster stories. A story/event timeline that shows one
underlying story, its distinct-publisher breadth, its directional mix, and
links to each source is the strongest next candidate inside Sentiment Desk.
It must be evaluated against the current chart on real, provenance-backed
tasks before replacing this series; no clustering output should be passed off
as validated market signal.

The small public-feedback sample points in the same direction but is not a
usability study: [a historical r/stocks thread](https://www.reddit.com/r/stocks/comments/lmmn1g/i_built_a_program_that_tracks_mentions_and/)
describes removing duplicate comments and asks to compare mentions with volume
and price; [an r/IndiaStocks dashboard discussion](https://www.reddit.com/r/IndiaStocks/comments/1ssrflt/so_i_made_a_dashboard/)
mentions duplicate articles, ticker mapping, missing context, and noisy
metadata. These anecdotes support testing story breadth and data context; they
do not establish which chart investors prefer.

## Latest saved-data UI evidence

The updated 1280×720 in-app-browser preview used the isolated SQLite copy at
`/private/var/folders/x7/dbq628s16yd1sks27jtgy5jr0000gn/T/sentiment-desk-ui-review-xsSWwg/desk.db`.
The app reported **SAVED DATA ONLY**, external requests disabled, Jev paused,
and Radar disabled. The selected Adobe view showed 10 source records in 24h,
four scored records in the 24h gauge fallback, and three score-time chart
buckets. The latest completed score was about 22 hours old. Clicking ADBE in
the watchlist changed the selected company, gauge, chart, and feed. No verified
Yahoo price point existed for ADBE, so the default remained the honest
sentiment-only pane. No provider or Jev request was made and no synthetic
product record was created. A separate API review of AAPL over 72h returned
245 scored source records across nine score-time buckets; these counts are a
different query window from the 24h browser state.

The preview demonstrates saved-data interaction only. It does not establish
fresh delivery, complete coverage, Jev classification quality, investor
usability, or operational readiness.

## Latest UI implementation and checks

- The gauge disclosure now distinguishes the 3h weighted mean from the 24h
  fallback and reports its source-record count. A regression verifies the
  current-window and fallback metadata.
- The gauge needle and app transitions honor `prefers-reduced-motion`.
- The compare control names the Jev impact index and share price, and the
  README no longer describes the meter as measured investor sentiment.
- `npm test -- --reporter=dot --maxWorkers=1 --testTimeout=20000` — **PASS**,
  223 tests across 29 files.
- `npm run typecheck` — **PASS**.
- `npm run build` — **PASS**; Vite still reports its existing 547.20 kB
  JavaScript chunk advisory.
- `git diff --check` — **PASS**.
- The updated browser preview selected ADBE and rendered its saved chart and
  feed; comparison remained unavailable without a verified price history.
- These UI checks do not establish the five-check live-data ETL result.
  `project-record/4-log/live-data-etl-evidence.json` is the authority for the
  fresh code-bound gate status; it must pass before operational readiness can
  be claimed.

## Decision boundary

No task-based investor study has been run. The present layout is a cautious
default with truthful units, time semantics, source grain, and provenance; it
is not a user-validated winner or a 10/10 product decision. The native goal is
currently blocked on external evidence. TypeSafe account authority and spend terms, a
contact-bearing SEC User-Agent, independent blinded real-source labels and a
passing Jev evaluation, historical usage reconciliation, and finite coverage
remain separate acceptance gates. Opportunity Radar remains downstream of
Sentiment Desk readiness.

## Decision

“Absolute best” is not evidenced without task-based investor research. The
current default is a sentiment-only view. Price comparison remains a one-click
option, but the pane now admits only chart points whose Yahoo source, currency,
retrieval time, and adapter version are recorded. Legacy price rows lacking that
lineage remain in the database for audit and no longer enter the chart or
reaction calculations. Each admitted point also links to an immutable source
delivery receipt.

The sentiment pane stays on a fixed −100 to +100 index scale. Solid, colored
marks show buckets containing newly scored items; dashed segments distinguish
modeled decay. The price pane labels its unit when known and states when the
source point's unit, collector, observation age, and retrieval time are known.
The header shows scored source-record and bucket counts; hover reveals each
bucket's count and individual-impact range. The one-click “Compare price” /
“Index only” control and `c` shortcut keep comparison available on demand.

## Why this default

- A dual-axis overlay was rejected because a visual intersection or amplitude
  comparison can be mistaken for a quantitative relationship between different
  units.
- The sentiment index remains fixed-scale and step-rendered: score bucket values
  are state updates, not continuously observed sentiment. Counts/ranges help
  expose when a bucket contains a small or mixed set of records.
- A saved-database review found legacy price rows stored only ticker, time, and
  value. The prior two-pane default therefore displayed unauditable price
  points. The new migration tags those rows `legacy_unknown` and excludes them
  from both price history and outcome calculations. A default comparison would
  give that unverified series undue authority.
- Comparison remains opt-in so a future properly sourced price history can be
  inspected against the time-aligned sentiment record without mixing scales.

These are design reasons, not measured usability outcomes. An independent
read-only chart review agreed the fixed sentiment scale and aligned independent
price scale are sensible, and identified smooth interpolation as a misleading
representation of discrete score updates. No task-based investor study has
been run, so neither “absolute best” nor a 10/10 claim is supported.

The large movements are Jev's aggregated item-impact index, not stock-price
swings or a validated measure of crowd sentiment. In the earlier
publisher-time AAPL 3-day audit, 242 scored source records occupied 20 hourly
buckets; 194 appeared in 65 repeated exact-title groups, with the largest
group containing eight source records. This differs from the current
score-availability-time review above. The existing update rule can move 80%
toward a high-weight item. Those mechanics can create abrupt changes when the
same story is syndicated across publishers. The chart reports record counts,
not independent investor opinions; event/story clustering and an independently
labeled Jev evaluation remain future validation work.

## Earlier browser checkpoint (superseded)

The earlier 2026-09-29 in-app-browser review at `http://127.0.0.1:8797/` used an
isolated SQLite copy and a production build, with external requests and Jev
disabled. That snapshot showed AAPL's sentiment-only fixed-scale chart,
47 source records in the prior 24 hours, and 17 scored source records across 7
publisher-time buckets; the newest completed judgment was 21 hours old. Its
counts and publisher-time buckets are historical and are superseded by the
score-time ADBE/API evidence above. Later lineage quarantine removed unknown
price history from current views; this old screenshot must not be treated as
proof of verified Yahoo price data. No provider or Jev request was part of
that review, and no synthetic product observations were created.

The chart is therefore a saved-data UI check only. It does not prove current
source delivery, source completeness, real-source Jev quality, or readiness.
The native Sentiment Desk goal remains **blocked**. The separately recorded
account-authority, SEC contact, independent-label/evaluation,
historical-usage reconciliation, and coverage evidence gates remain open.
Opportunity Radar remains downstream of that gate.

## Earlier verification (superseded by the current checks above)

- `npm test -- --reporter=dot` — **PASS**, 216 tests across 29 files.
- `npm run typecheck` — **PASS**.
- `npm run build` — **PASS**; that build reported a 544.68 kB JavaScript chunk.
- In-app browser — **PASS** for the then-current two-pane implementation.
- That preview confirmed saved-data-only mode, source/quote feeds disabled,
  and Jev paused; it did not exercise a live collection or classification path.
- Regression tests now migrate legacy price rows as `legacy_unknown`, keep
  them out of `priceWindow`, and admit only validated Yahoo chart points with
  currency/retrieval/adapter provenance.
- The synthetic live-Jev smoke command is blocked with an explicit message; it
  must not send fabricated text to the provider. This does not block the
  keyless live-source smoke, which makes no Jev request.
- `git diff --check` — **PASS** before the implementation checkpoint; the
  follow-up trace edit also passed `git diff --cached --check`.

## Previous GitHub checkpoint

The implementation and decision record were committed as
`30eafafb6c999455bb8bc33d786f85309acc4be6`
(`refine(ui): prioritize sentiment in price comparison chart`) and pushed to
`origin/codex/real-data-rebuild`. A read-only `git ls-remote` check returned the
same SHA for `refs/heads/codex/real-data-rebuild`.
