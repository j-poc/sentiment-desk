# Cloud core

This workflow verifies the three hosted core tasks: issuer discovery without a prepared local dataset, a CIK-scoped company research decision tied to exact SEC snapshot and row IDs, and followed-company accession changes compared with a versioned user baseline. The shared binary acceptance rubric is in [the cloud core architecture record](../../../../project-record/3-project-specs/2026-10-09-cloud-core-architecture.md).

## Isolated API verification

Use only a disposable local Supabase stack on Docker context `colima-sentiment-desk-verify`. Set `DOCKER_CONTEXT` per command; do not change the user's global Docker context. The verifier refuses a non-loopback Supabase API and expects `http://127.0.0.1:54321` by default. For a separate disposable project, set the API-port and project-directory overrides below.

The script needs a clean local source database because it publishes directory and source snapshot heads for its fixture CIKs. `supabase db reset --local --no-seed` deletes all rows in that local database. Run it only when the database contains disposable verification data or after preserving any human-created local records. Never point this recipe at a hosted Supabase project.

The API verifier calls each authenticated Edge Function handler directly against the isolated local Supabase API. It first checks that a closed source gate stops before transport, then uses an injected fixture transport for enabled publication and failure paths. This does not send SEC requests. The browser check below additionally needs the local functions served with both source gates closed. Its temporary environment file can contain only these non-secret settings:

```sh
SEC_DIRECTORY_SOURCE_ENABLED=false
SEC_COMPANY_DATA_ENABLED=false
APP_ALLOWED_ORIGINS=http://127.0.0.1:5173,http://localhost:5173,http://127.0.0.1:5174
```

Use that file when serving functions for the browser check. Run the API verifier with:

```sh
DOCKER_CONTEXT=colima-sentiment-desk-verify npm run verify:cloud-core
```

The helper creates temporary authenticated users and synthetic SEC-shaped records. It checks current directory search, RLS isolation, anonymous denial, accession-prefix/CIK identity, publication timestamps across all three source types, hidden staging rows, decision rejection of unpublished evidence, append-only source-bound decisions, versioned and stale-baseline behavior, a 1,200-record accession comparison, exact snapshot metadata returned atomically with the comparison, an explicit count when more than 50 new accessions are bounded from the UI list, scoped unfollow history retention, disabled source gates, and cleanup. The Edge Function harnesses track request keys, locate handler-created snapshots and receipts, check each cleanup operation for errors, and assert their fixture records are removed. At the end it restarts the configured local Postgres container without resetting the volume, then reads the saved decision digest and each full baseline count back through the authenticated API. The script removes its users and records in `finally`, checks its tracked runs and snapshots are gone, and after interruption instructs operators to inspect only this isolated local database before rerunning. A passing run writes a digest-bound JSON record to `evidence/cloud-core-<run-id>.json` after cleanup and reads that record back before exiting.

To preserve an existing local volume, the verifier can target a separate disposable Supabase project by setting `SENTIMENT_DESK_SUPABASE_PROJECT_DIR` to its project directory and `SENTIMENT_DESK_SUPABASE_API_PORT` to its configured loopback API port. The default remains this repository's local project and port 54321. `SENTIMENT_DESK_SOURCE_REPO` can point evidence at the source repository when the verifier runs from a disposable copy.

`npm run typecheck`, `npm run build`, `npx vitest run tests/cloud-research-desk-follow.test.tsx tests/sec-company-data.test.ts tests/sec-issuer-directory.test.ts tests/cloud-issuer-directory-status.test.ts --reporter=dot --maxWorkers=1`, and `DOCKER_CONTEXT=colima-sentiment-desk-verify supabase db lint --local --fail-on error` provide focused static, rendered UI, parser, build, and schema checks. None substitutes for the API run.

## Request-only company evidence assessment

The optional cloud assessment uses only selected, authenticated SEC facts and filing metadata. Before a live request, the user must see the exact evidence, canonical SEC links, provider/model, instructions, and provider terms, enter their own key in the UI, and submit once. The app sends that key in the request header and does not save the assessment. Never put a key in a fixture, test output, or evidence record.

Run the focused boundary and UI checks with:

```sh
npx vitest run tests/sec-company-data.test.ts tests/cloud-company-updates.test.ts tests/cloud-company-updates-ui.test.tsx tests/cloud-evidence-assessment-ui.test.tsx tests/cloud-issuer-directory-open-research.test.tsx tests/cloud-research-desk-isolation.test.tsx
deno check supabase/functions/assess-company-evidence/index.ts supabase/functions/assess-company-evidence/index_test.ts
deno test supabase/functions/assess-company-evidence/index_test.ts
```

These checks cover issuer-based SEC URL normalization (including legacy archive paths), matching assessment preview/citation links, invalidation when selected evidence changes, HTTP error recovery, request-only key handling, and opening saved companies. They do not prove a live SEC refresh, rendered hosted journey, provider response quality, or deployment logs. A live provider request needs the user to enter their own key and affirmatively submit one reviewed request. Jev remains a separate source-level classifier; this SEC-only cloud screen has no source-text feed and must not present Jev output as a company bull/bear thesis.

## Authenticated browser path

Start Vite in cloud mode against the loopback Supabase URL and its public/publishable key. Do not place a service-role key in any `VITE_*` variable. In development, the browser client accepts HTTP only for `localhost` or `127.0.0.1` with an explicit port; hosted builds require HTTPS. This permits a second Vite/Supabase pair to exercise a disposable stack without resetting the usual local stack. For the recorded run, Vite used port `5174`, Supabase used API port `55321`, and the disposable Supabase redirect allow-list included `http://127.0.0.1:5174`.

Use a disposable `example.test` sign-in address and complete the magic link through that stack's local Mailpit/Inbucket. No external email is sent. With the refresh gates closed, prepare synthetic, clearly labelled directory, CompanyFacts, and submissions snapshots in the disposable database; do not invoke either SEC refresh action. Then verify the rendered name-only search and issuer save, exact-CIK facts and filing, selected-evidence decision save/readback, follow and baseline v1, and the same saved work after a PostgreSQL restart and browser reload. Sign out and remove only the tracked test account and fixture IDs; read back zero fixture users, heads, rows, and leases.

The observed synthetic browser journey is retained at `evidence/cloud-core-browser-22b0d126-74a3-42a9-a186-e7b2d32759a2.json`; its corresponding API/function suite is `evidence/cloud-core-03ac87a0-22a6-4c81-a4a0-385c853888f3.json` (95 recorded assertion entries passed, 0 failed, across 75 distinct labels). The JSON is an observation summary without screenshots, DOM captures, network traces, or database query output. Its Edge test harness resets cooldowns and removes only released leases (`lease_token IS NULL`), then verifies fixture cleanup; an active lease is preserved and causes verification to fail.

The retained browser journey demonstrates name-only discovery, an evidence-bound decision, follow and baseline v1, restart and reload readback, and cleanup. The additional visible states below are recipe checks for a future full browser run. The retained journey does not prove their rendered states.

Verify these visible states:

- Discover shows the SEC ticker/exchange source, retrieval state, and that the mapping does not establish current listing, company size, or investment merit. With no published snapshot, issuer search stays empty. Refresh with the source gate closed explains that no source request was made and leaves the current snapshot unchanged.
- Company research explains that an issuer must first be saved from Discover. It must not show facts, filings, or decisions for a different CIK.
- Followed evidence explains the exact accession-based comparison and that availability does not claim materiality. Postgres compares the complete captured snapshot by accession and returns an atomic snapshot/baseline envelope with a bounded 50-row review list and the count of any omitted accessions. Unfollow uses an owner-scoped database action, archives the follow, and keeps its baseline history visible in the UI; a later re-follow creates a new active history while the archived one remains readable. With no active follows, the UI says no companies are followed and can still show archived history.
- Reloading the browser restores the local authenticated session. The API verifier separately proves account isolation and database restart readback.

## Proof limits

SEC-shaped fixtures are synthetic test records, not filings or financial facts. Do not display them as product data. An earlier authenticated empty/gated browser observation has no retained capture and is not counted as verified. The positive path separately proves the listed local rendered workflows and database recovery against synthetic rows. The directory and company-evidence Edge Function harnesses inject stub transports and exercise gate enforcement, receipt publication, replay, and last-good failure paths; neither contacts `sec.gov`. Neither fixture path establishes current SEC availability, source-use rights, a permitted live receipt, managed deployment, or hosted durability.

Both the gated first-run observation and the positive synthetic journey are recorded in [the cloud core browser check](../../../../project-record/4-log/2026-10-09-cloud-core-browser-check.md).

The focused DOM test `tests/cloud-research-desk-follow.test.tsx` separately renders a synthetic saved issuer and filing snapshot, makes initial baseline capture fail after the follow succeeds, and verifies that the user can retry from Followed evidence and read back baseline v1. It uses mocked Supabase responses; it is a component recovery check, not an isolated-database browser workflow.

## Share-price context chart

`CloudTradingViewChart` is mounted in selected-company research. The chart uses the SEC issuer's ticker and exchange only after a strict provider-symbol mapping. Nasdaq and NYSE retain their exchange prefixes; NYSE MKT / NYSE American uses TradingView's `AMEX` prefix; SEC share-class dashes become TradingView dots (for example `BRK-B` → `BRK.B`). NYSE Arca and unknown exchanges remain unavailable until their exact TradingView symbols are verified. Never fall back to an unqualified ticker or assume that a syntactically valid symbol resolves to the intended company.

The 12-month daily, exchange-delayed TradingView frame must remain unloaded until the user activates **Load chart from TradingView**. Before loading, disclose that the data are delayed and that TradingView tracks the embedding page URL, widget type, selected ticker, and IP address. Keep the frame sandboxed without `allow-same-origin`, apply `no-referrer`, and do not pass model keys or other account data to the frame. If the provider blocks the frame or does not resolve the symbol, keep the limitation visible and offer the TradingView source link; do not draw a local substitute from unlicensed data.

Run `npx vitest run tests/cloud-tradingview-chart.test.tsx --reporter=dot --maxWorkers=1` for the deterministic UI and mapping checks. This verifies exchange mapping, unsafe-identity rejection, delayed-data/privacy disclosures, opt-in loading, and iframe isolation attributes. It does not execute TradingView, prove that a live ticker resolves, or establish a live quote timestamp. The live widget render remains a manual browser check; do not claim it passed from the DOM test alone.
