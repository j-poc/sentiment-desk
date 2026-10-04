# SQLite storage and request-admission boundary — 2026-10-03

## Decision

Keep one SQLite database and make its physical file family the storage
boundary. Lock acquisition, sidecar measurement, SQLite page limits, and
database open now use the same canonical path, including symlink aliases.
Reserve capacity before provider work; refuse new writes or external requests
when free space, file size, a WAL checkpoint, or the logical page ceiling
cannot be confirmed. A compatible existing database remains readable in
read-only mode when the write boundary is unavailable.

The configured local limits are 2 GiB for the main database, 5 GiB for the
SQLite file family, at least 1 GiB free on the volume, and 128 MiB of reserved
write headroom. These limits apply to the single application writer. They do
not establish host-wide or multi-process quotas, sustained ingestion, or
hosted production scale.

## Failure and recovery behavior

A pause before any network hop records no provider delivery. If a safe redirect
has already returned a response, that first hop is retained as a failed
delivery when storage blocks the next hop. Paid-request reservations are
returned only for attempts known not to have dispatched. Requests with a
dispatch intent retain usage reservations or require provider reconciliation
when their outcome is unknown.

## Verification

The storage and poller boundary suite passed 6 tests with
`npm test -- --reporter=dot tests/storage-capacity.test.ts`. The regressions
cover symlink aliases, a competing writer lock, capacity pause, SQLite hard
limit and read-only recovery, blocked WAL checkpoint admission, and recording
an already-dispatched redirect hop. Paid-request restart accounting also has
dedicated temporary-database coverage in `tests/db.test.ts` and
`tests/openai-classifier.test.ts`.

The earlier saved-data capacity run is recorded in
`project-record/4-log/2026-10-03-local-read-capacity.md`. It measured 24
configured companies and 12,509 retained observations using an isolated
SQLite backup, with external networking blocked. That read-only workload does
not prove larger retention, multi-user behavior, write concurrency, or hosted
capacity. The user's database was not used by the storage regressions. Its
main-file digest at this review is
`d5dcff9a3c76580bf3ac8578cb643aecf9b40448766b89120b215e06de33218c`.
