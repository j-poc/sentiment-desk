# Core app continuation plan — 2026-10-13

## Done means

The primary deliverable is the local, single-user investor desk. A fresh user can search the SEC issuer directory without cloud account/backend setup, open a CIK-matched company workspace, see source-linked financial changes and an opt-in contextual chart, and request a transparent bullish/bearish/mixed/insufficient-evidence brief from selected SEC facts. The user supplies an OpenAI, Gemini, or TypeSafe Jev key through the app; local provider keys use the OS credential store. Each model request displays the exact provider/model and payload and requires fresh approval for that payload. SEC factual updates remain separate from model interpretation; TypeSafe Jev's source sentiment remains distinct from company fundamentals. No key save or verification automatically sends evidence to a model. A live provider result remains unverified until the user saves a key, reviews the item and destination, and explicitly approves that exact outbound request.

## Shared binary rubric

1. Fresh local startup opens the research UI, not a backend setup screen.
2. Issuer search leads to a CIK-verified saved company workspace and its My Research detail shows the same update, chart, and summary paths.
3. Company updates show comparable reported changes with periods, units, exact SEC records, filing links, and freshness; they do not infer materiality or investment merit.
4. The contextual chart uses the verified issuer/exchange, discloses delay and TradingView data sharing, and loads only on explicit action.
5. The company brief separates potentially bullish and bearish evidence, names unknowns, cites exact selected SEC records, and abstains when evidence is insufficient.
6. Provider/model and exact outbound evidence are shown before a request. Approval is bound to the company, provider, snapshot, and selected fact IDs and expires when any of them changes.
7. Local OpenAI, Gemini, and TypeSafe Jev choices retain distinct output contracts; keys stay in the OS credential store and never appear in browser status or application-authored logs.
8. A dispatched assessment has durable request accounting and can be recovered after restart without automatically retrying unknown delivery; saved results remain readable.

## Phases

1. Keep the SEC-only local first-run path and CIK-safe issuer discovery as the default.
2. Produce exact, deterministic SEC update cards; keep the display-only delayed chart behind an issuer-identity check and explicit load action.
3. Add a local OpenAI/Gemini company summary boundary that validates citations and records exact selected fact lineage; keep source-level Jev separate.
4. Verify normal-user UI, fresh isolated storage, live SEC data, persisted assessment recovery, and failure handling. Hosted Supabase deployment and unrelated release studies are out of scope for the user's “core app” selection.
5. Run independent Ponytail engineering, investor, and user-workflow review against the same local rubric; repair material findings and reverify affected paths.

## Data shape and boundary decision

`CompanyUpdate` is a discriminated result: `comparable_change` carries metric, exact current/prior fact IDs, values, units, periods, accession IDs, and optional validated percentage; `no_comparable_change` carries an explicit reason. This keeps an empty comparison distinct from a neutral business result.

`EvidenceAssessment` carries `stance` (`bullish`, `bearish`, `mixed`, or `insufficient_evidence`), bounded summary text, separate supporting/challenging/unknown lists, and SEC fact/filing IDs. The boundary rejects IDs outside the selected CIK and current published snapshots.

Use the local loopback API as the BYOK boundary. Reject browser-direct provider calls because they expose keys to page scripts and browser tooling. Save local keys only through the OS credential store; never place them in request JSON, status responses, or application-authored logs. A fresh per-request payload is loaded from the current CIK-bound SEC snapshot, previewed to the user, then sent only after confirmation. Keep provider-data-use and billing conditions visible, including Gemini's paid-service requirement in affected regions.

## Reuse decisions

- Adapt `shared/company-fundamentals.ts` types and the exact-decimal comparison behavior from `server/company-fundamentals.ts`. The cloud snapshot has a different native row shape, so add a narrow CIK/snapshot adapter rather than reusing SQLite persistence or server acquisition.
- Keep `CloudTradingViewChart`, `CloudIssuerDirectory`, Supabase RLS, SEC snapshot refresh functions, and immutable user decisions as existing owners.
- Qualify, but do not add, `@signal-atlas/research-ui`. Its catalog contract supplies display-only primitives and no SEC mapping, security boundary, or data lifecycle; adding it now would not reduce domain complexity.
- Keep TypeSafe Jev separate from a company fundamental summary. The existing Jev rubric evaluates source sentiment and cannot be relabeled as a bullish/bearish business thesis.

## Initial checkpoint

The repository was heavily modified before this continuation. Preserve all existing changes. A previous cloud-first view blocked the primary user behind Supabase configuration and lacked company-level outcomes. No live user key may be requested in chat or accessed outside the app's key field.

## 2026-10-11 live-data checkpoint

An isolated local run fetched the SEC ticker/exchange directory (10,435 rows), found Apple Inc. at CIK 0000320193, saved and read back its CIK-scoped workspace, and retrieved a live SEC CompanyFacts snapshot. The snapshot contained 183 selected fact rows and 24 comparable same-filing changes; SEC precision was missing on many values, so the app withheld percentages and labeled raw differences. The local chart and public RSS path also returned real Apple data. No provider key was entered and no classification was sent. The model-output criterion remains open, and this API evidence still needs a rendered UI check after the computer is available.

The validator now rejects common recommendation, forecast, target, and valuation wording. That gate is deliberately limited: it does not prove that a claim follows from its citations. A real provider output and an independently labeled evaluation set remain required before criterion 4 can pass.

## 2026-10-11 rendered local workflow checkpoint

The local investor desk was opened at `http://127.0.0.1:5175/` with a new temporary Apple-only database, leaving the pre-existing desk and earlier test database untouched. SEC issuer search loaded 10,435 directory entries, resolved AAPL to Apple Inc. / CIK 0000320193, and opened the existing canonical Apple workspace; the fresh desk contains one issuer. The source-backed screen showed 25 saved public feed rows, a Yahoo Finance quote, 66 receipt-verified chart observations, and an on-demand SEC facts refresh with 183 selected facts and four YTD-through-Q3 change cards. The chart displays its Oct 9 source time separately from Oct 11 retrieval time. The SEC cards link to filings, name date ranges and units, and withhold percentage changes because SEC precision metadata is unavailable.

The rendered UI also exposes **Model API keys**. Its OpenAI, Google Gemini, and TypeSafe Jev forms report no key saved; it states local encryption through the OS credential store, says key save/verification does not classify, and shows distinct provider/data-use terms, including Google's free-tier data-use notice. No API key was entered or read from another source, and no model request or classification was sent. The Luna chart explicitly identifies the empty state as unclassified rather than neutral.

The live feed result is not yet clean enough to support a trusted directional read: the 25 visible rows include at least one apparent off-target AT&T headline, and the UI reports 20 rows held by current company-name/provenance checks. Treat those records as review leads rather than Apple evidence until source relevance is improved. The reviewer-tested validator still cannot prove a statement is entailed by its cited values. Thus a real Gemini/OpenAI/Jev output, human-adjudicated semantic evaluation, hosted BYOK/auth/logging verification, and a fresh-user hosted run remain open acceptance criteria. The end-user workflow is rendered locally; the cloud route is not considered verified by that local screen.

The repair verification run reported 1,340 passing tests (161 files), with `npm run typecheck`, `npm run build`, and `git diff --check` passing. The production bundle still emits the existing large-chunk warning. Independent Ponytail engineering review passed its five scoped repair checks (10/10) while explicitly leaving model entailment unverified. Independent finance review scored the assessment workflow 3/10 (2/8 binary criteria); it also could not render the local page from its own reviewer surface. Preserve that disagreement with the parent browser evidence rather than converting either review into proof of hosted behavior.

## 2026-10-11 relevance-boundary and rendered-preview checkpoint

The shared issuer and business-relevance rules now cover the selected-company feed, classification eligibility, categorical chart history and bucket evidence, and Research Brief leads. Corrections include allowing an explicitly tickered joint-issuer story despite another ticker leading, holding Apple-grower news for identity review, allowing Apple as the actor in a supplier investment, and holding outside wealth-manager position updates. The $500 MacBook promotion and two advisor holdings remain saved and recoverable under relevance review. The Research Brief no longer returns the promotion.

The refreshed user-facing preview at `http://127.0.0.1:5175/` renders 21 saved Apple evidence rows, 20 Research Brief leads, a 66-point receipt-verified Yahoo chart, 183 SEC fact rows, and four qualified YTD-through-Q3 comparison cards. The screenshot-visible chart distinguishes its Oct 9 source time from Oct 11 retrieval time. The Luna categorical chart is correctly empty, not neutral; Gemini has no saved assessment. No model key was entered and no provider request was made. The isolated API was deliberately run saved-only with zero request caps. Its storage status reports disk pressure at about 192 MB available against a 1 GiB minimum, so source refresh, SEC refresh, and provider requests are paused.

Verification: 70 focused tests across identity, scoring, Research Brief API, and historical chart paths passed before the final manager-headline predicate was added. After that final predicate, the scoring suite passed 48/48 and TypeScript typecheck passed. The API readback confirmed 21 normal rows, three held relevance rows, and no held promotion/advisor headlines in Research Brief. The prior full suite passed 1,341 checks; two unrelated evidence-CLI subprocess tests exceeded Vitest's default 5-second timeout and then passed in isolation (31/31) with a 15-second timeout. Production build had passed before the final predicate. A subsequent focused integration rerun could not start three suites because the system volume returned ENOSPC. The local chart and saved SEC evidence were visibly checked in the browser.

Still open: a user-entered Gemini/OpenAI/Jev key and reviewed real model output; human-adjudicated citation-entailment evaluation; refreshed live data after storage capacity recovers; hosted auth, request-only key handling, and fresh-user workflow verification. Independent final reviews of the boundary patch are pending. Keep the overall goal open.
