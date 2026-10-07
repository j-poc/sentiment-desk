---
name: verify-sentiment-desk
description: Verify Sentiment Desk's selected-company SEC fundamentals API, especially partial coverage, retained snapshots, and source freshness.
---

# Verify Sentiment Desk

Use this skill for a targeted real-API check of the selected-company SEC fundamentals journey. The recipe binds a run to current source and verifier fingerprints, then drives an isolated loopback instance backed by a temporary SQLite database. The SEC adapter receives deterministic, clearly labeled fixtures; it makes no SEC, model-provider, or paid calls.

## Launch

From the Sentiment Desk repository root, run:

```sh
npx tsx .agents/skills/verify-sentiment-desk/verify-sec-fundamentals-recovery.ts
```

The helper starts its own Hono HTTP server on `127.0.0.1` and an OS-assigned ephemeral port. It reports ready only after that server answers `GET /api/health` with the expected verifier build and a runtime ID. It owns the server, port, and temporary SQLite directory for the full run; do not connect another driver to them.

## Doctor

The first request is a read-only `GET /api/health`. The run proceeds only if the response is healthy, names `sentiment-desk-verifier-fixture`, includes a runtime ID, and came from the just-started loopback server. The route is unauthenticated on this isolated local app. A doctor failure is a blocked run, not a product pass.

## Drive

The helper drives the mapped SEC fundamentals flow through ordinary HTTP requests to the app's public API:

1. `POST /api/companies/verifier-issuer/fundamentals/refresh` with a fresh UUID request key. Its injected SEC boundary returns a deterministic revenue-only fixture. The app must retain the coverage gap in a `partial` SQLite snapshot. The fixture's SEC acceptance timestamp is older than 365 days while retrieval occurs in this run, so the API must report source observation staleness.
2. `GET /api/companies/verifier-issuer/fundamentals` must return the same snapshot and recent retrieval timestamp while still explaining that the underlying SEC filing is old.
3. A second `POST` uses another request key. The injected boundary returns HTTP 503 for the submissions response after returning the directory receipt. The API must retain the accepted facts and snapshot retrieval time, expose the failed attempt and error separately, and continue to report the observation as stale.
4. After stopping the server and closing SQLite, the helper reopens the same database and verifies the persisted partial snapshot and failed latest attempt.

Only loopback API traffic is sent. The fixture adapter accepts exactly the three SEC-shaped fixture URLs; an unexpected URL fails the run. A fixture result is test evidence only and never proves current SEC availability or live-source coverage.

## Evidence

Each invocation writes a new `evidence/<run-id>.json` after cleanup. The record includes the run ID and timestamps, Git HEAD, hashes of the relevant current product files, a hash of the verifier and feature map, non-secret run configuration, environment identity, exact HTTP actions, fixture request outcomes, API observations, and reopened-database readback. The helper reads the record back and checks that its run ID and result match this invocation. Existing evidence is never reused as current proof.

## Cleanup

The helper closes only the HTTP server it created, closes both database handles it opened, and removes only its own `sentiment-desk-verification-*` temporary directory. It writes proof after cleanup under this skill's `evidence/` directory and reads it back before exit. Keep evidence files; they are run records, not scratch data. If the helper is interrupted, remove only a temporary directory created by that run after confirming no process still owns its recorded port.

## Helpers

`verify-sec-fundamentals-recovery.ts` implements launch, doctor, drive, evidence binding, durable readback, and cleanup in one executable recipe. Run it with the command above; it does not require a separately launched app, seeded production database, or provider credentials. Its local `tsconfig.json` explicitly includes this helper, which the repository-wide TypeScript config otherwise excludes:

```sh
./node_modules/.bin/tsc -p .agents/skills/verify-sentiment-desk/tsconfig.json --noEmit
```

## Feature map

Read [the feature index](./features/README.md) before driving. The current map covers the bounded selected-company SEC fundamentals recovery journey only.

For verifier upkeep, use `$maintain-verification-skill` to reconcile this recipe and map with the source before relying on a later run.
