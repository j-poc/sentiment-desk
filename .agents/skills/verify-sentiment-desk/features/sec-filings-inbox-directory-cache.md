# SEC Recent Filings listed-issuer cache

Recent Filings may display an SEC 8-K row only when the issuer matches exactly one current security in both official Nasdaq Trader symbol-directory files. The directory evidence is public source data, cached locally in the existing desk database with a compressed size bound and SHA-256 integrity check. Security names are bounded at 512 characters; the live directory contains a legitimate 214-character listed-security name, which must remain valid through cache reload. The cache is reusable across process restart only while its source-clock age is within 24 hours. Expired, malformed, or corrupt snapshots fail closed: SEC rows remain withheld and the UI explains the listing gap.

## User path and observable behavior

- Open Recent Filings for a configured listed issuer and inspect the verified symbol, exchange, listing-directory creation and retrieval times, and SEC receipt times.
- When external requests are disabled or source approvals are absent, the screen remains paused and makes no provider request; a missing verified directory keeps SEC rows withheld.
- When acquisition is explicitly enabled, `POST /api/sec-filings-inbox/activate` fetches the two bounded public listing directories. If the local Public Data Hub has no usable SEC 8-K feed, that same explicit action fetches the bounded SEC Atom feed; a valid Hub receipt remains preferred when available. `GET /api/sec-filings-inbox` applies the exact-match listing gate to the saved SEC receipt.
- After the app restarts, the same unexpired, intact listing and direct SEC snapshots must be readable without reacquisition. The direct SEC snapshot is size-bounded, digest-checked, and linked to its embedded receipt ID. Expired, semantically invalid, or checksum-invalid listing-cache data must withhold all rows.

## Verification

- `tests/sec-filings-inbox.test.ts` covers SEC Atom source parsing, source gates, exact-match listing eligibility, cache write/reopen, offline reads, request cadence, concurrent activation, expiry, and corruption rejection. The offline source-gate verifier asserts that explicit acquisition can request only the two listing files and one bounded SEC Atom feed, and sends nothing if either approval is missing.
- `ALLOW_LIVE_NASDAQ_REPLAY=true npx tsx scripts/verify-nasdaq-symbol-directories.ts` verifies the current official files independently; the real SEC/Nasdaq restart proof must also cover the full acquisition → durable cache → offline restart path.
- `tests/sec-filings-inbox-ui.test.tsx` checks that the user-facing filing state exposes the verified listing evidence and withholds ineligible rows.
- Run the focused native boundary: `npx vitest run tests/sec-filings-inbox.test.ts tests/sec-filings-inbox-ui.test.tsx --reporter=dot --maxWorkers=1`.
- Run `npm run typecheck` after the acquisition/cache source changes. Use `python3 /Users/jurgis/.codex/scripts/live_data_etl_gate.py check --workspace <repository-root>` to inspect the current gate receipt without executing its checks. `verify` executes every command in `live-data-etl.json`, including its bounded live RSS/GDELT/Yahoo smoke and any live-source receipts; inspect that contract and source-use approval before running it. Its evidence must bind to current source/config hashes, so an earlier receipt is stale after any material source edit.

Fixture tests prove cache mechanics, not current exchange listings or SEC availability. The separate live-data ETL contract still asks for a current Public Data Hub receipt and must be reconciled with the direct SEC fallback before that operational gate can pass. A rendered UI review and current-run live ETL receipt are separate evidence. Never seed the running product with fixture securities or imply that fixture rows are real filings.
