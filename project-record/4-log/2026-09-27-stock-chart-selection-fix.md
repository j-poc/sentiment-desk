# Stock selection and chart panel reliability

## Outcome

Selecting a ticker keeps the desk available and binds its chart, mentions, and
outcome summary to the selected company and time window. Empty, loading, and
failed data states remain explicit. The chart renders valid price history when
Jev has no scores.

## Baseline and evidence

- In the keyless production build, selecting Adobe returned an all-whitespace
  Jev series (`v: null`, `n: 0`). `SeriesChart` called `setVisibleRange` before
  any series had drawable points; Lightweight Charts threw `Value is null` and
  React removed the page.
- The first repair replaced the unsafe range setter with guarded `fitContent`,
  validated chart points, and added truthful no-score, empty, one-point, and
  request-failure states.
- A follow-up review found stale-response risks in company selection and
  stale-price metadata. Sentiment and price results and provenance are now
  keyed to company/window; out-of-order responses cannot become visible under
  another selection.
- Visual inspection then exposed two adjacent company-binding bugs: the
  outcome panel's global eight-second throttle could leave ADBE under an NVDA
  heading, and the mentions panel kept the previous company's cards visible
  while fetching the next company.
- The outcome panel now caches by company/window and throttles each matching
  key independently. Mentions are stored per company. New selections render
  their own pending state; a failed mentions fetch is not reported as an empty
  feed.

## Current verification

| Gate | Result | Evidence |
| --- | --- | --- |
| Unit suite | PASS | `npm test`: 63 tests across 11 files, after the latest source edit. |
| Type check | PASS | `npm run typecheck`, after the latest source edit. |
| Production build | PASS | `npm run build`, after the latest source edit. |
| Current-build chart selection and empty-sentiment rendering | PASS | Fresh Playwright reload and scripted ADBE→NVDA selection against `http://127.0.0.1:8794/`. NVDA `/series`, `/price`, `/mentions`, and `/reactions` all returned 200; 97 sentiment buckets were all null, with 97 price points, 100 mentions all for `companyId=nvidia`, and reaction ticker NVDA. The NVDA heading, no-score state, outcome heading, source-age label, and chart canvas were visible. |
| Current-build delayed chart response | PASS | Delayed ADBE `/series?hours=6` returned a distinctive 0.99 sentiment sentinel after switching back to NVDA. NVDA outcome heading and no-score state remained; one delayed request completed; no page errors. |
| Current-build outcome/mentions ticker and window binding | PASS | Live NVDA `/mentions?hours=168&limit=100` contained only `companyId=nvidia`; `/reactions?hours=24` identified NVDA. Switching 24H→6H requested NVDA `/reactions?hours=6` (200) and kept the heading bound to NVDA. |
| Current-build delayed mentions/outcome response | PASS | Delayed real Adobe `/mentions` and `/reactions` responses completed after selection returned to NVDA. Outcome remained NVDA, no Adobe-only headline appeared in the NVDA mention panel, and there were no page errors. |
| Current-build mentions failure and recovery | PASS | One controlled AMD mentions 503 displayed the explicit load failure. After removing the override and selecting away/back, the real local API returned 200 and the failure cleared. The deliberate 503 appears as a browser network console error; it is not a runtime exception. |
| Current-build empty, one-point, and failed chart recovery | PASS | Controlled `/series=[]` and `/price.points=[]` showed the empty-history message; one controlled price point showed the one-point message; controlled price 503 showed chart failure; each was removed and live local API recovery returned 200 with the chart restored. |
| Current-build 390px viewport | PASS | At 390×844, document width and scroll width were both 390px. The scripted run had zero page runtime errors. A fresh normal-path reload also had zero console/runtime errors; controlled 503 cases below intentionally produce browser network-error console entries. |
| Final screenshot | PASS | `output/playwright/2026-09-27-stock-chart-selection.png`, 1280×900. Shows NVDA, visible price line, explicit no-score state, and source-age label. Contains live headline data; keep local and out of Git. |
| Scripted latest-build end-to-end pass | PASS | One fresh Playwright CLI run rechecked selection, company/window binding, a delayed Adobe chart response carrying a 0.99 sentinel, a delayed Adobe mention response carrying a unique sentinel, empty and one-point chart histories, controlled AMD mention/price 503s and recovery, and 390px overflow. Every case passed; `pageErrors=[]`; final UI returned to NVIDIA. |
| Git checkpoint | IN PROGRESS | User authorized regular checkpoints to `origin/codex/real-data-rebuild`; commit and push the scoped code/spec/log files after final diff review. Do not stage `output/`. |

## Recovery state

- State: `latest-build end-to-end verification passed; checkpoint pending`
- Owner: primary task
- Resume action: rerun `git diff --check`, review the staged diff, then commit
  and push only the scoped source and project-record files to
  `origin/codex/real-data-rebuild`. The passing browser run used the fresh
  `sentiment-panel-verifier` session against the production build on port 8794.
- Pass condition: verified gates above remain green; the scoped commit reaches
  `origin/codex/real-data-rebuild`; leave the screenshot in `output/` locally.
- Authority: branch push is authorized. No PR, merge, deployment, publication,
  or provider-side action is in scope. A separate worktree is unnecessary
  unless parallel repository changes begin.

## Data limits

The current UI run showed no completed sentiment points. This is not the same
as proving a keyless configuration: the local server reported resolving a Jev
key from its environment, and live source cards visibly showed a provider
model-version mismatch (`expected jev-latest, received jev-1.13.0`). TypeSafe's
current docs say the alias resolves to a versioned ID and the response reports
that ID; the client currently rejects it. No failed unknown-outcome judgment
was replayed. This separate Jev integration issue is documented in the
completion spec and needs its own repair and live-path verification.

The visible price history may carry an observation from the previous market
session through the closed weekend; its source age is shown. These checks prove
selection, rendering, provenance display, and recovery—not market-price
accuracy, successful live Jev scoring, Jev quality, or investment merit.
