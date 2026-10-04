# Sentiment Desk acceptance and checkpoint hardening — 2026-10-04

## Observable completion criteria

Sentiment Desk is complete only when every one of the 19 acceptance items in
`engineering-contract.json` has current evidence and passes. The evidence must
cover a fresh zero-input investor journey, real-source data and lineage, a
qualified GPT-6 Luna run with reconciled cost, deterministic historical Jev
semantics, recovery, the rendered UI, the frozen independent-agent comparison,
and uncoached investor and analyst outcomes. No demo or synthetic records may
enter the live product, and Opportunity Radar stays disabled until those gates
pass. Contract wording, a successful build, model agreement, source counts, or a
reviewer score cannot substitute for observed product outcomes.

## Changes in this iteration

- The first-run contract now lists SEC issuer identity/submissions, SEC
  CompanyFacts with accession and reporting-period lineage, maintained public
  consumer evidence, and an authorized price/shares/corporate-action basis as
  product-managed required datasets. The personal watchlist remains optional.
- A company may be called small-cap only when an eligible point-in-time price,
  dated shares-outstanding basis, and corporate-action treatment support the
  displayed market-cap band. Without that evidence the product must suppress
  the label and name the data gap. SEC facts retain their accession identifier
  and filing date. The acceptance timestamp, reporting period, unit, and
  amendment lineage remain distinct.
- The source-rights record now distinguishes the user's broad public-source
  and API rights attestation from endpoint-specific provider contracts,
  credentials, billing evidence, and successful live access.
- `committed-diff-check` and `github-checkpoint` now reject a dirty worktree;
  the GitHub check also verifies the expected branch and exact remote SHA.
  Previously those checks could report the current HEAD while the contract
  candidate itself remained uncommitted.
- Current official OpenAI API documentation was checked for `gpt-6-luna`.
  It lists the exact model ID, Responses API, and structured outputs; its
  published standard token rates are USD 0.10 per million input tokens and
  USD 0.50 per million output tokens. This confirms model availability and a
  reference rate, not this account's tier, balance, spend limit, or permission
  to send product data. No OpenAI API request was made. Source:
  <https://developers.openai.com/api/docs/models/gpt-6-luna>.

## Current verification and limits

- `engineering-contract.json` parses as contract version 2 with 19 acceptance
  items, 19 exact mappings, and 21 declared checks. A fresh independent
  alignment review passed alignment for the current contract/source hashes;
  product readiness remains FAIL.
- Before this candidate, local branch `codex/real-data-rebuild` and
  `origin/codex/real-data-rebuild` both pointed to `9cb15357626a02dd50372cfacf90ec1624cf21dd`.
  The contract candidate is currently uncommitted; it is not yet a GitHub
  checkpoint.
- The last live-data ETL receipt is a failure: the dedicated
  `colima-sentiment-desk-verify` Docker context is unavailable. Host free space
  is 2.8 GiB, and the currently selected Docker context belongs to another
  project. No VM was started and no alternate Docker context was used.
- The product still starts from a fixed 24-company roster. It has no zero-ticker
  discovery path, no complete filing-backed fundamental triage, and no
  persisted followed-company baseline. These remain product defects, not merely
  acceptance paperwork.
- The saved-data runtime reports external collection and classification
  paused. Its observations are genuine saved records, but they are historical
  and pending; they do not establish current market conditions or classifier
  quality. The 4,700 `legacy_unknown` observations remain quarantined pending
  original TypeSafe request and account-usage/billing evidence.
- No direct OpenAI API credential or finite account spend limit/readback is
  present in the verification runtime. No live Luna request or result exists.
  A Jev balance is not an OpenAI API budget and is not used as a substitute.
- AlphaSense access/results and observed uncoached sessions with five serious
  individual investors and five professional analysts are still absent. Blinded
  subagent references remain diagnostics, not ground truth or user outcomes.

No database, credentials, private evidence bundle, or provider request was
modified or included in Git. The current iteration is a contract and evidence
hardening step, not a product-completion claim.

## Independent review and current UI evidence

- The fresh independent contract-alignment review passed alignment only: all
  19 acceptance requirements remain present, the three modified requirements
  strengthen first-run, lineage, and rendered-interface evidence, and every
  acceptance index maps to declared checks. Its product-readiness verdict is
  FAIL; it confirms that discovery, fundamental triage, followed-company
  monitoring, Luna operation, and outcome evidence are still incomplete.
- A separate fresh whole-build review of the current in-app AAPL page also
  returned FAIL 4/10. The real saved-data page selected Apple and rendered a
  7-day historical Jev chart and source feed. API and page inspection found 245
  saved Jev observations in 32 buckets, zero Luna categories, and no current
  price. New external collection and classification were paused. The first 100
  history rows contained 20 receipt-linked pending observations and 80 older
  observations without delivery IDs; those old rows cannot support complete
  delivery lineage.
- The chart is a historical Jev impact summary with gaps, not a price-return
  chart. Its presence confirms the earlier blank-chart complaint is repaired
  for this saved-data view, not that live price or Luna charts are operational.
- The highest-value locally buildable investor workflow remains an explicit
  followed-company source-evidence baseline. It must compare exact saved
  observation IDs, preserve publication and retrieval times, surface late
  retrieval separately, exclude unreceipted/legacy/demo rows, and call results
  “new evidence” until materiality is independently established. The current
  UI has no such baseline feature.
- Alignment review artifact: `.engineering-evidence/alignment-review.json`.
  Current UI and acceptance review: `/root/whole_build_review_current_ui` and
  `/root/fresh_contract_alignment_review`. Agent findings are separate from
  user-study outcomes and do not satisfy the AlphaSense or investor/analyst
  acceptance criteria.

As of 2026-10-04 03:26 UTC, this contract/evidence candidate is still local and
must not be described as a GitHub checkpoint until a clean reviewed push and
remote SHA readback succeed.
