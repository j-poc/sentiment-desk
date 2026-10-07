# Historical SEC learning check adoption — 2026-10-07

## Scope

Adopt three established SEC fundamentals failure guards in a bounded, executable verifier: revenue-only data remains partial; a failed later refresh preserves the last accepted snapshot; and recent retrieval time does not make an old SEC observation fresh. No product source, API contract, package script, global skill, `AGENTS.md`, active runtime, or production database was changed.

## Coverage before this change

- `tests/company-fundamentals-service.test.ts` already used a revenue-only fixture and expected `partial`. It also verified that a later failed request retained the prior snapshot and fact IDs, and that completed SEC endpoint receipts remained persisted. This exercised the service and database directly.
- `tests/app-company-fundamentals.test.ts` already drove the selected-company fundamentals route through Hono, asserted a fixture refresh returned `partial`, and read saved facts through the GET route. It did not combine a good refresh and a subsequent failed refresh in the public API journey.
- `tests/sec-filings-inbox.test.ts` already separated receipt retrieval from SEC feed observation freshness for the separate 8-K inbox. It did not cover fundamentals snapshot freshness.

The source already stores snapshot retrieval time separately from the latest attempt and calculates observation age from SEC acceptance timestamps. The missing acceptance check was the complete HTTP path plus reopened durable state across the failed refresh, including an old SEC observation behind a recent retrieval.

## Added coverage

`tests/historical-sec-recovery-api.test.ts` starts an isolated loopback Hono server and file-backed temporary SQLite database. It sends a deterministic revenue-only SEC-shaped fixture through the selected-company refresh API, reads the saved view through GET, injects HTTP 503 at the submissions boundary on the next refresh, then closes and reopens SQLite. The assertions distinguish the partial saved snapshot from the latest failed attempt, require the snapshot retrieval time and facts to remain unchanged, and require old SEC acceptance to remain stale despite a recent retrieval.

The test fixture initially used a 2026-02-05 acceptance timestamp against a frozen 2026-10-07 clock. Its freshness assertion failed (`expected 'stale', received 'partial'`), correctly exposing that the fixture was only about 244 days old. The fixture was corrected to 2025-02-05 with accession `0000320193-25-000001` and matching 2023/2024 revenue periods. The focused regression then passed.

The new `.agents/skills/verify-sentiment-desk/` skill maps this single recovery feature and provides a runnable launch, doctor, API drive, current-run evidence binding, and cleanup recipe. Its helper uses only an isolated temporary SQLite instance and a closed deterministic fixture adapter. It allows no provider fallthrough and checks the exact five fixture requests, including the injected 503 at the submissions URL. The helper records start and end fingerprints for the relevant product and verifier files and fails if they change during the run.

## Verification

- `./node_modules/.bin/vitest run tests/historical-sec-recovery-api.test.ts` — PASS, 1 test.
- `./node_modules/.bin/tsc --noEmit` — PASS.
- `./node_modules/.bin/tsc -p .agents/skills/verify-sentiment-desk/tsconfig.json --noEmit` — PASS; this explicitly includes the verifier helper, which the root TypeScript include excludes.
- `./node_modules/.bin/tsx .agents/skills/verify-sentiment-desk/verify-sec-fundamentals-recovery.ts` — PASS. Run ID `55b77d6e-b974-43f9-b35c-56b278cc221d`; evidence: `.agents/skills/verify-sentiment-desk/evidence/55b77d6e-b974-43f9-b35c-56b278cc221d.json`.

The accepted run used Git HEAD `23ae9f23305edc0f3982382894e2ca497f9f689f`, Node `v26.8.1`, and an owned ephemeral loopback port. Product fingerprint matched before and after the drive: `e5a49c23500ef6e2382fa831e53eac22eed3e5cde84d9face636b4fa81d921b3`. Verifier fingerprint also matched before and after: `89ae84d22ad4d7500e1901cd7a583eb73289efbffbd16eb3f1c575af8c288ce3`. The public API retained the same snapshot ID and `retrievedAt` after the failed refresh; `latestAttemptAt` advanced and `lastRefreshError` exposed HTTP 503. Reopened SQLite read back `snapshotState=partial`, two revenue facts, and `latestAttemptStatus=failed`. The isolated server and temporary directory were removed; the run record was read back after cleanup.

An earlier verifier iteration exited nonzero after its post-cleanup evidence validator looked for `productFingerprint` at the wrong JSON level (`ZodError`, expected string, received undefined). That iteration is not accepted as a pass; this record preserves the failure, and the validator was corrected before the accepted run. The earlier successful run `4eba27fa-38e1-4465-aeef-c287221ea36d` used the verifier before end-of-run fingerprint checks existed, so it is retained but superseded by run `55b77d6e-b974-43f9-b35c-56b278cc221d`. Two additional launch attempts that stopped on a verifier variable-name error remain recorded as `FAIL` evidence with zero drive actions and successful cleanup. None of those intermediate records substitutes for the accepted run above.

## Limits

All SEC-shaped responses are deterministic historical test evidence. Live SEC source availability is **UNVERIFIED** because external source/provider calls were explicitly out of scope. No live SEC or Public Data Hub request, model-provider request, paid request, model download, production database access, or active-runtime write occurred. The recipe verifies the public local API and durable storage path; rendered browser behavior remains **UNVERIFIED**.
