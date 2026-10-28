# Investor workflow review — 2026-10-10

## Verdict

The production cloud route is **not complete** for the requested investor workflow. Three independent reviewers inspected current production routing, UI components, data boundaries, and tests after the TradingView chart change. No reviewer observed the live browser, fetched SEC data, called a model provider, used credentials, or wrote to a hosted service. A rendered end-to-end score is therefore **0/8 verified outcomes**. This is missing proof, not a claim that every source-level implementation is absent.

The shared binary criteria are:

1. A fresh user reaches the investor desk without seeing backend setup.
2. Discovery returns evidence-backed companies worth investigating.
3. Company updates connect new evidence to business drivers and direction.
4. A bullish/bearish/abstain summary shows support, counterevidence, sources, and next checks.
5. The selected company has a correctly identified, attributed chart with truthful data timing.
6. External data sharing is disclosed and controlled by the user.
7. The production route supports user-owned OpenAI, Gemini, and TypeSafe Jev credentials with a safe request boundary.
8. A fresh user completes the primary workflow and receives useful results from real data.

| Criterion | Current result | Evidence |
|---|---|---|
| 1. Production entry | **Implementation present; rendered route unverified.** `main.tsx` selects `CloudCoreApp` for production, which gates access behind account sign-in. | `web/src/main.tsx`; `web/src/components/CloudCoreApp.tsx` |
| 2. Evidence-backed discovery | **No.** Search is a SEC ticker/name/CIK identity directory. It does not explain why an issuer is a lead. | `web/src/components/CloudIssuerDirectory.tsx` |
| 3. Company updates | **No.** Company research shows SEC facts and filing activity. Followed-company updates compare filing accession lists and do not explain business impact. | `web/src/components/CloudResearchDesk.tsx` |
| 4. Bull/bear synthesis | **No.** No cited directional summary or counterevidence view is mounted in the production route. | `web/src/components/CloudResearchDesk.tsx`; `web/src/components/ModelProviderCompanySummary.tsx` is local-only |
| 5. Price chart | **Partial; live symbol resolution and rendering unverified.** The UI code renders a contextual, attributed, opt-in chart and labels it exchange-delayed. NYSE American and share-class aliases are corrected; unsupported exchanges fail closed. | `web/src/components/CloudTradingViewChart.tsx`; `tests/cloud-tradingview-chart.test.tsx` |
| 6. Sharing control | **Implementation present; network behavior unverified.** The user loads the iframe explicitly. The code discloses ticker, IP, and page URL tracking, and isolates the frame from model keys. | `web/src/components/CloudTradingViewChart.tsx` |
| 7. Production BYOK | **No.** Provider-key and source-assessment controls are wired only in the local app. | `web/src/components/ModelProviderSettings.tsx`; `web/src/App.tsx`; `web/src/components/CloudCoreApp.tsx` |
| 8. Fresh-user real result | **Unverified.** The retained cloud journey uses synthetic fixtures. No live source receipt or first-user production result was examined. | `.agents/skills/verify-sentiment-desk/evidence/cloud-core-browser-22b0d126-74a3-42a9-a186-e7b2d32759a2.json`; cloud source gates in `supabase/functions/refresh-sec-company-evidence/index.ts` |

## Independent scores and disagreement

- Engineering reviewer: **2/8** at source-code level, counting the production entry and static sharing control. It still returned **FAIL** for the whole workflow.
- Finance reviewer: **3/8** at source-code level, also counting the chart implementation. It marked live chart behavior and fresh-user results unverified.
- User-workflow reviewer: **0/8 fully verified** because no rendered workflow was observed. It recorded four supported missing capabilities and four verification gaps.

These counts use different proof thresholds. Preserve the strict user-facing result as 0/8 end-to-end checks verified. Do not average the code-level scores into a product acceptance score.

## Chart correction and evidence

The reviewers found that SEC's `NYSE MKT` / `NYSE American` labels must map to TradingView's `AMEX` symbol prefix for verified examples, and SEC share-class dashes must map to TradingView dots (`BRK-B` to `BRK.B`). The adapter now makes those transformations and returns no chart for NYSE Arca or unknown exchanges until their exact mapping is verified. The user sees an exchange-delayed display-only chart, an explicit load button, and disclosure that TradingView tracks the embedding page URL, widget type, selected ticker, and IP address.

Primary source references:

- [TradingView UEC symbol page](https://www.tradingview.com/symbols/AMEX-UEC/) identifies the verified `AMEX:UEC` symbol.
- [TradingView BRK.B symbol page](https://www.tradingview.com/symbols/NYSE-BRK.B/) identifies the verified `NYSE:BRK.B` symbol.
- [TradingView widget data FAQ](https://www.tradingview.com/widget-docs/faq/data/) explains widget market-data timing and limits.
- [TradingView widget privacy FAQ](https://www.tradingview.com/widget-docs/faq/general/) says widgets track the embedding page URL, widget type, displayed symbol, and IP address.

The chart remains display-only. Its iframe test does not execute TradingView or prove that the selected symbol resolves. A live render and blocked-provider recovery have not been observed.

## Verification performed

- `npx vitest run tests/cloud-tradingview-chart.test.tsx --reporter=dot --maxWorkers=1`: **3 passed**.
- `npm test -- --reporter=dot --maxWorkers=1`: **151 test files and 1,291 tests passed**.
- `npm run typecheck`: passed.
- `npm run build`: passed. Vite reported a 568.42 kB minified main JavaScript chunk, above its 500 kB advisory threshold.
- `git diff --check`: passed.

No browser automation was performed because the user had previously prohibited it. The user's Gemini key was not entered in the application or used. No model provider request, hosted source refresh, hosted write, or deployment was performed.

The command results above were observed in this task but no standalone command-output artifact or identified task-transcript path is available. This limits later transcript-level auditing; the exact reported results are not being presented as a retained evidence file.

## Remaining acceptance work

The cloud product still needs evidence-led company discovery, company-level updates that explain reported changes, source-cited bull/bear/abstain summaries with counterevidence and next checks, and an authenticated per-user BYOK path for OpenAI, Gemini, and TypeSafe Jev. Then verify a fresh user's real-source workflow and the live TradingView symbol/load boundary through an allowed rendered workflow. Local app features do not satisfy cloud-route acceptance.
