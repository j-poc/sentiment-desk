# Langfuse best-principles evaluation audit

Date: 2026-10-08

Scope: Read-only audit of the existing Sentiment Desk classifier evaluation and its evidence. This is not a classifier-quality pass. No model/provider requests were made, and application code, acceptance criteria, and evaluation definitions were not changed.

## Verdict

**Classifier qualification: FAIL / NOT VERIFIED.** The repository has a real-source Luna agent-reference pilot, but no Luna prediction run against it. Agreement between reference agents is not model accuracy, ground truth, or evidence of investor value. Jev's existing qualification remains blocked and separate from the selected Luna path.

## Findings

| Area | Status | Evidence and limit |
| --- | --- | --- |
| Traces and run identity | **UNVERIFIED** | The Luna report says there is no classifier run. No bound prediction output, trace, response receipt, usage, cost, or latency is available. Reviewer records have configured model `gpt-6-luna`, but resolved model and model-resolution evidence are null. The audit cannot verify the serving API's model identity from a Codex subagent model label. |
| Reference dataset | **DIAGNOSTIC ONLY** | `.engineering-evidence/luna-real-source/luna-independent-real-source-labels.json` and its report bind 30 real SEC filing cases across 15 issuers to the pilot. The sentiment mix is 29 neutral, 1 positive, and 0 negative; directional-class recall and generalization are not established. Sparse `other` events also limit event-type coverage. |
| Reference agreement | **MEASURED, NOT GROUND TRUTH** | The saved report records 29/30 raw sentiment agreement and 27/30 event-type agreement, with unresolved labels on one case. These numbers describe agent-reference agreement only. The two reference agents and adjudicator were all configured as GPT-6 Luna; separate contexts are recorded, but independent model-family lineage is not verified. `humanGroundTruth` is `NOT_PROVIDED`. |
| Evaluator | **STRUCTURALLY SOUND, OUTCOME UNTESTED** | `scripts/luna-label-evaluation.ts` binds case/source/request/prompt/schema digests and requires a supplied run for final scoring. With no classifier run it correctly emits an `UNVERIFIED` pilot report; this does not establish the evaluator's false-pass rate or classifier quality. |
| Error analysis | **UNVERIFIED** | No Luna predictions means there is no classifier confusion matrix, false-inclusion analysis, class-specific error review, or output-linked failure analysis. The one unresolved reference case is not a classifier error. |
| Public benchmark | **MISSING** | No run evidence was found for FinFIRST, FinSearchComp, FinRetrieval, or PHANTOM. The finance-build instructions require a task-matched public benchmark alongside protected workflow cases, with citation, entity, period, unit, numeric, and abstention checks. |
| Investor outcome | **BLOCKED** | The Master Eval remains blocked without paired AlphaSense outputs and prospective task outcomes. No result establishes zero-ticker discovery, company research-worthiness, followed-company change, retention, or investment value. |
| Historical Jev | **BLOCKED, SEPARATE** | The recorded Jev evaluation logs reject their input as `INVALID_OR_UNVERIFIED_INPUT` because `.engineering-evidence/real-source/jev-independent-real-source-labels.json` is absent. Its manifest also lacks a qualifying real-source run and provider usage reconciliation. Jev history is not evidence for the Luna classifier. |
| Langfuse instrumentation | **NOT PRESENT** | Current evidence is repository-local JSON and deterministic scripts. There is no Langfuse trace/run record to inspect; adopting Langfuse is not necessary to explain the current verdict, but the requested tracing/experiment evidence is absent. |

The user asked for independent subagent references in place of human labels. The current pilot does use separate subagent contexts, but their model identity and independence are not verified, and agent consensus remains reviewer-reliability evidence rather than truth. Keep that limitation visible.

## Current local verification

- `npm test -- --reporter=dot --maxWorkers=1 --testTimeout=20000` — **PASS**, 105 files and 825 tests.
- `npm run typecheck` — **PASS**.
- `npm run build` — **PASS**; Vite warns that the minified web bundle is 823.24 kB, above its 500 kB advisory threshold.
- `git diff --check` — **PASS** for tracked changes; the new audit note also passed a trailing-whitespace scan.
- `python3 /Users/jurgis/.codex/scripts/live_data_etl_gate.py check --workspace /Users/jurgis/Codex/sentiment-desk` — **FAIL**: `delivery_ttl_seconds` is missing for six sources that currently declare cache delivery (`sec_edgar`, `yahoo_quote`, `reddit`, `x`, `typesafe_jev`, `openai_luna`). This is a separate live-data contract issue, not evidence about classifier quality.
- `python3 /Users/jurgis/.codex/scripts/engineering_gate.py verify --workspace /Users/jurgis/Codex/sentiment-desk` — **FAIL** because the alignment review source hash is stale. `engineering_gate.py check` then reports an invalid receipt status. The quality-loop status also reports stale checks and uncovered edits after the current candidate changes.

## Required next evidence

1. Resolve the cache-delivery declarations against actual source behavior, then rerun the ETL contract check; do not invent a TTL merely to silence validation.
2. Restore a current accepted SEC 8-K Hub receipt and exercise the real filing-selection, source-detail, and recovery journey in the running Desk.
3. Verify the exact authorized OpenAI API model/profile and bounded account spend path. Then run Luna on a prospectively frozen, adequately represented real-source cohort and retain exact request/response/model/usage/latency receipts.
4. Compare those predictions with the blinded reference labels while reporting their limits; add the required public benchmark and protected cases. Keep classifier quality and investor-task value as separate outcomes.
5. Complete the paired investor-task evaluation and refresh the aligned completion evidence only after source, tests, rendered workflows, and review inputs are frozen.

Opportunity Radar remains deferred. This audit does not qualify Sentiment Desk or close the active product goal.

## Oct 8 post-change reconciliation

This follow-up supersedes the earlier local-verification counts and cache-contract failure above; it preserves the classifier verdict and the missing-evaluation evidence.

- **Current engineering map:** the independent mapping review confirmed all 26 acceptance criteria map exactly once to declared checks. The engineering gate still fails before running checks because `.engineering-evidence/alignment-review.json` has stale source, contract, and artifact hashes. This is an evidence-binding failure, not a passing completion receipt.
- **Current real-data check:** the native live-data ETL receipt passes 8 of 9 checks. The authorized keyless live smoke and persisted-volume recovery pass; the sole failure is `sec_filings_current_hub_receipt`. The connected Public Data Hub is unavailable and its required 8-K dataset is not currently supplying rows. The current 8797 preview is explicitly saved-data-only, with external requests paused, no Luna classifications, no SEC inbox rows, 141 receipt-linked Apple chart points, and no live quotes. It cannot demonstrate current quote expiry or the new filing-detail interaction on a real filing.
- **Quote-expiry regression:** the server filters quotes at their 15-minute retrieval-age deadline, broadcasts the expired snapshot, and keeps saved chart history. The browser schedules expiry at the precise deadline and rechecks on focus/visibility recovery. The full suite now passes 106 files and 828 tests, including the retained quote-expiry regression. This is code and test evidence; no expiring live quote was observed in the saved-data preview.
- **Current code checks:** `npm run typecheck` and `npm run build` pass; Vite still reports the minified web bundle over its 500 kB advisory threshold. `git diff --check` passes. The refreshed registered whole-suite run passes; task-level investor outcomes remain unverified.
- **Current whole-build review:** the independent reviewer verdict is **FAIL**. The missing current SEC filing receipt leaves zero real inbox rows; new Luna classifications remain disabled with zero eligible Apple classifications; selected-company fundamentals are stale and totals-only; followed-company evidence reports new eligible records but does not decide materiality. No public finance benchmark, paired AlphaSense result, or uncoached investor/analyst outcomes are present. The current source worktree is not yet the pushed checkpoint.

The classification-evaluation conclusion remains **FAIL / NOT VERIFIED**: there is no Luna prediction run, resolved provider model identity, usage/cost/latency receipt, balanced held-out reference set, validated evaluator error rates, or investor-outcome result. The 30-case reference cohort remains 29 neutral, 1 positive, 0 negative; the agent reviewers share configured GPT-6 Luna labels with unverified resolved model lineage, and `humanGroundTruth` remains `NOT_PROVIDED`. No model-provider call or new evaluation was made for this audit.

## Independent review before final checkpoint

Before the final checkpoint was pushed, the independent acceptance review reported **11 PASS, 9 UNVERIFIED, 5 BLOCKED, and 1 FAIL** across the 26 declared criteria. It verified the exact one-to-one map, but the saved review file was stale and the candidate had not yet been pushed. These historical findings were refreshed below; they are not the final checkpoint verdict.

Two scope gaps remain visible in the audit. First, finance-build policy requires a task-matched public benchmark, but no current acceptance item or check maps that requirement. The benchmark is missing, and the current contract does not make that requirement auditable. Second, the ETL checks `sec_filings_inbox_protocol` and `sec_filings_inbox_failures` describe filing-detail API coverage although their command lists omit `tests/sec-filing-detail.test.ts` and `tests/app-sec-filing-detail.test.ts`. The separate engineering detail check does cover those tests; the ETL check descriptions should not be used as proof of them.

## Final checkpoint reconciliation

- The implementation checkpoint is pushed to `codex/real-data-rebuild` at `4f393325e82c4b9d57d137070443a0811d1dc9f2`; local and remote SHAs match and the worktree is clean. Generated local verifier receipts are excluded by the repository's narrow ignore rule and were not committed.
- The fresh independent review is bound to the current source, contract, and artifact hashes. Its findings are **12 PASS, 9 UNVERIFIED, 4 BLOCKED, and 1 FAIL** across all 26 mapped criteria. It verifies the GitHub checkpoint criterion, but sets `request_coverage` to **fail** because the required task-matched public finance benchmark has no acceptance/check mapping.
- The native engineering gate therefore remains **FAIL** with `alignment review request_coverage must be pass`; its check reports `invalid receipt status`. The gate stopped before executing the declared check list. The registered whole-suite checks independently pass on current inputs (106 files, 828 tests), while the task outcome remains UNVERIFIED.
- The live-data ETL gate remains **FAIL** solely on `sec_filings_current_hub_receipt`; the connected Hub is unavailable or its required feed is not supplying rows. No real filing-detail interaction can yet be observed in the running product.

This reconciles the earlier stale-review and unpushed-checkpoint notes above. The audit still made no application-code, acceptance-criteria, or evaluator-definition changes and no model-provider calls. Classifier qualification and Sentiment Desk operational completion remain open.
