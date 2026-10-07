# SEC fundamentals recovery

The selected-company SEC fundamentals view shows what the saved filings support, keeps incomplete coverage partial, retains the last accepted facts when a later refresh fails, and reports the filing's observation age separately from when this app retrieved it.

## Sub-features

- `fundamentals-partial` preserves a revenue-only source response as partial coverage.
- `fundamentals-recovery` retains the last accepted snapshot after a later refresh failure.
- `fundamentals-observation-freshness` keeps SEC acceptance age distinct from retrieval time.
- `fundamentals-durable-readback` preserves snapshot and latest-attempt status across database reopen.

## How to get to it (user POV)

- Select a configured company and open its SEC fundamentals section.
- Use the `Refresh SEC facts` action when refresh is allowed.
- Reopen the company fundamentals section to inspect saved facts, freshness, and the last refresh error.

## Driving it with the isolated HTTP verifier

Preconditions:

- Follow `../SKILL.md` from the repository root.
- The helper starts its own loopback API server and isolated SQLite file; no existing runtime may be used.

- **Check the instance.** Run `npx tsx .agents/skills/verify-sentiment-desk/verify-sec-fundamentals-recovery.ts`. Its read-only `GET /api/health` must report `sentiment-desk-verifier-fixture` and a runtime ID before any refresh request.
- **Save incomplete coverage.** The helper sends `POST /api/companies/verifier-issuer/fundamentals/refresh` with a fresh request key. The resulting database snapshot must be `partial` and contain only revenue facts; the API must explain that the SEC observation is older than 365 days.
- **Inspect saved facts.** The helper sends `GET /api/companies/verifier-issuer/fundamentals`. The snapshot and retrieval time match the completed refresh, while source observation freshness remains stale.
- **Fail the next refresh.** The helper posts with a new request key; its deterministic adapter returns HTTP 503 at the submissions boundary. The API keeps the same snapshot and facts, preserves the original retrieval time, and reports the new failed attempt and its error.
- **Confirm durability.** After stopping the API and closing SQLite, the helper reopens the same file. The snapshot remains `partial`; the latest attempt remains `failed`.
- **Read proof.** The helper writes and reads back a unique run record in `.agents/skills/verify-sentiment-desk/evidence/` after cleanup.

## Gotchas

- A retrieval timestamp describes the saved response; it does not make an old SEC acceptance current.
- The API may report overall state `stale` when the accepted snapshot is partial and its newest SEC observation is old. Check the persisted snapshot state and coverage separately from freshness.
- A green fixture run exercises the real local API and SQLite path only. It does not prove that SEC is reachable or that the fixture matches current filings.
- Do not point the recipe at the desktop runtime database, add provider credentials, or allow the fixture adapter to fall through to global `fetch`.
