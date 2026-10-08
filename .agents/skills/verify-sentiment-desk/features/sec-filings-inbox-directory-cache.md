# SEC Recent Filings listed-issuer cache

Recent Filings may display an SEC 8-K row only when the issuer matches exactly one current security in both official Nasdaq Trader symbol-directory files. The directory evidence is public source data, cached locally in the existing desk database with a compressed size bound and SHA-256 integrity check. Security names are bounded at 512 characters; the live directory contains a legitimate 214-character listed-security name, which must remain valid through cache reload. The cache is reusable across process restart only while its source-clock age is within 24 hours. Expired, malformed, or corrupt snapshots fail closed: SEC rows remain withheld and the UI explains the listing gap.

## User path and observable behavior

- Open Recent Filings for a configured listed issuer and inspect the verified symbol, exchange, listing-directory creation and retrieval times, and SEC receipt times.
- When external requests are disabled or source approvals are absent, the screen remains paused and makes no provider request; a missing verified directory keeps SEC rows withheld.
- When acquisition is explicitly enabled, `POST /api/sec-filings-inbox/activate` fetches the two bounded public directories. `GET /api/sec-filings-inbox` applies the exact-match listing gate to the saved SEC receipt.
- After the app restarts, the same unexpired, intact directory snapshot must still verify eligible receipt rows without another Nasdaq fetch. Expired, semantically invalid, or checksum-invalid cache data must withhold all rows.

## Verification

- `tests/sec-filings-inbox.test.ts` covers source parsing and exact-match listing eligibility, cache write and reopen, offline read without reacquisition, expiry, and corruption rejection.
- `ALLOW_LIVE_NASDAQ_REPLAY=true npx tsx scripts/verify-nasdaq-symbol-directories.ts` verifies the current official files independently; the real SEC/Nasdaq restart proof must also cover the full acquisition → durable cache → offline restart path.
- `tests/sec-filings-inbox-ui.test.tsx` checks that the user-facing filing state exposes the verified listing evidence and withholds ineligible rows.
- Run the focused native boundary: `npx vitest run tests/sec-filings-inbox.test.ts tests/sec-filings-inbox-ui.test.tsx --reporter=dot --maxWorkers=1`.
- Run `npm run typecheck` and `python3 /Users/jurgis/.codex/scripts/live_data_etl_gate.py verify --workspace <repository-root>` after the acquisition/cache source changes. The ETL verifier must bind its output to current source/config hashes; an earlier receipt is stale after any material source edit.

Fixture tests prove cache mechanics, not current exchange listings or SEC availability. A rendered UI review and current-run live ETL receipt are separate evidence. Never seed the running product with fixture securities or imply that fixture rows are real filings.
