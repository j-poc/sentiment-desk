# Jev alias and resolved-model compatibility

## User outcome

Jev is the sole authority for each source item's sentiment and event category.
The researcher needs a real current observation to receive a validated Jev
judgment, persist with exact model provenance, and appear beside its source in
the desk. An alias request must not be mistaken for a provider fallback.

## Baseline and current evidence

The configured model is `jev-latest`. The client sends that alias, but then
rejects TypeSafe's successful response `model: jev-1.13.0` because it requires
exact equality. The row is marked failed with outcome unknown and is not
automatically replayed.

The official [TypeSafe Models documentation](https://docs.typesafe.ai/models)
reviewed 2026-09-27 says aliases resolve to versioned IDs, `jev-latest` points
to `jev-1.13.0`, and the response model identifies the version that answered.
The official [API reference](https://docs.typesafe.ai/api) gives
`jev-1.13.0` in its example response and defines that field as the model that
performed the evaluation. Thus this exact mismatch is a deterministic client
contract bug.

## Frozen behavior and invariants

- Preserve `RUBRIC`, request state, configured alias, timeout, token accounting,
  probability validation, post-rules, and bounded retry semantics.
- Send the configured model unchanged in the request body.
- For `jev-latest` and `jev-preview`, accept only a canonical resolved ID of
  the form `jev-<major>.<minor>.<patch>`; persist the response ID in
  `MentionScore.engine`.
- For a configured versioned ID, require exact equality. Reject aliases,
  unrelated providers, prereleases, and malformed version strings in responses.
- A valid alias-resolved response remains one request and is persisted once.
  Invalid or unknown-outcome requests remain fail-closed and are not
  automatically resubmitted. Do not change any existing failed observation's
  status or retry it during this repair.
- Preserve bounded persisted retries for explicit HTTP 429 and TypeSafe's
  documented HTTP 529 overload rejection. Generic 5xx responses and transport
  failures remain outcome-unknown and are not retried automatically.
- No sentiment, event category, or investment conclusion is created in
  application code. The app validates and applies its already-specified
  deterministic post-rules to Jev's result.

## Hard gates and evidence map

| Gate | Check | Current result |
| --- | --- | --- |
| Alias request/response | Offline Jev client fixture asserts request uses alias, accepts returned version `jev-1.13.0`, and reports that exact ID. | PASS |
| Pinned model | Fixture configures `jev-1.12.0` and rejects returned `jev-1.13.0`. | PASS |
| Wrong/malformed model | Fixtures reject unrelated IDs, alias echoes, prerelease IDs, and malformed versions as outcome-unknown; exactly one request is made. | PASS |
| Explicit overloads | HTTP 429 and documented 529 are retryable rejections; generic 5xx and transport errors remain outcome-unknown. Pipeline retries stay persisted and bounded. | PASS |
| Persistence and user path | Pipeline test stores returned model ID in the judgment; isolated live-provider path confirms a new synthetic observation is persisted, returned by the local API, and visible in the source detail drawer. The temporary database contains no older rows to replay. | PASS (synthetic integration only) |
| Regression | `npm test`, typecheck, build, and current-build browser check pass with the fixed contract. | PASS |
| Current public-source scoring | A current public-source headline is judged and displayed under reviewed publisher/model-use and account-retention terms. | NOT RUN |
| Isolated Compose binding/recovery | Production image is reachable through a loopback-published host port and preserves its temporary SQLite volume across container recreation. | PASS |

The live-provider gate used one newly ingested synthetic observation, recorded
only redacted model/usage evidence, and verified the SQLite/API/UI result. It
did not use a public publisher item, and it must not be interpreted as a Jev
accuracy or calibration result. It did not load the user's desk database or
retry a prior outcome-unknown row.

## Provider/data-use boundary

Current TypeSafe documentation says inputs are not used to train models.
Its general Privacy Policy says prompts and other input may be retained as
reasonably necessary to provide the service; the docs describe zero-data
retention as an enterprise option. TypeSafe's Master Customer Agreement makes
the customer responsible for ensuring the application does not infringe
third-party rights. These terms do not settle whether each upstream publisher
permits the desk to send its normalized title/snippet to a model provider or
how this account's retention configuration is set. No credential value was
read or logged. Preserve that source-rights/account-retention limitation in
the readiness record; do not claim a 10/10 release.

Official sources reviewed 2026-09-27:

- [Models and aliases](https://docs.typesafe.ai/models)
- [System One API response](https://docs.typesafe.ai/api)
- [Master Customer Agreement](https://typesafe.ai/legal/mca)
- [Privacy Policy](https://typesafe.ai/legal/privacy-policy)

## Implementation and verification result

- `server/jev.ts` still sends the configured alias unchanged. It now accepts a
  canonical versioned response only when the configured model is
  `jev-latest`/`jev-preview`; explicitly pinned IDs require exact equality.
  `MentionScore.engine` records the response model that served the request.
- Explicit 429 and documented 529 rejections enter the existing maximum-three
  persisted retry path. Generic 5xx and transport outcomes remain
  outcome-unknown and are never automatically resubmitted.
- `npm test` passed 74 tests across 11 files; `npm run typecheck` and
  `npm run build` passed. The browser smoke displayed the off-target fixture
  and opened its detail drawer with engine `jev-1.13.0`, rubric prefix
  `a88fad772230`, score, cost, and source times. Browser console: zero errors.
- The isolated live smoke used one request, 1,906 input tokens, 343 ms, and
  recorded `$0.000080052` estimated input cost under the configured list price.
  The provider returned `jev-1.13.0`; status was `off_target`, as expected for
  a synthetic record explicitly labeled as no real company/event. No real
  publisher text or price data was sent. A temporary SQLite database was
  isolated from `data/desk.db` and removed at smoke shutdown.
- Fresh-context reviewer `/root/jev_readiness_audit` marked alias validation,
  retry behavior, isolated live persistence/UI, and local/container binding
  code `PASS`. It rated overall release readiness 7/10 and called out that
  provider terms/account retention and labeled classifier
  accuracy/calibration are not closed by a synthetic smoke. Its Compose
  daemon was initially stopped; the primary task then started the dedicated
  `sentiment-desk-verify` profile and independently verified container and
  published-host connectivity.
- Quality-pass finding: an off-target-only window showed generic empty-filter
  copy. `web/src/App.tsx` now explains that the hidden off-target item is
  available through the explicit Off-target filter; reloaded browser evidence
  showed that copy and zero console errors.
- Related runtime check: native server binding remains `127.0.0.1`. Docker
  binds to `0.0.0.0` inside the container, while Compose publishes only
  `127.0.0.1:8787`. The first verification attempt was blocked because the
  dedicated Colima daemon was stopped; after starting only
  `sentiment-desk-verify`, the rebuilt isolated image passed source/API,
  dynamic loopback host-port, container-recreation, persisted-volume, and
  second host-port checks. Results: `LIVE_SMOKE_RESULT quotes=27
  companies=24 dbSizeBytes=2220032`; host API HTTP 200 on loopback port 32768;
  `RECOVERY_SMOKE_RESULT companies=24 dbSizeBytes=2273280
  pendingObservationPreserved=true`; host API HTTP 200 on loopback port 32769.
  The script removed its isolated Compose volume/network at exit.

The verified implementation and evidence are checkpointed in commit
`4996759` (`fix(jev): accept resolved alias model responses`), pushed to
`origin/codex/real-data-rebuild`. After fetching `origin`,
`git rev-list --left-right --count HEAD...origin/codex/real-data-rebuild`
returned `0 0` for the documentation checkpoint `c4004cb` as well. The only
untracked local item is the synthetic UI screenshot under `output/`; it was
kept out of Git. Release-readiness gaps remain visible and block any 10/10
claim.
