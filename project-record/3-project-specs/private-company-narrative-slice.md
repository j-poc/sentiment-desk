# Private-company narrative context — Sentiment Desk scope slice

**Recorded:** 2026-10-08
**Source specification:** user-supplied private-company research requirements, version 1.1 (conversation source; no file hash asserted)
**Source addendum:** user-supplied free-only source plan, version 2.0 (conversation source; no file hash asserted)
**Status:** requirements integrated; runtime capability not implemented or qualified.

This slice applies only the public-source narrative requirements to Sentiment Desk's existing listed-company evidence workflow. It does not turn the Desk into a private-company financial database, and private files, private-company data access, and proprietary customer data are not required for the build. No private input is accepted in this scope.

## Investor job and boundary

When an investor reviews a real saved source about a configured listed issuer that mentions another company, the Desk should help them distinguish a source-reported operating or financial claim from opinion, forecast, or attention. The configured Desk issuer and the claim's subject entity are separate identities: mentioning a company does not make the claim about the Desk issuer or establish issuer revenue, sentiment, or investment exposure. The Desk should retain the source's origin and time basis, and it should never turn mentions, sentiment, search activity, or a company-reported number into independently verified financial performance.

For this slice, a named private company is contextual evidence inside an existing listed-issuer source. It is not yet a standalone company profile, covered security, valuation subject, or monitored thesis. Verify legal-entity identity and listing status at the investigation cutoff from eligible evidence; if that evidence is absent or ambiguous, show the status as unknown. Do not permanently label Anthropic, OpenAI, or any other company as private based on this specification.

No new source, account, credential, collection, retention entitlement, model call, private-data upload, or alert path is activated by this record. The existing SEC/Compose and Luna source/account/spend gates are unchanged. This scope record does not make the stale SEC receipt current or establish that any configured feed currently contains a usable private-company claim.

## Source selection and acquisition boundary

The source plan is constrained to external routes that are free to access for
the intended use. Exclude subscriptions, paid feeds, paid APIs, per-query or
per-record charges, paid trials, and paid-tier dependencies. A source being
publicly viewable or having a free endpoint does not by itself grant rights to
collect, retain, process with a model, display, or redistribute its content.
Verify the current endpoint terms for each of those uses before any future
adapter is considered. If terms or costs are unclear, do not collect the data;
an analyst may follow a public link manually. This scope does not require or
accept private files, tenant data, or proprietary customer records.

If a later scope is authorized, begin with the exact public primary record or
official disclosure that supports the stated claim, and add another free
public source only when it answers a named research question. Record the
source, endpoint, current terms, fees, permitted uses, limitations, and clocks
before collecting anything. No source route, paid database, demand feed,
private file, or provider account is enabled or required by this record; none
was tested or admitted by this build. Do not equate a public webpage with an
authorized production feed or infer commercial terms from a zero-price API
key.

Before any future source route becomes an adapter, preserve the exact public
endpoint, the no-fee basis and current terms, collection/retention/model/display
rights, bounded real sample, entity and field coverage, observation/event/
publication/retrieval clocks, rate limits, and the specific research gap it
closes. Exercise wrong entity/period/unit, stale or missing data, amendments,
duplicate origins, interrupted writes, changed terms, and unsupported
extrapolation. Keep a general rights attestation distinct from tested
source-specific permission. Do not change current SEC/Compose, Luna account,
spend, or source gates to make this scope appear operational.

## Current capability status

| Status | Requirement area | Current evidence and limit |
|---|---|---|
| **Implemented** | Real-source observation records preserve source identity, URL, publisher, publication/aggregator/provider-observed times, retrieval time, ingestion time, and delivery linkage. Observations are immutable. | `server/db.ts` stores these clocks and receipts. This establishes saved-row lineage, not current coverage or independent verification. |
| **Implemented** | The classifier contract is categorical and source-bounded; source text is treated as untrusted input. | `server/openai-classifier.ts` targets a configured listed issuer and stores sentiment/event judgments and a quoted excerpt. This is the implemented baseline contract, not a private-claim classifier or a live-qualified profile. |
| **Partial** | Origin and repeated-report handling. | Publisher/domain fields and exact-headline grouping exist. Title similarity and publisher identity do not establish independent origins; there is no general source-origin graph for a private-company claim. |
| **Partial** | Public-company fundamental and saved-evidence review. | The Desk has listed-company facts, immutable saved observations, source clocks, and an analyst review queue. Those are not a normalized assertion ledger or a saved-assumption model. |
| **Partial** | Point-in-time source operation. | Receipt, freshness, recovery, and per-source rights gates exist. The registered SEC feed has a current receipt as of 2026-10-08 15:45 UTC; the broader Desk still lacks a qualified live Luna run. |
| **Partial** | Source-choice and provenance requirements for public-source context. | The free-only eligibility and rights gate is recorded. No external source was sampled or admitted by this slice. |
| **Missing** | Distinct Desk-issuer and claim-subject identities, with time-bounded private legal-entity identity, aliases, and listing status at the investigation cutoff. | `companies.ticker` is required and the classifier input is for a public issuer. No contextual-entity identity/status history exists; a mention cannot establish which entity a claim concerns. |
| **Missing** | Claim-level distinction between reported metrics/facts, qualitative claims, opinion/forecast, attention proxies, and mixed or unresolved content. | Current sentiment, event type, and summary fields do not encode this distinction or source truth. |
| **Missing** | Claim fields for exact entity, original reported value, definition, period, currency/scale, source passage, attribution, conflicts, and supersession history. | Company fundamentals have structured SEC facts for listed issuers; the news classifier is not an assertion-normalization workflow. |
| **Missing** | Material-change monitoring against an explicit saved assumption and its evidence dependencies. | Followed baselines track eligible newly saved source observations. The analyst queue's user-authored question is not an assumption, and baseline differences do not establish materiality. No private-company alert is supported. |
| **Missing** | An Anthropic-versus-OpenAI investigation with verified entity status, compatible metrics, source-backed conflicts, and saved result. | The two-company investigation is only a candidate reference case. No source cohort, comparison, or result is established here. |
| **Inapplicable to this slice** | Private files, tenant/customer records, paid data providers, paid research, valuation of private instruments or share classes, and unsupported ownership-exposure calculations. | None is required or enabled. Publicly reported business, investment, or contractual relationships may remain attributed narrative context; they do not establish ownership exposure or valuation. |

| **Unverified** | Decision quality, source coverage, performance, customer demand, and commercial advantage for private-company research. | There is no qualified private-claim runtime, real evaluated cohort, or observed investor workflow for this scope. Agent review and product requirements cannot substitute for those outcomes. |

## Smallest relevant next implementation slice

Any later runtime work is optional and must start with already eligible, real, free-to-access public observations for a configured listed issuer. It does not require private files or private data. If authorized, it should add public-source private-company claim context. It must add a versioned claim-form judgment that describes what the source says, not whether the claim is true; keep claim form (reported metric, qualitative assertion, opinion/forecast, attention proxy, or mixed/unclear) separate from evidence basis (company-reported, third-party reported, corroborated, disputed, or unknown); bind each claim to its exact subject entity, definition, period, currency/scale, source passage, attribution, and observation/event/publication/availability/retrieval/ingestion times; preserve contradictory and repeated-origin evidence; and show unknown when entity, origin, or a required clock is unsupported. Attention and sentiment remain separate from operating and financial claims.

The first UI path should start from the existing saved-source record and keep the Desk issuer, distinct claim subject, source link, original excerpt, publisher/origin, evidence basis, and all available clocks visible. A private-company claim can enter a saved-thesis review only after a distinct user-authored assumption/dependency model exists and the attributed evidence is point-in-time eligible and relevant to that exact assumption. A single original or official source may create an explicitly uncorroborated review draft; it cannot be presented as independently confirmed or as an accepted thesis change. Source independence governs corroboration and duplicate counting, while conflicts and repeated reporting stay visible. Any material-change alert must identify its evidence basis and cannot infer truth from sentiment, mentions, or attention. Until the assumption model exists, the record remains contextual evidence and no thesis-change alert is emitted.

The live AI classifier and alerts are **not ready to enable or release**. The current company model is keyed to listed issuers, the Luna output has no claim-form field, no real private-claim reference set or persisted Luna output exists, and the working environment has no direct Luna credential or current qualifying source sample. These facts block an evaluated live AI profile; they do not preclude a separately bounded deterministic evidence model or UI implementation. Any such work must still use eligible real saved observations, remain honest about unknowns and uncorroborated claims, and pass the existing source, account, and spend gates before live classification. Do not fill this gap with generated examples, synthetic product rows, or assumed source rights.

## Runtime acceptance before enabling the slice

Use a frozen, rights-cleared set of real source items, including source-reported metrics, third-party reporting, analyst opinion or forecasts, attention proxies, mixed/unclear claims, duplicated reporting, conflicts, ambiguous entity names, and cutoff-boundary cases. Preserve the original source artifacts and exact versions; do not count generated examples as evaluation cases. Blinded subagents may provide diagnostic references under the user's direction, but their agreement is not human ground truth or proof of source truth.

The actual saved-data UI and persisted record must show:

1. the configured Desk issuer and claim-subject legal entity as separate fields, with listing status as of the research cutoff or `unknown` and the missing evidence stated;
2. claim form and evidence basis as separate judgments, with exact source attribution and no treatment of company reporting as audited or independently corroborated;
3. exact source origin/dependence and observation, event, publication/availability, retrieval, and ingestion times when known, with unknown times left unknown;
4. original reported metric, definition, period, currency, scale, and deterministic normalization inputs when present; incompatible periods or units block comparison;
5. contradictory and repeated-origin evidence without counting reposts as independent corroboration;
6. no private-company thesis-change alert unless a user explicitly saved the affected assumption and the evidence satisfies source, time, and materiality checks; a single attributed source may support a clearly uncorroborated review draft, while independent origin governs corroboration and duplicate counting;
7. pending, stale, unavailable, and failed states with the existing source-gate and recovery behavior intact.

Before release, rerun a task-matched public benchmark and a frozen set of rights-cleared real protected cases through the exact served prompt/schema/profile. Include missing/unknown origin and first-availability times, competing entities, incompatible units/periods, conflicts, duplicate origins, and partially supported sources. Require zero critical unsupported financial assertions, wrong claim-subject entities, wrong units, or invented citations on the protected set; report denominators, abstentions, unsupported subclaims, and valid partial answers separately. Check claim-to-source support separately from usability, and verify the actual UI and database readback. This finite protected set cannot establish broad private-company data quality, private investment value, or a general product advantage. A separate later scope is required before private uploads, paid providers, comparisons of private-company economics, or proactive financial monitoring. Private files and private data remain outside this build.
