# Saved-source archive search usability — 2026-10-06

## Acceptance focus

The saved-source archive should help an investor find and inspect real retained evidence without knowing a ticker or loading each company history. Search must match the visible saved headline/excerpt semantics, explain its bounded back-catalog scope, show the saved company assignment and separate source/retrieval clocks, expose judgment and source attribution, and return the investor to the exact row after a keyboard-accessible review. Two-character alphanumeric terms match whole words; longer terms remain case-insensitive text matches. A query-policy version change must invalidate old cursors and restart at page one while preserving filters. The journey is local and read-only; no source or classifier request is allowed.

## Verified defect and repair

In the rendered archive, `AI` initially returned 3,733 saved records because SQLite substring matching counted strings such as `Taiwan` and `daily`. The count was not a useful result set for the user's query. Search now token-matches two-character alphanumeric terms, documents that behavior, and versions cursors so a session from the prior matching policy returns to page one instead of displaying a misleading page-two subset. The real retained archive returned 2,099 exact `AI` token matches after the change. This measures saved records, not distinct articles or independent events.

A real stored AMD headline, “Can AMD’s CPU Business Fund Its AI Chip Ambitions?”, also previously showed a false “headline leads with Can AMD” warning. Question-leading words are removed before checking a possessive issuer subject; the headline no longer produces that warning.

## Rendered workflow evidence

The in-app desk at `http://127.0.0.1:8787/` was restarted over the existing 93.2 MB local database with external requests disabled. It reports `SAVED DATA ONLY`, zero records retrieved in the last 24 hours, and zero Luna requests. No product record or disposition was changed, and no provider request was sent.

- On reload, the existing `AI` page-two session recovered to page 1 with the same query and the new whole-word policy. The result count was 2,099.
- Searching `CPU Business` returned four saved records across AMD and Intel. The exact AMD row had pending judgment and no “Can AMD” mismatch cue.
- Opening that row showed its saved excerpt, Yahoo Finance feed time, separate October 4 retrieval time (two days old), unknown publisher publication time, source attribution and saved URL. The drawer states no classification request was sent.
- Keyboard Enter opened the reviewed row; keyboard Enter closed it. After results reloaded, the original AMD review button had focus, the query remained, and the search stayed on page 1.
- Searching the longer phrase `Hong Kong` retained phrase behavior and rendered four real matches, including the excerpt-only Jefferies/AAPL item. Source/feed time and retrieval time remain separately labeled.
- At the browser's actual 1156x895 viewport, `window.innerWidth`, document width, and body width are all 1156px; no horizontal overflow was observed. The in-app browser's documented 390px viewport override did not change its effective width, so 1440/390/320 responsive acceptance remains unverified.

The archive is stale back-catalog data: latest retrieval shown during review was October 4. It does not establish current coverage or market-wide discovery. Several source records for the same story appear under multiple collectors/company assignments. UI wording calls these saved records, not independent events, and warns that assignment does not establish issuer relevance.

## Investor scan correction after independent review

The fresh whole-build reviewer rated the archive path 6/10 and the whole product 4/10. Its observed `CPU Business` results were four saved rows forming two same-company repeated-title sets; `Hong Kong` included two same-title Jefferies rows and an Apple Pay story matched only through a Hong Kong excerpt mention. The high-effort advisor independently agreed that metadata-only RSS is not enough to label event convergence. It recommended prioritizing a real filing-backed issuer comparison over more archive development.

I made one bounded archive correction that keeps the actual records primary: each search result labels whether the query matched its headline, excerpt, both, or (defensively) neither; adjacent same-company rows with normalized identical headlines are presented in a keyboard-operable native disclosure. The group states its saved-record count, retains the issuer assignment in the collapsed summary, and disclaims distinct reporting. It preserves the source-time order by never moving a non-adjacent repeat next to its first occurrence. Each expanded record retains its own publisher, source/feed and retrieval clocks, judgment, URL, and review action. Counts remain record counts; no event, independence, convergence, or confidence score is generated.

The alternative was to keep four flat rows plus the existing broad warning, which leaves analysts to spot repeated headlines and excerpt-only matches themselves. Automated semantic clustering was rejected because these metadata and excerpts cannot establish event identity or reporting independence. The selected change uses the desk's existing dark, dense result cards and native disclosure behavior; no dashboard-wide redesign or new data visualization was warranted. Case-specific Mobbin screens were not available in the open browser session, and no Mobbin interaction claim is used as acceptance evidence.

The deciding usability observation is scan effort for a real query: four rows contained two adjacent same-company repeated-headline pairs, with the source rows still available for inspection. The expected outcome is fewer repeated headline blocks to scan while preserving full evidence review. No intended-user time or decision-accuracy result exists yet, so that outcome remains unverified. The group summary explicitly exposes its saved-record count and uncertainty to prevent a visual collapse from appearing to add confirmation.

## No-ticker recovery from an unavailable filing feed

The rendered starting state had a concrete navigation dead end: when the all-issuer SEC feed was unsupported, “Browse saved sources” opened the company roster. Reaching a headline without selecting a ticker required another navigation step, and an old company/history filter could make the saved evidence route look empty.

The recovery control now reads “Search saved archive” and opens the retained headline/excerpt search directly. It clears stale company and history filters first, keeps the company scope at all tracked companies, and explains that matches are historical leads rather than current coverage. The unsupported state still names the Hub configuration action and offers a read-only configuration recheck; it does not attempt SEC collection or classification. The product result and recovery path remain bounded to records already saved locally.

I reproduced the old route in the rendered app, rebuilt the actual served assets, and retried the same path. The new button landed directly in Search archive with the company selector at “All tracked companies” and a blank query. Searching the real saved phrase “CPU Business” returned four retained records in two same-title groups, with match location and retrieval age visible. The app continued to show `SAVED DATA ONLY`, zero source records retrieved in 24 hours, and zero Luna requests. This verifies a shorter recovery path, not a current discovery or investment outcome.

## Verification state

- Focused rerun after the recovery change: **33 tests passed across 2 files**. `npm run typecheck` passed. `npm run build` passed; the browser entry is 794.55 kB minified, above Vite’s 500 kB advisory threshold.
- The complete Vitest suite passed: **752 tests across 97 files**. `git diff --check` passed.
- Rendered acceptance at the 1156×895 in-app browser size verified the unsupported-feed recovery, direct search navigation, cleared stale filters, and four real saved records. The archive’s existing Enter/Space disclosure behavior and per-record source/retrieval clocks were previously verified. No current-coverage inference or provider/model request was made.
- The focused retained regression replay passed **10 tests across 2 files**. A current test-source comparison preserved the regression after making the unsupported-feed copy assertion more specific.
- Final public-source live ETL smoke is current and passes; `live_data_etl_gate.py check` fails only `sec_filings_current_hub_receipt`. The connected Hub still reports the all-filers SEC feed unsupported. No Jev/OpenAI classifier request or product observation was created by the smoke.
- A fresh independent reviewer returned **PASS for the scoped no-ticker recovery route** and **FAIL for whole-product readiness**. The remaining top usability gap is current no-ticker discovery: the search box only indexes stale records from tracked companies. That requires a supported all-issuer SEC acquisition path and current accepted evidence, not another control or panel.
- Independent whole-build reviews remain **FAIL / not ready** (4/10 whole product). They identify missing no-ticker issuer discovery, an unsupported current SEC 8-K Hub dataset, no qualified current Luna classifications, stale saved evidence, and unverified investor outcome value. The selected-company SEC fundamental comparison remains blocked while the Desk process lacks the required configured SEC contact identity; its value has not been revealed or requested.
- The full engineering alignment review, final engineering-gate receipt, and GitHub checkpoint readback remain pending.

## Whole-product verdict

This closes only local archive-search and recovery-navigation friction. It does not complete the desk. The 24-company list still cannot discover current small caps without a ticker; the SEC all-filers Hub receipt remains unavailable; the app has no qualified current Luna result in this offline run; followed-company evidence does not determine materiality; the latest saved source data is two days old; and intended-user acceptance results, independent outcome references, and legacy-unknown provider usage reconciliation remain open. Opportunity Radar remains disabled. The native task goal still contains obsolete Jev-core wording; the current project contract and user direction select Luna for new categorical classifications, while historical Jev remains separate. The available goal control changes status only, so the native objective itself cannot be edited from this workspace.

## Continuation verification on October 6

The actual browser recovery was retested from Recent Filings. Its unsupported SEC 8-K state showed the read-only Hub retry and the “Search saved archive” action. Clicking the action opened Search archive directly with a blank query and “All tracked companies”; entering “CPU Business” returned four retained records in two adjacent same-company title groups. I expanded the AMD group and verified that each row still exposes its own source, saved excerpt, feed clock, retrieval clock, classification state, source URL, and review action. Space collapsed and reopened the disclosure. The browser remained at 1156×895; the required 390px and 320px rendered checks remain unverified.

The focused archive and filing UI run passed **42 tests across five files**. The retained investor UI recovery regression passed **10 tests across two files**. `npm run typecheck` passed. A full repository run passed **752 tests across 97 files**; the quality-loop receipt bound all 54 candidate and previously uncovered paths. `git diff --check` passed.

The fresh live-data ETL `verify` completed. All required fixture, recovery, replay, offline-gate, bounded keyless public-source smoke, storage, and SEC protocol checks passed. The only failing required check is `sec_filings_current_hub_receipt`: the connected Hub still supplies no SEC 8-K receipt. The follow-up `check` confirms the new evidence is current and fails only for that missing receipt.

The fresh engineering-bullshit-detector review passed the 21-file incremental archive/recovery candidate and found the adjacent-only grouping preserves source-time order. Its whole-product verdict remains fail. The selected usability repair removes a navigation dead end; stale evidence and absent current ticker-free discovery still prevent the desk from delivering the core investment job.
