# Price quarantine disclosure

## Acceptance before implementation

The selected-company price pane continues to plot only provenance-verified Yahoo chart observations. The existing successful `/price` response reports a ticker-scoped count of `legacy_unknown` rows across all local history, without returning their numeric price or timestamp values. The count does not affect points, refresh, freshness, currency checks, calculations, or transport errors. In a confirmed empty verified window, the UI distinguishes withheld legacy rows from a true zero count and states that the inventory count covers all saved history. Missing or malformed metadata remains unknown. Loading and failed-refresh states do not claim a fresh inventory count. The explanation is visible, readable DOM text that wraps on narrow screens.

## Baseline evidence

The protected saved-data preview contains no verified Yahoo chart rows for NVDA and 2,883 `legacy_unknown` NVDA price rows. Those rows have no usable currency or collection receipt. The chart correctly excludes them, but its empty state only says no saved Yahoo price points exist. No product database was edited, no provider was contacted, and no synthetic product data was introduced.

## Design decision

Choose a reduced form of Candidate A: add a count-only `Desk` method, attach `{ legacyUnknownRows, scope: "all_saved_history" }` to the existing successful price response, and disclose it in the confirmed empty price pane. Read the count after the awaited refresh path, immediately before the successful response, so this request does not disclose a legacy row that the same refresh has since replaced. Keep `priceWindow()` and all existing eligibility predicates unchanged. Preserve the current 502 status and body on provider failure without verified saved history.

Two candidate designs were independently compared. The cross-judge preferred A by 22/25 over B at 16/25. A preserves the existing price DTO, chart path, and error contract with one scalar inventory query. B added a domain loader, renamed price fields, unions, adapters, and a shared module for one explanatory count. GPT-6.1 Sol xhigh separately recommended the reduced A design and emphasized counting after refresh, hiding stale counts during a transport error, and avoiding claims based on untrusted timestamps.

The `(ticker, t)` primary key already supports ticker-prefix lookup. No speculative index, migration, extra route, provider call, price fallback, or counter persistence is justified. The inventory query reads only the count and never uses legacy `t` or `price` values.

## Verification

The database, API, and rendered-copy regressions pass. A route-to-App regression
also covers a successful empty response with `refreshError`: the header no
longer describes the window as fresh or says it is keeping a saved series, and
the chart does not surface a stale count as current. The full suite passes 533
tests across 64 files; TypeScript, production build, and the production
dependency audit pass. The audit reports zero high-severity or critical
vulnerabilities.

The protected real-data preview at `http://127.0.0.1:8799/` was inspected at
1280×720 and 390px. NVIDIA shows its saved historical Jev series and 33 actual
seven-day buckets. With price comparison selected, the rendered empty pane
states that no verified Yahoo price points exist in the selected window, that
2,883 legacy rows are excluded for incomplete provenance, and that this count
covers all saved ticker history. The disclosure wraps at 390px without page
horizontal overflow. External requests and model keys were disabled, and the
product database was not modified.

The independent whole-build reviewer found no additional reproducible local
defect after the empty-refresh header correction. The separate investor/UI
reviewers also confirmed the selected-company evidence path, while rating live
investment readiness low because there are no saved Luna classifications and
the retained Jev data is several days old. Their scores and evidence limits
are in `2026-10-02-luna-chart-completion-review.md`.

The scoped five-check keyless ETL receipt and local read-capacity result are
recorded separately. They establish a bounded public-source smoke and local
saved-data read behavior; they do not establish endpoint-specific rights,
continuous ingestion, or production scale. The final engineering gate and
GitHub checkpoint are recorded in the completion review after push.
