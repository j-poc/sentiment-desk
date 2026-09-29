# Sentiment and price chart product decision — 2026-09-29

Trace ID: `TRACE-20260929-sentiment-price-chart-product-decision`

## Decision

“Absolute best” is not evidenced without task-based investor research. For the
current Desk screen, the selected default is an aligned two-pane comparison:
the fixed-range Jev sentiment index receives twice the chart height of the
share-price context pane. Both panes share time, and each keeps its own scale.

The sentiment pane stays on a fixed −100 to +100 index scale. Solid, colored
marks show buckets containing newly scored items; dashed segments distinguish
modeled decay. The price pane labels its unit when known and states when the
saved quote currency is unknown. The chart header surfaces scoring and source
age, and the one-click “Index only” / “Compare price” control can hide or show
price while preserving the sentiment view. Keyboard shortcut `c` is available.

## Why this default

- A dual-axis overlay was rejected because a visual intersection or amplitude
  comparison can be mistaken for a quantitative relationship between different
  units.
- A sentiment-only default was rejected because it hides the timing needed to
  compare a sentiment move with a price move.
- Equal-height panes were rejected after visual inspection because price is
  context for this screen and the equal split diluted the primary signal.
- The chosen layout keeps temporal comparison while giving the investor's
  primary question—what changed in sentiment?—the more legible plot.

These are design reasons, not measured usability outcomes. The decision needs
validation with investor tasks: identify a sentiment change, tell scored data
from modeled decay, compare its timing with price, and correctly notice stale
data. A product-wide “best” claim stays open until that evaluation.

## Runtime evidence and data boundary

The current in-app browser at `http://127.0.0.1:8797/` showed the chart at a
1280×720 viewport. The app reported “SAVED DATA ONLY”, external requests
paused, and Jev dispatch blocked. For AAPL, it showed 68 locally saved mentions
collected in the prior 24 hours, last collected 20 hours earlier; the chart
showed 10 scored sentiment buckets, last scored 21 hours earlier, and saved
price history with unknown currency. The screenshot was inspected directly in
the in-app browser; no screenshot file was added to the repository. No provider
or Jev request was part of this chart review. No demo or synthetic product
observations were created.

The chart is therefore a saved-data UI check only. It does not prove current
source delivery, source completeness, real-source Jev quality, or readiness.
The long-running Sentiment Desk goal remains **blocked** by the separately
recorded account-authorization, SEC contact, independent-label/evaluation,
historical-usage reconciliation, and coverage evidence gates. Opportunity Radar
remains downstream of that gate.

## Verification

- `npm test -- --reporter=dot` — **PASS**, 216 tests across 29 files.
- `npm run typecheck` — **PASS**.
- `npm run build` — **PASS**; existing Vite advisory remains for the
  544.68 kB JavaScript chunk.
- In-app browser — **PASS** for showing both aligned panes at 1280×720 and
  toggling between comparison and index-only modes.
- The browser confirmed saved-data-only mode, source/quote feeds disabled, Jev
  paused, and unknown price currency; it did not exercise a live collection or
  classification path.
- `git diff --check` — to be run after this trace is staged.

The code checkpoint and remote SHA are recorded in the follow-up below after
the push completes.
