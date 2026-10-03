# Luna agent-reference extension — 2026-10-02

## Acceptance criteria

- Use only the frozen real SEC source frame; no demo/synthetic product data,
  product database writes, or external model requests.
- Label all 48 original frame cases with two fresh, blinded agent contexts,
  preserving the original 30 and additional 18 as separate denominators.
- Bind the source frame, prepared Luna requests, packet, prompt, schema, agent
  settings, and outputs by exact digests; preserve unsupported values and
  disagreements.
- Keep this a diagnostic reference study. Do not call agent consensus human
  truth or infer Luna accuracy, calibration, independent error distributions,
  population prevalence, or investor value without the needed evidence.
- Keep full Luna operational acceptance blocked unless real Luna responses,
  returned usage, provider account reconciliation, and source/model-use checks
  are present.

## Result

The extension covers all 48 cases and 15 issuers in the source frame. It
relabels the original 30 and separately labels the remaining 18, with no
sentiment-driven filtering. The reviewer packet SHA-256 is
`b425fcd5d169e19798ec33b46ec67a05095ba937747062c9342158908ad97716`.
Reference outputs were captured by two fresh isolated Codex agent contexts:
GPT-6.1 Sol (high) and GPT-6 Astra (high). Their output digests are recorded in
the private validation report; the prompts and outputs remain ignored local
evidence because the packet contains retained SEC source text.

Each reviewer marked 27 cases neutral, one negative, one positive, and 19
null for sentiment. The full-cohort 48/48 exact sentiment agreement includes
all 19 matching nulls. The original 30 contain one negative and no positive;
the added 18 contain one positive and no negative. Three cases differ on at
least one non-sentiment field: 2 in the original cohort and 1 in the added
cases. Several excerpts do not include referenced filing exhibits, so those
source limits are preserved rather than inferred away.

An independent GPT-6.1 Sol xhigh advisor verified source/packet/output hashes,
case uniqueness, preservation of the original/additional subsets, chronological
blinding, and report counts. It approved the extension only as a diagnostic
and failed full operational acceptance. Both labelers are within the OpenAI
GPT-6 family. Separate agent contexts and different requested model IDs do not
establish independent error distributions. Because the extension followed the
neutral-heavy pilot result, it is explicitly post-hoc. The one positive and
one negative example provide literal three-class coverage but insufficient
support for reliable class-level quality estimates.

## Operational state and remaining gates

No Luna request was submitted. The app's configured classifier remains
`gpt-6-luna`, with categorical structured output and no Jev fallback, but the
runtime has no direct OpenAI API credential or independently verified OpenAI
spend ceiling/readback. No genuine Luna response or usage record exists, so
model performance, completion behavior, and provider reconciliation remain
unverified. The new contract adds a distinct offline diagnostic evaluation
check and retains the separate final Luna run check, so passing the reference
parser cannot satisfy model acceptance.

Historical `legacy_unknown` usage remains quarantined because TypeSafe account
usage records are not available for the 4,700 legacy rows. Endpoint-specific
source retention and model-processing terms and sustained investor value also
remain unverified. Opportunity Radar remains disabled. Local chart acceptance
and prior scoped ETL checks remain as recorded in the completion review.

## Review and checkpoint

The previous engineering-bullshit-detector review rated saved-data usability
and local robustness 7/10, live classifier readiness 2/10, and full product
readiness 4/10. It found no reproducible local chart defect. The updated
independent detector review is recorded on this task before checkpoint.

Private evidence paths:

- `.engineering-evidence/luna-real-source/diagnostic-reference-20261002/freeze-manifest.json`
- `.engineering-evidence/luna-real-source/diagnostic-reference-20261002/reviewer-dispatch.json`
- `.engineering-evidence/luna-real-source/diagnostic-reference-20261002/validation-report.json`
- `.engineering-evidence/luna-real-source/diagnostic-reference-20261002/luna-independent-agent-reference-report.json`

Repository: `https://github.com/j-poc/sentiment-desk.git`

Branch: `codex/real-data-rebuild`

Final commit and remote readback: fill after the reviewed checkpoint is pushed.

No PR, merge, deployment, or release is authorized by this record.
