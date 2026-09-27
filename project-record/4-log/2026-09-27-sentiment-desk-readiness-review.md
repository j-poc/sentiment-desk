# 2026-09-27 — Independent Sentiment Desk readiness review

## User outcome

The user asked to continue until done, show the interface, and use independent
subagents to judge whether the Sentiment Desk is ready and deserves a 10/10.
The relevant job is to inspect source-backed company observations, rely on Jev
as the only per-item sentiment/event classifier, and use Opportunity Radar to
compare saved judgments without turning coverage into an investment claim.

## Initial verdicts

Three read-only reviewers inspected current code, project records, and tests.
Their independent scores were 7/10 for source operations, 4/10 for Jev
operational assurance, and 7/10 for UI/Radar. These are qualitative reviewer
judgments, not an aggregate product metric.

The strongest findings were:

- malformed choice output could fall through to alphabetical defaults, and
  invalid probability values were clamped instead of rejected;
- transient Jev failures become terminal after client retries, with no bounded
  persisted recovery path;
- scheduler stop cleared intervals without waiting for a poll already running;
- mobile ticker selection used a pointer-only span;
- Radar summary and pagination requests recomputed their time bounds, allowing
  evidence totals to drift;
- no current live-source observation was verified from Jev response through
  judgment persistence and the rendered card in this checkout.

## Final verdicts after hardening

Three read-only reviewers rechecked the implemented fixes. Their separate
qualitative ratings were 8.5/10 for source operations and overall scoped
readiness, 8.5/10 for local Jev implementation (7/10 for release readiness),
and 9/10 for UI/Radar. These numbers are not averaged. Their verdict is that
the tested local workflow is ready, but the product is not 10/10 release-ready.

Verified fixes:

- Jev now rejects invalid probabilities, malformed choices, and a successful
  response whose model differs from the configured model; ambiguous outcomes
  do not trigger automatic resubmission.
- Retryable Jev rate limits are persisted and bounded; pipeline replay and
  scheduler shutdown have regression coverage.
- Shutdown drains in-flight jobs, ends active SSE streams, and then closes the
  database.
- Radar pagination carries the overview's `asOf` snapshot through evidence
  requests.
- At 390×844, the mention drawer has modal semantics, focus management, keyboard
  isolation, and no horizontal overflow; the 1280px Radar view also passed.

One local operations gap remains: terminal Jev failures have no operator
requeue control. Automatic retry is withheld for an outcome-unknown request to
avoid a duplicate charge. The app should keep those records visibly failed
until the provider outcome is checked before any deliberate replay.

External proof still needed for a 10/10 release claim: a credentialed current
headline through Jev, persisted judgment, and visible UI; a labeled accuracy
and calibration evaluation; confirmation of 429 billing semantics and exact
provider model/output compatibility; and review of source display/model-use/
retention terms. No key or provider terms were supplied for this run.

Overall, this is ready for its tested local, keyless source-research workflow:
it can collect and show pending source evidence accurately. It has not proven
live Jev classification or release-level investment research quality.

## Evidence and limits

The process environment has no `TYPESAFE_API_KEY`, `.env` is absent, and the
shared `~/.newsjack/.env` has no configured Jev key. No credential value was
read or printed. Thus this checkout cannot perform a credentialed live Jev
smoke test without the user supplying or authorizing a credentialed setup.
The keyless live UI can still be inspected and should correctly show new items
as pending.

## Original hardening plan

The original review requested strict output validation, bounded persisted
retry scheduling, awaited poller shutdown, stable Radar pagination snapshots,
and an accessible mobile company selector. These fixes and the keyless UI path
were verified locally as described above. Terminal Jev failures still lack an
operator requeue control; no unsafe automatic replay was added. Keep the
credentialed live Jev path explicitly unverified until it can be tested with an
authorized key. Do not claim release-level 10/10 while live behavior,
classifier quality, provider terms, and billing semantics remain unresolved.
