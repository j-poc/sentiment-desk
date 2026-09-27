# Sentiment Desk readiness continuation — 2026-09-28

## Goal and scope

Continue the active Sentiment Desk completion goal on
`codex/real-data-rebuild`. Preserve Jev as the per-item sentiment/event judge,
keep Opportunity Radar downstream of the existing persisted evidence, and
checkpoint reviewed work to `origin/codex/real-data-rebuild`. No license,
hosting, provider enrollment, publication, or PR was added.

## Findings

- The drawer had no operator path to recover a terminal failed judgment.
- An existing mention's later SSE judgment was discarded from tape and company
  state; the drawer also kept its prior object. A company mentions response
  or initial tape response started before the SSE event could return later and
  overwrite the newer row.
- TypeSafe documents `Retry-After` support in its SDK guidance. The persisted
  client honored only the app's exponential delay.
- TypeSafe says submitted inputs consume credits, but the reviewed material did
  not establish whether HTTP 429/529 submissions consume them. Any submitted
  request without a saved score therefore requires a provider-usage review
  before a deliberate manual retry.
- The source-rights review is recorded in
  `project-record/3-project-specs/live-data-etl.json`. Publisher permissions
  for stored/displayed snippets and external model processing, applicability
  of Yahoo API terms to the exact endpoints, SEC text-use policy, optional-feed
  plan rights, TypeSafe retention configuration, and rejected-request billing
  remain open. No real publisher text was sent to Jev.

## Changes

- Added `POST /api/mentions/:id/retry` with strict confirmation, atomic
  failed-to-pending transition, one accepted request under a race, and guards
  against retrying non-failed/corrupt/scored rows.
- Persisted a flag requiring usage review whenever a submitted provider
  request ends without a saved judgment. Interrupted in-flight migrations now
  fail closed and require the same review.
- Added an accessible, two-acknowledgement retry panel to the drawer. Unknown
  or otherwise unscored provider attempts require a usage check; all retries
  disclose the possibility of additional credits. Cancel leaves the item
  failed and makes no request.
- Added `Retry-After` delta-seconds and HTTP-date parsing; the saved delay is
  the greater of the provider delay and existing bounded exponential backoff.
- SSE events now replace matching rows in tape, cached company lists, and an
  open drawer. A later HTTP response preserves any SSE event that arrived
  after that request began. The streamed-item map is bounded to 500 IDs.
- Froze ten fictional labeled cases in `scripts/jev-sanity-cases.json` and
  added `npm run verify:jev-sanity`; each case uses its own temporary SQLite
  database and the actual Jev client/pipeline. No model result has been read
  yet. The runner records all cases and limits cost claims to provider-reported
  tokens.
- Added `npm run verify:retry-browser`, an isolated loopback workflow using a
  fictional item and an in-process fake judge; it never opens `data/desk.db` or
  sends a request to TypeSafe.

## Test-first and verification evidence

- Initial focused tests failed as expected: operator retry returned 404 before
  the route existed, while `Retry-After` was not parsed or persisted. After
  implementation the focused retry/Jev/pipeline tests passed.
- On a fresh loopback app, the browser showed the prior provider failure and
  both acknowledgements, kept Send disabled until both were checked, and
  preserved the failed status after Cancel. After authorization, one synthetic
  request persisted a positive/product score and the open drawer updated from
  SSE. The visible app then showed the same judgment in the company card and
  tape.
- For the stale-response race, the first company mentions response captured
  the failed state and was held for 120 seconds. The retry then produced a
  newer scored SSE event. After the delayed response completed, the company
  card still displayed the SSE score. A direct read of the local mentions API
  returned HTTP 200 with `status=scored`,
  `model=synthetic-jev-fixture`, and `usageCheckRequired=false`.
- These browser data and model labels are synthetic; the app ran with one
  temporary SQLite database and an in-process fake judge, with no external
  Jev or market-data requests.
- A second race pass delayed both the initial `/api/tape` response and company
  mentions snapshot by 120 seconds. Each older failed snapshot returned after
  the SSE judgment; the corresponding tape/company card still showed the
  scored event. The fixture runner completed graceful shutdown and reported
  `PASS`, one fake call, and final status `scored`.
- At 390×844, Playwright showed the retry panel inside the viewport with no
  horizontal document overflow (`innerWidth=390`, `scrollWidth=390`). Send
  remained disabled until both acknowledgements were checked; the one local
  retry returned HTTP 202 and the drawer rendered the synthetic positive /
  product result. The browser recorded zero console errors or warnings. The
  run used the fictional item, temporary SQLite, and an in-process judge.
- `Retry-After` tests cover integer seconds, HTTP-date, malformed headers, and
  persistence of a not-early retry time. Route/pipeline tests cover unknown
  outcomes, rejected provider inputs, missing acknowledgement, duplicate
  submissions, stored recovery, and non-retryable scored items.
- `npm test -- --reporter=dot` passed 82 tests across 12 files; typecheck and
  production build passed. Vite emitted only the existing main-chunk-size
  advisory.
- The exact 390px retry-panel browser workflow passed as described above.

## Evaluation and handoff

The ten-case run is separate from the browser fixture. Before dispatch, the
frozen input file has 10 cases and SHA-256
`733669851a6890f2d748a833b29727fe6c9264c3ce3e49ef0672f94507ac8a97`; the
checkpointed revision is `2f70bb1f8e48db1acbab0f77c82df1538bf402a7`, with no
tracked source changes. A prior one-request synthetic provider smoke and the
fictional retry browser workflow are the end-to-end smoke evidence; no
publisher text is in scope.

Stop conditions: the pipeline may automatically retry only explicit HTTP
429/529 rejection within its bounded three-attempt policy; it does not replay
transport, generic 5xx, malformed-output, or model-mismatch unknown outcomes.
Each case has an eight-minute terminal budget. The runner stops dispatching
after three errors with the same HTTP status and writes the fixed ten-case
denominator, including cases not run after that stop. If interrupted, inspect
the report and provider usage before any new dispatch; never silently restart
or replay a case whose prior outcome is unknown. Record the per-case ledger,
request count, resolved model, rubric SHA, case digest, code revision/dirty
state, reported tokens, estimated cost, latency, and terminal state.

Do not represent this small pilot as classifier accuracy/calibration, alpha,
or release-readiness evidence.

Local hardening is not equivalent to 10/10 release readiness. Rights,
retention, rejected-request billing, real-source labeled quality, and the
frozen ten-case Jev pilot remain separate gates.
