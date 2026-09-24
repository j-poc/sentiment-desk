# 2026-09-24 — Public real-data rebuild

## Decision

Keep the default Docker Compose path live-data-first: real news and market
collectors run without private credentials, Jev scoring remains pending until
the operator supplies a key, and demo mode stays explicit and optional. Bind
the local service to loopback and store SQLite in a named volume.

Docker Compose permits a missing `.env` in this configuration; Compose 2.24+
is required for that optional `env_file` behavior. Provider keys remain local
configuration and are excluded from the Docker build context.

## Verification

- `npm test`: passed, 52 tests in 6 files.
- `npm run typecheck`: passed after the existing scored-event query was updated
  to return the `eventType` already consumed by reflection memory.
- `npm run build`: passed for web and server.
- `docker compose -f compose.yaml config --quiet`: passed with the local Compose
  CLI; `sh -n scripts/verify-live-compose.sh` and `git diff --check` passed.
- `./scripts/verify-live-compose.sh`: not completed. The initially selected
  `citrini-verify` Docker context belongs to a separate build and was not used
  again after that was clarified. The generic `default` Colima profile also
  could not start: its saved VM disk configuration requires shrinking from
  20 GiB to 6 GiB, which Colima reports as unsupported. No live-provider result
  or Docker image build is claimed.

## Continuation update — 2026-09-25

The Compose configuration, shell syntax, database regression test, and local
test/typecheck/build checks remain valid. The live Compose and persistent-volume
smoke check remains blocked because no usable Docker daemon is available. No
other Colima profile was selected or modified.

## Handoff limits

No Git remote or license file is configured. A GitHub checkpoint requires a
branch; no license has been invented. The live-data ETL record lists
provenance, freshness, rights, and raw-replay gaps that this container rebuild
does not change.
