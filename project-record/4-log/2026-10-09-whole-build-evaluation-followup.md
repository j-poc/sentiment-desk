# Sentiment Desk whole-build evaluation follow-up

Date: 2026-10-09. Reviewer: independent read-only `engineering_bullshit_detector` subagent (`/root/whole_build_detector`). Scope: the full 33-item Sentiment Desk contract, the current candidate diff, current rendered UI observations, and the user's correction that private evidence is in scope only for configured public issuers and may be sent to GPT-6 Luna only after explicit item-level confirmation.

**Verdict: FAIL, 5.1/10.** This is not a release or operational-acceptance pass. Ratings: investor job 4/10; evidence integrity 7/10; evaluation/value 2/10; reliability 6/10; interface 7/10. The prior item matrix remains 16 pass, 13 unverified, 3 blocked, and 1 fail.

The reviewer found the current interface changes improve the first-screen filings hierarchy and do not alter source identity semantics. In the live local UI at 390×844, selecting AMD after Apple changed the company heading and plotted 50 receipt-verified Yahoo chart observations; their newest source observation was two days old, with refresh paused. At 320, 390, 1280×720, and 1440 widths, the document had no horizontal overflow. Wheel input over the header kept window, document, and app-root scroll positions at zero; input over the research pane moved only that pane. The recent SEC inbox showed 29 listed 8-K rows and explicitly withheld 10 uncertain issuer matches. The first filing displayed its CIK, accession, issuer security, and separately labeled missing filing/acceptance times. The capture at `output/playwright/sentiment-desk-mobile.png` is a local rendered view of those real saved records.

The focused inbox/reveal regression passed 26 tests; the complete test suite passed 1,153 tests across 128 files; the project SEC recovery verifier passed and removed its owned temporary data; typecheck and production build passed. The ETL gate passed with current evidence. These checks establish regression safety and scoped real-source/recovery behavior, not full investor acceptance.

The main investor job still fails: the recent SEC list is an unranked filing lead surface, not no-ticker small-cap discovery, a complete fundamental decision, or followed-company material-change monitoring. `server/market-cap-qualification.ts` is an exact-arithmetic, fail-closed calculation boundary only; it has no verified source ingestion, persistence, or UI path and is not a delivered screen. The saved price chart remains two days stale while quote refresh is paused.

GPT-6 Luna is the configured classifier but its live API credential is missing. A follow-on credential check found no key in the user-authorized iCloud credential file, current environment, or local build environment files; the search did not print or copy any credential. OpenAI's official model page confirms `gpt-6-luna` is an API model and that the API free tier does not support it ([model documentation](https://developers.openai.com/api/docs/models/gpt-6-luna)). There is no existing free key to recover. The chart correctly remains an explicit empty result; there is no real saved Luna classification, quality run, or real private-note analysis. The 30-task paired AlphaSense comparison, investor outcomes, and reconciliation of 4,700 quarantined `legacy_unknown` rows remain unverified or blocked. The private-note UI remains item-specific and explicit, but no real user note has been processed. Opportunity Radar remains disabled.

A direct desktop watchlist check at 1440×900 clicked Apple and then AMD. Each selection changed the company heading and price panel identity without page scrolling; AMD showed 50 real points with the same explicit two-day freshness and paused-refresh status. This confirms the originally reported stock-selection interaction through the watchlist control as well as through the mobile company selector.

Next acceptance work should connect verified issuer shares and an authorized current price source to a source-backed discovery-to-decision-to-follow workflow, then verify real Luna output and account usage, and complete the paired benchmark and historical usage reconciliation. Keep unavailable evidence visible; do not infer sentiment, materiality, issuer size, or model quality from empty or stale data.

## Core-app completion goal — 2026-10-09

The user asked to finish Sentiment Desk from first principles, then clarified
that the scope is **the core app**. The active goal covers the three real-data
investor tasks in engineering-contract acceptance criterion 2: no-ticker issuer
discovery, an evidence-backed decision about whether an issuer merits more
research, and a followed-company change review against an explicit saved
baseline. The paired AlphaSense evaluation, external benchmark, and uncoached
investor/analyst study remain outside this core-app implementation scope; their
release status is not changed by this decision.

The shared implementation-review rubric has ten binary checks: zero-input
first value; issuer discovery beyond the fixed roster and filings-only; sourced
size qualification; supporting/contradictory company evidence and a next
question; explicit persisted follow-up; event/source/retrieval/ingestion time
truth; actionable empty/stale/failure recovery; private-note consent; truthful
classifier/accounting boundaries; accessible navigation and source/storage
controls. Each criterion scores one point only when current evidence supports
yes. Two independent read-only reviews each scored the current app 7/10. Their
shared material gap is tickerless small-cap discovery. The reviews disagree on
whether first value and end-to-end time truth pass, based on earlier rendered
saved-data evidence versus the fresh-profile path.

Fresh-profile observation on this checkout: the first UI route is Recent
Filings, but the Desk-specific Hub connection is unavailable. The interface
correctly says the feed's source freshness is unknown and shows no substitute
rows; there is no separate issuer-universe discovery route. The current local
`.env` contains an external-request opt-in, descriptive SEC User-Agent, and
request/rights allowlist entries for Google/Yahoo RSS and price sources, SEC
filings/CompanyFacts, and Nasdaq symbol directories. This records the owner's
operational attestation; it does not close the source-rights review in
`live-data-etl.json`. The isolated fresh-profile walkthrough explicitly
overrode all external requests off and used a temporary SQLite file.

The existing research brief remains deterministic and source-bound, but its
compiler explicitly makes no market, sentiment, materiality, independence, or
research-worthiness claims. The followed-evidence panel reports newly eligible
receipt-backed evidence and explicitly does not judge importance or price
impact. These are the next product-model gaps after discovery. A syntax error
in the current ChatGPT-plan pause validator was fixed on this branch; the
checkout then passed TypeScript checking and web/server production builds. The
isolated app started successfully with external requests disabled.

Official source review: SEC's exchange/ticker mapping is periodically updated
but SEC does not guarantee its accuracy or scope. Nasdaq's current symbol
lookup includes all issues and its page describes the separate "Nasdaq Listed"
data as unrestricted, while the broader NasdaqTrader copyright terms still
restrict other reuse; source-use scope must stay attached to the exact feed.
Yahoo/Google rights and the broader market-cap source path remain open in the
existing live-data rights record. No source request was made during this
isolated app review.

## Core-app continuation — 2026-10-09

The direct SEC Atom 8-K path now provides an explicitly activated fallback
when the local Public Data Hub is absent or does not implement the filing
feed. It is bounded to 40 rows and 2 MB, uses the configured SEC User-Agent,
retains only a validated snapshot, rate-limits refresh, coalesces concurrent
requests, and recovers from its compressed, digest-checked local SQLite cache.
The active Nasdaq listing-directory match remains required before a row is
shown. The first view remains local-only; the offline browser run made no
source request. This is a more resilient recent-filing lead path, not a broad
issuer-universe or small-cap discovery screen.

Company research briefs now surface exact, comparable SEC fact-pair changes as
analyst follow-up leads with filing provenance and concrete next questions.
They do not claim materiality, valuation impact, causal explanation, company
quality, or a buy/sell result. Followed-company baselines disclose repeated
headline text and publisher labels as review aids only; they do not infer
independent reporting or materiality.

The saved-snapshot reader also checks that the embedded receipt ID matches its
database key. Recovery copy now gives the local SEC status action and renders
the source-gate detail once. The isolated offline UI showed the external-source
gate, unknown source freshness, zero saved rows, and explicit disclaimers; it
showed no duplicate pause warning.

Verification on this continuation: the targeted SEC inbox, research brief,
followed-baseline, and database regression slice passed 118 tests; the
standalone private/SEC recovery verifier passed with its owned temporary data
removed; the verifier helper's separate TypeScript configuration passed; the
production web/server build passed. The production web bundle remains about
918 KB minified and triggers Vite's existing 500 KB chunk warning. A fresh
repository typecheck passed. The first offline startup gate run found that its
request auditor expected only the two Nasdaq files, while the direct SEC path
correctly requests those files plus one SEC Atom feed under both approvals. The
auditor now requires exactly those three GETs and zero requests when an
approval is missing; the rerun passed. The verifier feature map now describes
the direct SEC path and its limits.

The current-source ETL `verify` run failed three checks: the offline startup
gate (before its verifier fix), the bounded keyless live-source smoke, and the
existing current-Hub-receipt check. That command runs the whole live-data
contract, including a public RSS/GDELT/Yahoo smoke; I will not repeat that
network check in this core-only pass. Its failure output records check IDs and
digests, not the underlying command output. The Hub-only check predates the
direct SEC fallback. Because source code changed after that run, its evidence
fingerprint is stale and does not certify this checkout. No live SEC/Nasdaq
restart receipt was established in this continuation.

Three fresh independent read-only reviews (engineering, finance, and investor
workflow) each scored the candidate 7/10 on the shared binary rubric. All
three marked checks 1–3 NO: no useful fresh zero-input issuer lead, no broad
company/fundamental discovery or sourced size qualification, and no completed
company research-worthiness workflow. They marked the other seven criteria
YES. The engineering reviewer initially raised a possible storage-before-fetch
issue, then withdrew it after confirming the production global fetch gate
checks storage before every external dispatch. The other reviewers noted
limits in their offline-only evidence; no populated private user database or
live source response was used in their walkthroughs.

Core completion still has these material product and evidence gaps: the first
screen lacks broad no-ticker issuer discovery; no verified source chain combines
a point-in-time price, dated shares, and corporate actions for size labels;
company briefs still do not resolve a research-worthiness decision; and
follow-up evidence is not a material-change judgment. Yahoo/Nasdaq/Google
source-use rights remain
unresolved in the current rights record. The app must not relabel these
capabilities or treat operator allowlists as proof of third-party rights.
