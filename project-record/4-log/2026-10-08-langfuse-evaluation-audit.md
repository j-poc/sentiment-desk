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
