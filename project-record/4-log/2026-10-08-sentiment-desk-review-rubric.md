# Sentiment Desk whole-product review rubric

This rubric is shared by independent investor, UI, domain, and engineering
reviewers. It supplements the 30 observable acceptance criteria in
`engineering-contract.json`; it does not replace their pass rules. Reviewers
must inspect the complete product and cite observed workflows, persisted state,
current source evidence, and check receipts. A source-only or simulated-user
review must state that limit.

## Intended user and outcome

The intended users are serious individual investors and professional analysts
who need to decide what deserves research without starting from a ticker or
prewritten thesis. Sentiment Desk should help them discover a credible lead,
test whether a company is worth investigating, and notice a material change in
a followed company against explicit prior evidence. Every claim must be
inspectable, time-aware, and honest about coverage and uncertainty.

## Weighted score

Rate each dimension from 1 to 10 using the anchors below, then calculate the
weighted score. Give a separate confidence rating and list acceptance statuses
and material findings; do not hide them in the average.

| Dimension | Weight | Acceptance focus |
| --- | ---: | --- |
| Investor task completion | 35% | Tickerless discovery, company research-worthiness, and followed-company change; useful next action and uncoached task outcome evidence. |
| Evidence integrity and financial correctness | 25% | Real-data-only boundary; source rights and identity; point-in-time clocks; entity, period, unit, citations, duplicates, counterevidence, and justified abstention. |
| Evaluation and information value | 15% | Real Luna output and exact provider receipts; task-matched public benchmark; frozen, blinded comparisons; measured decision usefulness without overclaiming agent agreement. |
| Operational reliability | 15% | Fresh authorized sources, durable state, realistic workload, bounded spend/work, failure visibility, retries, interruption recovery, and saved readback. |
| Interface usability and accessibility | 10% | Complete rendered journeys at relevant sizes, clear hierarchy and status, efficient navigation, keyboard/focus behavior, and actionable empty/error states. |

## Score anchors

- **1–2:** Core actions fail or can mislead; evidence, identity, time, or state
  errors can change an investor's decision.
- **3–4:** Useful pieces exist, but one or more core investor jobs cannot be
  completed reliably; the UI may present an empty, stale, or partial path as a
  decision-ready result.
- **5–6:** A bounded workflow works and discloses its limits, but major product
  jobs, live evidence, user-outcome proof, or evaluation remain incomplete.
- **7–8:** All in-scope professional workflows work on representative real
  inputs, with strong evidence traceability, useful recovery, and no material
  correctness defects; residual uncertainty is narrow and explicit.
- **9:** Acceptance is met across representative live and saved-data
  conditions, independent reviews agree on the observed outcomes, and the
  product shows a measured advantage for the named investor job.
- **10:** Every mandatory acceptance item passes on the current artifact;
  intended users complete the workflows at the frozen thresholds, the
  predeclared comparative evaluation supports the product's advantage, and no
  material usability, evidence, or reliability defect remains.

A score cannot be 9 or 10 if any mandatory acceptance item is failed, blocked,
or unverified, if the actual rendered journey was not inspected, or if a real
model/source workflow is claimed without current observed receipts. Reviewers
must report individual dimension scores, weighted score, confidence, and any
disagreement. A simulated user or subagent may surface hypotheses and code
defects; its feedback is not an observed investor outcome or ground truth.

## Existing ratings

The 4/10 ratings recorded by earlier UI and investor reviews predate this
rubric. Retain them as historical, uncalibrated assessments; do not present
them as scores calculated with these weights. The next independent whole-build
review should apply this rubric to the current candidate and record its
evidence and uncertainty.
