# Analyst research queue — design acceptance

## User problem

The current source feed contains real saved records but mixes pending stories,
reposts, and off-company matches. The investor can open a record, but cannot
save a decision about it or resume that work later. Treating feed order or
headline counts as opportunity ranking would overstate the data.

## Chosen increment

Add an analyst-authored research queue linked to the immutable ID of an existing
identified real-source observation. The user can save a record for
investigation, write a next verification question, or dismiss it from the queue.
Dismissal is reversible and never deletes or edits the source record. Show a
first-class queue across companies. Pending Luna, historical Jev, source
attribution, publisher/provider/retrieval clocks, and receipt-link status remain
unchanged and visible. Queue items are work-in-progress, not verified findings,
recommendations, counterevidence, or material-change judgments.

No provider or model request is part of this workflow. Notes and decisions are
local user data. No seed or demo queue item is created.

## Observable acceptance criteria

1. An investor can open an eligible saved source record, save it to the queue,
   and add a question in their own words. The saved item binds to the exact
   immutable source observation ID and company.
2. The global queue lists saved items across companies with the actual source
   title, reported publisher, existing judgment status, source/retrieval timing,
   source link, and analyst-authored question. It makes no ranking or claim of
   materiality.
3. Dismissing an item removes it from the working queue without deleting its
   source or note; the user can reinstate it from the source detail. Dismissed
   rows are excluded from the default selected-company source scan before
   pagination. A visible, reversible “Show set-aside” control retrieves them
   and labels their disposition. Queue and question survive browser reload and
   server restart.
4. Unknown companies, non-real/demo/legacy-unknown observations, malformed or
   over-limit text, and queue-capacity overflow fail clearly without partial
   writes. Repeated save requests are idempotent; a response failure never
   displays success or discards entered text.
5. The workflow uses SQLite only and causes zero source or classifier requests.
   Empty, loading, failed, and populated states are distinguishable.
6. All actions are keyboard-operable and the actual 390px UI has no horizontal
   overflow. Source status and timestamps remain visible on both desktop and
   mobile.

## Out of scope and remaining evidence

This does not solve zero-ticker discovery, small-cap qualification, SEC-backed
company triage, source rights beyond existing approved saved observations,
automated prioritization, or product-value testing. Those remain explicit
product gaps. The increment is useful because it lets an analyst turn an
existing real source row into resumable, source-linked work without making the
headline appear verified.

## Usability correction — 2026-10-04

Independent whole-build review found that “dismiss from My Research” did not
reduce repeat work: the dismissed headline stayed in the primary company feed.
The source page now applies the analyst-only disposition before pagination by
default. The analyst can reveal set-aside rows from the same feed and restore
them through source detail. The disposition is separate from immutable source
observations and does not change source counts or chart inputs. This removes a
repeat-scan irritant; it does not close the broader investor usability review.
Connected clients receive disposition-only updates so subsequent source events
and reconnect reconciliation cannot reintroduce a dismissed item. The saved-
evidence summary explicitly requests the complete local sample, preserves its
counts and duplicate analysis, and omits set-aside-only groups from its latest
headline preview with a clear caveat.
