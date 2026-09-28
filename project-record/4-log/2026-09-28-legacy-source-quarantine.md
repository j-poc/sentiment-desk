# Legacy source provenance quarantine — 2026-09-28

Trace ID: `TRACE-20260928-legacy-source-quarantine`

## Why

The user's release constraint is that all research data be real, with no demo
or synthetic records. A read-only aggregate audit of the default local SQLite
database found migrated `legacy_unknown` observations with saved Jev
judgments. The database had no rows carrying the explicit demo markers, but
the legacy RSS collector and source-time fields do not establish what exact
provider retrieved each item. No article body, title, snippet, source URL,
credential, or model payload was queried from SQLite. These rows cannot be
treated as verified source-backed evidence until their origins are established.

## Changes

- New observation writes now fail closed when the collector is absent or is
  `legacy_unknown`. RSS items must identify their collector; source kind alone
  does not distinguish the upstream provider.
- New delivery receipts also require a known collector.
- Research reads, Jev queues/claims/retries, source delivery summaries and
  health, scoring aggregates, and Radar exclude migrated `legacy_unknown`
  rows as well as explicit simulation markers. Existing rows remain stored.
- Saved non-demo model-usage estimates continue to include legacy rows, so
  hiding unverified source content does not drop those recorded estimates.
- The Desk now presents a more legible, main-view disclosure: “Configured feeds
  only. This desk does not cover the entire public web or all investor
  activity.”

## Verification

- `npm test -- --reporter=dot` — **146 passed across 23 files**.
- `npm run typecheck` — passed.
- `npm run build` — passed; existing Vite advisory reports a 529.87 kB main
  JavaScript chunk.
- `git diff --check` — passed.
- The database regressions cover missing/unknown collector rejection,
  quarantined legacy migration, visibility and scoring exclusion, retry
  rejection, Radar and aggregate exclusion, delivery-summary exclusion, and
  preservation of stored non-demo usage totals. Fixtures use isolated test
  databases; none is product data or model-quality evidence.
- A static-only Playwright pass served the production client without an API
  proxy or application database. At 390×844, the disclosure was visible at
  `(x=12, width=366, height=34.125)` and `documentWidth=390`; the same note was
  present at the desktop viewport. The static server returned local 404s for
  API endpoints by design, so this proves layout only, not connected workflow.

## Limits and recovery

- The local aggregate audit found unverified legacy observations that had been
  scored. Their actual upstream payloads, source permissions, TypeSafe requests,
  and billed usage were not inspected. Reconcile historical provider usage and
  source rights before making any quality or authorization claim.
- A pre-existing Node service on `127.0.0.1:8787` started before this code
  change and remains running with its in-memory version. A Vite preview briefly
  proxied normal read requests to it; the browser showed live dashboard state
  whose provenance was not established. The preview was closed. No retry,
  write, manual Jev call, or direct public-source request was initiated, and
  the visible output is excluded from verification evidence. Background work
  by that pre-existing process was not audited.
- Do not use that service as evidence for this change. The quarantine takes
  effect after a controlled restart. A restart can run configured providers or
  Jev, so perform it only after applicable rights, account, and budget gates
  are cleared; otherwise keep the service's existing operator decision intact.
- Source rights, exhaustive coverage, TypeSafe account/telemetry/retention/
  billing terms, independent real-source labels, and classifier quality remain
  unresolved. This checkpoint does not make Sentiment Desk release-ready or
  10/10.
