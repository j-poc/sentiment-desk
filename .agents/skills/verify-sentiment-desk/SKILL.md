---
name: verify-sentiment-desk
description: Verify investor company updates, local BYOK provider keys and source-bound assessments, SEC fundamentals recovery, explicit private-evidence consent, listed-issuer filtering, source-bound SEC filing research cases, and hosted cloud company research and request-only assessments.
---

# Verify Sentiment Desk

Use this skill for targeted checks of local investor research and provider-key journeys, selected-company SEC fundamentals recovery, public-issuer private-evidence consent, the SEC Recent Filings listing gate, source-bound filing research cases, and the authenticated cloud core. The legacy fundamentals and private-evidence recipe drives an isolated loopback instance backed by temporary SQLite databases. Cloud core uses a local Supabase Auth/Postgres/Edge Functions stack and a static web client; it does not fall back to SQLite. Fixture responses are verification evidence only. They make no claim about current source availability or live classification quality.

## Launch

From the Sentiment Desk repository root, run:

```sh
npx tsx .agents/skills/verify-sentiment-desk/verify-sec-fundamentals-recovery.ts
```

The helper starts its own Hono HTTP server on `127.0.0.1` and an OS-assigned ephemeral port. It reports ready only after that server answers `GET /api/health` with the expected verifier build and a runtime ID. It owns the server, port, and temporary SQLite directory for the full run; do not connect another driver to them.

## Doctor

The first request is a read-only `GET /api/health`. The run proceeds only if the response is healthy, names `sentiment-desk-verifier-fixture`, includes a runtime ID, and came from the just-started loopback server. The route is unauthenticated on this isolated local app. A doctor failure is a blocked run, not a product pass.

## Drive

The helper drives the mapped SEC fundamentals and private-evidence flows through ordinary HTTP requests to the app's public API:

1. `POST /api/companies/verifier-issuer/fundamentals/refresh` with a fresh UUID request key. Its injected SEC boundary returns a deterministic revenue-only fixture. The app must retain the coverage gap in a `partial` SQLite snapshot. The fixture's SEC acceptance timestamp is older than 365 days while retrieval occurs in this run, so the API must report source observation staleness.
2. `GET /api/companies/verifier-issuer/fundamentals` must return the same snapshot and recent retrieval timestamp while still explaining that the underlying SEC filing is old.
3. A second `POST` uses another request key. The injected boundary returns HTTP 503 for the submissions response after returning the directory receipt. The API must retain the accepted facts and snapshot retrieval time, expose the failed attempt and error separately, and continue to report the observation as stale.
4. After stopping the server and closing SQLite, the helper reopens the same database and verifies the persisted partial snapshot and failed latest attempt.

5. In a separate private-evidence SQLite store under the same temporary directory, the helper saves an explicitly labeled verifier-only note for one configured public fixture issuer. The issuer allowlist excludes the second fixture company. It verifies that list responses reveal metadata but not note text, detail readback returns only the selected issuer's note, and the excluded issuer cannot read the item.
6. The helper sends an analysis request without `confirmExternalProcessing: true`; the API must reject it before dispatch or attempt persistence. It then sends the explicit confirmation for that exact note. A local verifier callback checks company, item ID, and content digest, reserves the bound attempt, and returns a clearly synthetic response fixture. Repeating the request must reuse the saved response without a second callback. The fixture must not reach the OpenAI endpoint. The public mentions feed and real-observation count stay empty.
7. After stopping the API and closing both SQLite stores, the helper reopens them and verifies the private note and its item-bound analysis are durable without creating a public observation.

The helper exercises the API consent boundary and persistence. It does not interact with a real user note, use an account API key, or prove model quality. The UI disclosure and cancellation path remains covered by the native component test `tests/private-evidence-panel.test.tsx`.

Only loopback API traffic is sent. The fixture adapter accepts exactly the three SEC-shaped fixture URLs; an unexpected URL fails the run. A fixture result is test evidence only and never proves current SEC availability or live-source coverage.

## Evidence

Each invocation writes a new `evidence/<run-id>.json` after cleanup. The record includes the run ID and timestamps, Git HEAD, hashes of the relevant current product files, a hash of the verifier and feature map, non-secret run configuration, environment identity, exact HTTP actions, fixture request outcomes, API observations, and reopened-database readback. Private note contents are never copied into the evidence record; only the content digest and identifiers are retained. The helper reads the record back and checks that its run ID and result match this invocation. Existing evidence is never reused as current proof.

## Cleanup

The helper closes only the HTTP server it created, closes each SQLite handle it opened, and removes only its own `sentiment-desk-verification-*` temporary directory. It writes proof after cleanup under this skill's `evidence/` directory and reads it back before exit. Keep evidence files; they are run records, not scratch data. If the helper is interrupted, remove only a temporary directory created by that run after confirming no process still owns its recorded port.

## Helpers

`verify-sec-fundamentals-recovery.ts` implements launch, doctor, drive, evidence binding, durable readback, and cleanup in one executable recipe. Run it with the command above; it does not require a separately launched app, seeded production database, or provider credentials. Its local `tsconfig.json` explicitly includes this helper, which the repository-wide TypeScript config otherwise excludes:

```sh
./node_modules/.bin/tsc -p .agents/skills/verify-sentiment-desk/tsconfig.json --noEmit
```

The standard test suite is supplemental. Run its focused UI/API regression boundary when verifying private-evidence consent:

```sh
npm test -- --reporter=dot --maxWorkers=1 --testTimeout=20000 tests/app-private-evidence.test.ts tests/private-evidence-panel.test.tsx
```

## Cloud core

Read [the cloud core feature recipe](./features/cloud-core.md) before driving. It covers the authenticated issuer directory, CIK-scoped company research decisions, followed-company evidence baselines, source-use gates, privacy, identity guards, and readback after a PostgreSQL container restart. The API verifier seeds only local, synthetic SEC-shaped records and deletes them in its cleanup path. It rejects a non-loopback Supabase URL and must never be run against a hosted project.

The browser recipe uses a local Supabase magic link captured by the local Mailpit inbox. It does not send email externally. Keep both SEC source gates false while verifying. Do not interpret synthetic verifier records as live filings or financial facts.

## Local provider keys and assessments

Use the changed credential and one-source flow checks before relying on local BYOK behavior:

```sh
npx vitest run tests/typesafe-jev-byok.test.ts tests/typesafe-jev-byok-api.test.ts tests/model-provider-credential-vault.test.ts tests/model-provider-settings-ui.test.tsx tests/model-provider-classifier.test.ts tests/external-request-gate.test.ts
```

These checks cover encrypted provider-scoped local credentials, the visible OpenAI/Gemini/TypeSafe cards, global request-pause enforcement, one source-bound Jev assessment, daily usage persistence, and the no-replay path when delivery is uncertain. Paused verification does not consume its allowance, and a classification blocked at the final network boundary is retained as not sent. Jev results remain in their separate append-only tables and feed; they do not alter the legacy scoring queue or categorical provider results. The adapter uses a fake response in tests, so passing them is not evidence of a live provider account or model quality.

The live local desk can be checked through ordinary read-only HTTP routes at the user's loopback origin: `/api/companies/apple/mentions?hours=24&limit=5`, `/api/companies/apple/price?ticker=AAPL&hours=72`, `/api/sec-issuer-directory?q=AAPL`, and `/api/model-providers/status`. Check real source URLs, retrieval times, Yahoo delivery attribution, current SEC directory freshness, and that each provider status reveals only whether a key is configured. A chart with saved prices and a live public source is real-source evidence; it is not model-classification evidence.

Never ask users to put provider secrets in chat. A live model request requires the user to enter their key in Model API Keys, review the exact source fields and provider terms in the source drawer, and affirmatively send that one item. Save and verify must not classify a source. Keep TypeSafe Jev visible as its own model and series, separate from OpenAI and Gemini. Do not use a credential from the OS vault for automated tests or expose credentials in evidence. A live provider result remains unverified until the user completes that UI flow.

## Feature map

Read [the feature index](./features/README.md) before driving. The map covers investor company updates, local BYOK credentials and source assessments, selected-company SEC fundamentals recovery, local private-evidence consent, the Recent Filings active-listing cache, the source-bound SEC filing research case, and the hosted cloud core. The research case needs an isolated real-source run; the fixture helper does not drive it. This skill does not certify live Luna classification quality, investor outcomes, or rendered cross-device journeys.

For verifier upkeep, use `$maintain-verification-skill` to reconcile this recipe and map with the source before relying on a later run.
