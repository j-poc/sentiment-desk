# Whole-build engineering bullshit detector review — 2026-09-29

## Verdict

**FAIL.** The requested fully operational Sentiment Desk and 10/10 readiness
are not evidenced. This is the verdict from a generic read-only reviewer using
the complete rubric in
`/Users/jurgis/.codex/agents/engineering_bullshit_detector.toml`; the specially
named agent type did not launch. The local implementation, saved-data UI, and
keyless source/recovery path have meaningful verified coverage, but they do
not prove the live source → Jev → persisted judgment path or release authority.

## Invocation and review scope

The user requested a whole-build review with the named
`engineering_bullshit_detector` subagent. The launcher returned the exact
error `unknown agent_type 'engineering_bullshit_detector'`. A generic
read-only fallback was used and is explicitly labeled here; the named custom
role did not run. The fallback inspected the current checkout, requirements
and project records, source-to-storage/API code, selected UI/API runtime
responses, and outstanding release gates. It did not run tests or drive the
browser. The primary agent independently drove the current browser build and
ran the declared test/data-pipeline checks afterward.

## Requirements against evidence

| Requirement | Status | Evidence and limit |
|---|---|---|
| Finish the Desk and establish operational readiness | **MISSING** | Source operation can be exercised without Jev, but no authorized TypeSafe account/spend ceiling or successful real-source Jev evaluation is available. The core live source → Jev → persisted judgment path is therefore unverified. |
| Real data only; no demo or synthetic product data | **PARTIAL** | Current saved-data research reads exclude `demo_simulation` and `legacy_unknown` rows (`server/db.ts`). The saved-data preview uses persisted source-backed rows. Historical `legacy_unknown` records still have unverified source and model-use lineage, so the broader “all data ever used” claim cannot be made. Test/evaluation fixtures are not presented as product observations. |
| Jev is the per-item sentiment classifier | **PARTIAL** | `server/pipeline.ts` calls Jev for source observations and applies deterministic post-processing, but Jev remained disabled during the real-source smoke and no passing blinded real-source evaluation exists. |
| Company selection, chart, and older-feed recovery work | **MET for verified local paths** | Browser interaction on `127.0.0.1:8797` selected Adobe and rendered saved sentiment and Yahoo price lines; Apple Unscored loaded 100 records and “Load older” increased the list to 200. The current API returned HTTP 200 JSON with two items and a next cursor for `/api/companies/apple/mentions-page?filter=failed&limit=2`. These checks prove the saved-data UI/API path, not Jev quality. |
| Defer further Opportunity Radar work until Desk readiness | **MET for current scope** | Radar code exists from earlier work; current records say the Desk gate has not passed and further Radar work/promotion is parked. No Radar expansion was part of this checkpoint. |
| Checkpoint the work to GitHub | **PENDING AT REVIEW; closed by follow-up checkpoint** | The reviewer found the pagination, tests, and records uncommitted. The resulting commit and remote SHA are recorded below after push. |
| Keep project records accurate | **MET after reconciliation** | This trace replaces the prior “review not run” statement; the completion plan now labels old phase checkboxes as historical; the source-approval record points to the actual fallback verdict and later verification. |

## Verified implementation and runtime behavior

- `server/db.ts` implements filtered keyset pagination over saved,
  source-identified mention rows. Failed/pending/scoring/corrupt items use an
  all-history window; other filters use the disclosed seven-day window.
- `server/app.ts` validates filter and cursor input for
  `/api/companies/:id/mentions-page`. `web/src/App.tsx` keeps per-company and
  per-filter cursors, merges live updates by observation identity, reports
  load failures, and offers an older-page control.
- Regression coverage includes a failed item older than seven days, cursor
  stability when an item's status changes, older matching rows beyond the
  first 100, malformed cursor rejection, and usage-review requirements for
  attempted historical failures.
- Browser readback used an isolated database copy with external requests and
  Jev disabled. It showed 24 configured companies, source-backed saved
  observations, selection-driven chart updates, and the 100-to-200 older-page
  flow. It did not use synthetic product observations.
- The keyless Compose smoke is separate from that saved-data preview. It
  fetched real public-source responses for 24 companies, reported 27 quotes,
  persisted one publisher-timed Google News RSS observation in pending Jev
  state, and after container recreation retained that observation in the same
  isolated database volume. Host health returned HTTP 200 before and after
  recovery. It used no credentials and made no Jev request.

## Local verification and evidence binding

The first gate attempt could not start the live container because the dedicated
`colima-sentiment-desk-verify` Docker context had not yet been created. The
Sentiment Desk-specific Colima profile was started; the final gate then passed
without using the separate Citrini profile.

An initial `live_data_etl_gate.py verify` and subsequent `check` returned
**PASS** at `2026-09-29T11:37:28Z`, with all five declared checks passing:

1. `fixture_suite` — full fixture suite, 216 tests across 29 files.
2. `failure_recovery_regressions`.
3. `pipeline_replay_regressions`.
4. `offline_source_request_gates` — production build and blocked-request
   verification.
5. `authorized_keyless_live_smoke` — real-source delivery and isolated-volume
   recovery described above.

`npm run typecheck`, `npm run build`, `git diff --check`, and JSON parsing of
the ETL contract passed. The build retains the existing Vite large-chunk
advisory. The gate fingerprints project records as well as code and config;
adding this review trace and reconciling historical status correctly made the
11:37 evidence stale. It must not be cited as current proof. The required final
`verify`, followed by `check`, is run only after this record and the code are
committed; `live-data-etl-evidence.json` is authoritative for the resulting
timestamp, fingerprints, and individual check results.

## Highest-impact remaining gaps

1. **No live source → Jev → persisted judgment proof.** The live smoke stopped
   with pending Jev state by design. Clearing this requires documented
   authority from the TypeSafe account owner, verified permitted use,
   retention/telemetry terms, provider limits and a spend ceiling, followed by
   an approved real-source evaluation. A working local model adapter or a
   synthetic pilot cannot substitute for this evidence.
2. **No contact-bearing SEC User-Agent.** SEC collection must remain disabled
   until an authorized contact value is configured and the endpoint is
   verified under that identity.
3. **No independent Jev-quality evidence.** At least two independent reviewers
   must create blinded provenance-backed real-source labels, followed by the
   frozen evaluation and a passing result. No source/request should be sent to
   Jev to manufacture this evidence before account-use approval.
4. **Historical usage remains unreconciled.** The isolated saved-data audit
   found 4,700 `legacy_unknown` observations and stored usage estimates, but
   these local rows are not provider receipts or billing records. Reconcile
   with TypeSafe/provider usage and billing evidence; do not treat the saved
   attempt counters as proof no request occurred.
5. **Coverage remains finite and incomplete.** Optional feeds are disabled,
   RSS response completeness is unknown, and provider-specific coverage and
   terms remain distinct from a broad “public web” claim.

The user's statement “i have rights for all, public sources and apis” is kept
as the user's source-use attestation. It is not represented as a reviewed
endpoint agreement or TypeSafe account-owner authorization.

## Goal and checkpoint

The existing native goal already has status **blocked** and its objective
already requires real-source Jev evaluation, operational acceptance evidence,
and GitHub checkpoints. No status change is justified: mark it complete only
after the external evidence above closes, and do not begin further Opportunity
Radar work before then.

The local implementation, regression tests, and project records are being
checkpointed to `origin/codex/real-data-rebuild` after this review. A checkpoint
is complete only after the remote branch matches the local commit. The final
branch SHA and remote readback are reported in the task completion message.

## Final post-push reviewer follow-up

After implementation and evidence were pushed at `3258e6d`, the same
read-only fallback reviewer inspected the synchronized checkout again. It
reconfirmed **FAIL** for operational readiness, verified `HEAD` matched
`origin/codex/real-data-rebuild`, and found **no remaining fixable defect**.
The reviewer independently read the current paginated API and saved Adobe
series/price endpoints; the browser 100-to-200 flow remains primary-agent
evidence. The final disposition is unchanged because the real-source-to-Jev
path and external account, SEC, evaluator, usage-reconciliation, and coverage
evidence remain open. Its follow-up did not run tests; the ETL evidence artifact
records the primary agent's post-push run.
