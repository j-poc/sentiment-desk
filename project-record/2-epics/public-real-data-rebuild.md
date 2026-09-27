# Public rebuild of the private research desk

## Intent

Sentiment Desk remains a locally operated, single-user research product. Its
source and build are shared publicly so another researcher can rebuild a local
instance using live public sources and their own provider credentials. The
default path must use real news and market-data collectors. Synthetic demo
sentiment is an optional interface exercise, never the default data path.

## Acceptance

- Docker Compose builds the server and dashboard from the checked-out source.
- The default service starts with `DEMO` off and collects from keyless live
  sources; missing Jev credentials leave mentions pending rather than replacing
  them with synthetic judgments.
- Jev and optional-provider credentials stay in a local ignored `.env` file and
  are excluded from the Docker build context.
- SQLite history uses a named volume that survives container recreation.
- The service binds to loopback by default.
- README instructions describe credential-free startup, optional credentials,
  demo behavior, persistence, and a runnable live Compose smoke check.

## Boundaries

This work does not change sentiment scoring, provider selection, or upstream
data rights. Current data-provenance, provider coverage, and freshness gaps are
recorded in `3-project-specs/live-data-etl.json`. The user chose to keep the
repository without a LICENSE for now. Public visibility does not grant reuse
rights.
