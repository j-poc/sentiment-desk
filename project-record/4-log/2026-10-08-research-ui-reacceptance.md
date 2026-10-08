# Rendered research UI reacceptance

- **Recorded:** 2026-10-08
- **Scope:** selected-company chart/brief/private-note navigation, initial real-data view, and responsive layout
- **Source revision:** working tree after the reviewed UI changes; production bundle `dist/web/assets/index-DJWA36UJ.js`
- **Runtime:** local preview at `http://127.0.0.1:8796/`, using a separate SQLite backup of the user's saved database. Health reported `externalRequestsEnabled: false` and `opportunityRadarEnabled: false`. The preview used only loopback API calls. No private note, research decision, provider request, or product-database write was made.

## Observed behavior

- At **1280×720**, the selected Apple view rendered a receipt-verified Yahoo price chart and an SVG path. The chart reported 130 saved price observations; the latest source observation was `2026-10-06T19:57:31Z`. Its accessible description names Yahoo, the selected window, observation and retrieval times, the six-hour gap rule, and that price is not sentiment. Document width equaled viewport width.
- Selecting **Adobe** in the company picker changed the selected-company heading to Adobe and the chart description to `Adobe (ADBE)`; switching back restored Apple. No company’s chart points were carried into the other company view.
- The **Research brief** shortcut moved focus to the selected-company brief heading. The **Private notes** shortcut opened only the selected issuer's disclosure, focused its summary, and scrolled it to the top. At **390px** and **320px**, the same private-note action worked with the selected issuer.
- After a fresh load, the 183 saved SEC fact rows and 20 saved public-source leads were both collapsed. Their complete saved rows remain available for inspection. The concise decision form appears before those manifests.
- The private-note disclosure for Apple showed an empty local store and stated that GPT-6 Luna analysis was blocked because external requests were paused. No user-owned note was present or created.
- At **390×844**, document width was 390px; the plotted price area was visible in the first screen. At **320×760**, document width was 320px; the plot extended below the short viewport and remained vertically scrollable. Neither size had horizontal overflow.

## Evidence files

- `output/playwright/sentiment-desk-investor-workflow-20261008.png` — desktop, 1280×720
- `output/playwright/sentiment-desk-mobile-390-20261008.png` — mobile, 390×844
- `output/playwright/sentiment-desk-mobile-320-20261008.png` — narrow mobile, 320×760

## Limits

This proves rendered offline navigation and saved-data presentation only. It does not prove live Luna operation, current external-source freshness, the SEC filings Hub, a real selected-note analysis, a saved decision resumed in the browser, real investor usability, comparative advantage, or production readiness. Focused temporary-state tests cover private-note failure copy and delete confirmation/cancellation; their fixtures are isolated from the running app and saved product database.

## Precision-copy repair and latest recheck

- **Server workflow:** rebuilt API on an isolated 116,224,000-byte SQLite backup of the saved product database. `/api/health` reported external requests off and Opportunity Radar off. `GET /api/companies/apple/research-brief` returned 183 saved SEC facts, 20 saved public observations, and a next question based on the latest same-filing revenue pair: an absolute difference of `50662000000 USD` from 2025-06-28 to 2026-06-27. No percentage was returned because the stored SEC facts lack reported precision. This is a research prompt, not a cause or materiality claim.
- **Regression and repair:** an independent whole-build review found the prior candidate-selection defect and, after that was fixed, a second copy defect that attributed unavailable percentages to a nonpositive prior value. The compiler now retains a validated absolute difference while withholding unsupported percentages, checks later candidates if an earlier pair is invalid, and the panel repeats the exact persisted comparison reason instead of inventing a cause. The test-only Apple-shaped regression uses fixed values and provenance copied from the observed saved SEC pair; no such fixture is written to product data.
- **Latest verification:** the full native suite passed **123 files / 1,055 tests** after the UI-copy repair. The focused compiler/API/panel suite passed **23 tests**, typecheck passed, and the production build passed. The browser asset warning remains: the main JavaScript chunk is about 882 KB minified (256 KB gzip). The prior screenshot files above show the chart/navigation before this final copy repair; they do not prove the repaired copy rendered in a browser.
- **Real source replay:** the explicit live replay successfully read both official Nasdaq Trader directories and reported 3,500 Nasdaq-listed and 2,718 other-listed eligible rows. Both embedded file clocks were 2026-10-08 19:41 UTC; retrieval was about 20:46 UTC. Directory contents were held in memory only and not persisted or forwarded to a classifier.
- **No-demo audit:** a read-only aggregate query of the active product database found zero `demo_simulation` mentions; 4,700 `legacy_unknown` observations remain quarantined from current research, and 69,309 legacy-unknown price points remain excluded from verified-price views. This does not reconcile their historical source or model-use provenance. The database contained no saved categorical provider classifications at the time of inspection.
- **Unresolved runtime proof:** `npm run verify:sec-filings-hub` returned `state=unavailable`, zero rows, and unknown freshness because the same-user local Public Data Hub connection is unavailable or its private installation descriptor is invalid. The descriptor file is present and has owner-only permissions, but its protected content was not inspected. No live SEC filing refresh or selected-note Luna call was made.
- **Rendered proof limit:** the in-app browser rejected navigation to the local preview under its URL security policy. I did not use a browser workaround. The repaired panel copy is covered by the rendered-component regression, but no fresh current-build browser screenshot was captured.
