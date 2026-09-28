# Public rebuild of the private research desk

## Intent

Sentiment Desk remains a locally operated, single-user research product. Its
source and build are shared publicly so another researcher can rebuild a local
instance using live public sources and their own provider credentials. The
default path serves saved real data only. Live collection uses only the
explicitly allowlisted real collectors after the operator opts in. Synthetic
fixtures are confined to automated tests and never enter the live data path.

## Acceptance

- Docker Compose builds the server and dashboard from the checked-out source.
- Docker Compose builds the service with external requests paused by default;
  after opt-in, only `EXTERNAL_SOURCE_COLLECTORS` are allowed to make requests.
- Missing Jev credentials leave real observations pending rather than replacing
  them with synthetic judgments.
- Jev and optional-provider credentials stay in a local ignored `.env` file and
  are excluded from the Docker build context.
- SQLite history uses a named volume that survives container recreation.
- The service binds to loopback by default.
- README instructions describe saved-data-only startup, explicit collector
  allowlisting, optional credentials, persistence, and a runnable live Compose
  smoke check.

## Boundaries

This work does not change sentiment scoring, provider selection, or upstream
data rights. Current data-provenance, provider coverage, and freshness gaps are
recorded in `3-project-specs/live-data-etl.json`. The user chose to keep the
repository without a LICENSE for now. Public visibility does not grant reuse
rights.
