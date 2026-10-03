# Local saved-data capacity check — 2026-10-03

## Acceptance

Run the production API against a disposable online-backup copy of the real
saved database. Keep external requests blocked, verify SQLite integrity and
unchanged source/judgment counts, and exercise repeated reads across all 24
configured companies. This measures local read behavior only; it is not a
sustained-throughput or multi-user scale claim.

## Result

The check passed at `2026-10-03T00:49:08Z` on Node `v26.10.0` and Python
`3.14.7`. The original database was opened read-only and its SHA-256 remained
`d5dcff9a3c76580bf3ac8578cb643aecf9b40448766b89120b215e06de33218c`.
SQLite `quick_check` returned `ok`; all four core row counts were unchanged.
The 86,130,688-byte database contained 12,509 source observations, of which
7,809 had identified non-demo collectors; it also contained 12,509 Jev rows,
101,032 source deliveries, and 69,316 price points. The API read 2,222 source
rows across the 24 company pages, found no demo, synthetic, fixture, or
unidentified collector labels, and attempted zero external fetches.

| Workload | Requests | Result |
|---|---:|---|
| Serial reads across health, company, series, and mention routes | 96 | HTTP 200; route p95 2.9–21.6 ms |
| Interleaved eight-worker reads across the same routes | 96 | HTTP 200; route p95 120.8–125.2 ms |
| Concurrent seven-day series reads for all configured companies | 24 | HTTP 200; 36.9 ms wall time; route p95 28.4 ms |

The checks ran against a temporary SQLite backup with external networking
blocked. Source database fingerprints and row counts matched before and
after. The result supports the local saved-data workload at this retained
volume; it does not establish continuous ingestion, concurrent writes,
multi-user capacity, larger retention, or hosted production scale.

The underlying harness is `scripts/verify-local-read-capacity.py` and is
reproducible with `npm run verify:local-read-capacity -- --rounds 24`.
