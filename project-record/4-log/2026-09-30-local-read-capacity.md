# Local saved-data API read-capacity check — 2026-09-30

This check makes the earlier saved-data capacity observation reproducible. It
does not claim general scalability. The API server ran from the production
build against a disposable SQLite online-backup copy of the real local
database. All source collectors, external requests, credentials, Jev, and
Opportunity Radar were disabled; a Node fetch guard recorded zero external
requests. The saved database and WAL fingerprints were unchanged, and the
four core table counts in the disposable copy stayed constant across the API
reads. The verified mention pages contained only identified collector rows,
with no demo, synthetic, or fixture source labels.

The frozen dataset contained 12,509 source observations and Jev judgments,
101,032 delivery receipts, 69,316 price points, and 7,809 identified source
observations among the retained history. The SQLite quick check returned
`ok`. The configured universe had 24 companies. Main database SHA-256 was
`31cf091e29f5fdab9eca5852ff82776bc8e40c9c0fd93f76e74c6d993374e798`; the
source bundle SHA-256 was
`22b27901858b54c49372d7cf65f6a1681899033f6df44b5ac2508c7ff7b84a47`.
The final harness run used Git HEAD `993677d4469118c336344b01f8ee4adafd10eef9`,
source-tree SHA-256
`922d1a3f24aed5285d1fc76e46513700ed62eeda92f41314fdd7decc0fd8c627`, Node
`v26.10.0`, and Python `3.14.7`.
The verifier requires Python 3.10 or newer and uses only the standard library.

The final `npm run verify:local-read-capacity` run passed at
`2026-09-30T20:44:43Z`. It built the app, then made 24 serial reads of each
route, an interleaved eight-worker mix of 24 reads per route, and one
24-worker fanout of the selected series endpoint across all configured
companies. Every request returned HTTP 200. It also checked the first mention
page for all 24 companies: 2,347 rows had identified source labels and none
were demo, synthetic, or fixture rows. The table reports p95 response latency
from that final run; summed request latency is deliberately separate from
actual workload wall time.

| Workload | Requests | Wall time | Sum of request latencies | Route p95 |
|---|---:|---:|---:|---|
| Serial saved-data reads | 96 | 7,090 ms | 7,064 ms | health 411 ms; companies 16 ms; series 20 ms; mentions 2 ms |
| Interleaved eight-worker reads | 96 | 5,513 ms | 42,954 ms | health 551 ms; companies 551 ms; series 530 ms; mentions 529 ms |
| 24-company 7D series fanout | 24 | 326 ms | 3,990 ms | series 306 ms; all 24 responses returned 673 points |

Three prior successful runs of the same interleaved harness reported route
p95 values ranging from 569 to 1,176 ms across the eight-worker mix. The
24-company fanout p95 ranged from 287 to 496 ms across all four runs. All had
the same saved-data counts and passed the same isolation checks. This spread
means the measurements are descriptive for this workstation and retained
dataset, not a stable service-level target. The earlier grouped-route runs are
excluded: a harness ordering bug had queued all health requests before the
other routes. The harness now interleaves the four route types round-robin.

The separate GPT-6.1 Sol extra-high advisor found no basis for an application
optimization without an agreed latency target or a reproduced user-visible
failure. Synchronous health work may contribute to queueing, but host
contention and route service time were not isolated. No worker pool, database
replacement, cache, or API behavior change was made. The check passes only
when reads succeed, network access stays blocked, returned collector labels
meet the saved-data boundary, SQLite integrity stays valid, and database
counts remain unchanged. Its latency figures have no pass threshold.

This does not test sustained throughput, concurrent writes or collection,
larger retention, multi-user capacity, browser responsiveness, or production
deployment. It is evidence for the current local saved-data path only. See
[`scripts/verify-local-read-capacity.py`](../../scripts/verify-local-read-capacity.py)
and `npm run verify:local-read-capacity` to reproduce it. Full Sentiment Desk
operation remains unverified: authorized real-source Jev evaluation,
independent human labels, provider usage reconciliation, and account/source
evidence remain outstanding. Opportunity Radar stays disabled.

## Candidate decision

The requested outcome for this slice is an offline, repeatable measurement of
the existing local saved-data API path. Its pass condition is functional and
data-safety evidence, not a latency target: successful saved-data reads,
identified source labels, no outgoing fetches, valid SQLite state, and
unchanged source/judgment counts. Re-run after changes to server routes, source
filters, database schema, company universe, or workload. The changes add only a
developer verifier, its npm entry, and trace records; no application response
behavior changed. A separate architecture design step was skipped because
this is one isolated CLI harness with no runtime, schema, provider, or public
API change. The bounded result is ready for a source-control checkpoint after
the frozen-source project gate passes; full-product release readiness remains
unverified.

## Frozen-source gate recovery — 2026-09-30

The first gate attempt failed because the configured
`colima-sentiment-desk-verify` Docker profile was stopped and its socket did
not exist. Starting that existing verification profile restored the runner.
The same isolated, credential-free Compose command then passed directly. It
reported 27 quotes across 24 companies and a publisher-timed Google News item
in pending state. The item remained pending after container recreation, and
the host health endpoint returned HTTP 200 both times. The smoke script
removed its temporary Compose project and database volume.

The frozen-source `verify` passed at `2026-09-30T21:02:28Z`; the subsequent
`check` returned exit 0. All five declared checks passed. The 21:02 receipt
recorded code fingerprint
`f16a67aba190c94935bc21eb821ca4c1ab21934839f21dfa595b838223eb61bb`, contract
digest `9e9a1278ba7bde586518d7b1b8725bc519f2a1a390152a9981ae09975075f3e8`, and
five passing check digests. This confirms the saved-data capacity tooling did
not break the configured keyless-source smoke. The later handoff reconciliation
changes the code fingerprint's file set, so the post-reconciliation receipt
must be read from `live-data-etl-evidence.json`. This does not clear the
separate TypeSafe, Jev evaluation, historical usage, SEC contact, source rights,
or coverage gates.

## Real-data identity inventory — 2026-10-01

Using the same real database fingerprint above, a read-only SQL aggregate
found 7,809 identified observations and 4,700 quarantined `legacy_unknown`
rows. Of the identified rows, 1,864 same-company exact-normalized-title groups
contained 5,304 observations; 569 groups spanned multiple collectors and
contained 2,243 observations. The query uses `lower(trim(title))` and counts
rows grouped by company, so it finds headline matches only. It does not prove
that any group is one event. Current item identity remains
company + collector + source item ID (or canonical URL), with content revisions
stored separately. Preserve each publisher row and do not change index weights
or call these matches event clusters without a frozen, independently reviewed
real-data task.

The saved SEC subset contains 3 observations from 1 company, which cannot meet
the frozen evaluation's 30-issuer floor. A rights-cleared real-source Jev
cohort and independently authored labels therefore remain unrun; no Jev calls
were made. Opportunity Radar remains disabled.
