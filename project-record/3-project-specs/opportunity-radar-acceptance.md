# Opportunity Radar: supported evidence-convergence view

Status (2026-09-29): Radar code and its local first-release checks already
exist from earlier work, but this is only a historical implementation record.
The current Sentiment Desk operational gate has not passed. Per the user's
phase order, keep further Radar work, promotion, and readiness claims parked
until Sentiment Desk is operational. The earlier discovery and its evidence are
in `project-record/4-log/2026-09-27-opportunity-radar-discovery.md`.

## Assumptions

- The first useful release can support the research job using the existing
  company-news and filing records. Optional social feeds are included only
  when already configured and permitted; missing feeds remain a coverage gap.
- Exact normalized headline equality is a conservative copy-counting proxy.
  It does not identify a real-world event, infer narrative meaning, or prove
  independent reporting. A publisher domain/name is only a practical
  publisher identity proxy; corporate ownership is not resolved.
- Existing Jev fields provide the only item-level sentiment and event type.
  A second model call, prompt change, embedding service, or new paid provider
  is out of scope for this first Radar release.
- Equal elapsed-time windows use local epoch milliseconds and the publisher-
  declared instant stored by the source adapter. Exchange-market calendar
  adjustments are not applied.

## User outcome

When the researcher is investigating a watched company, they need to see which
Jev event categories have more or less source activity than the immediately
preceding equal-length period, whether the evidence is directionally mixed,
and which source items justify the counts. The first useful result is a
company-specific comparison that can be opened from the same local dashboard
and drilled into source links without treating mention volume as an
investment recommendation.

## Interface decision

Use an in-app `Desk | Opportunity Radar` segmented navigation view and keep
the selected company shared between the views. An independent route or
cross-company dashboard would add context switching and comparison claims
before the project has evidence for topic resolution or market-wide event
identity. Revisit that choice if researchers need saved Radar links or
cross-company theme discovery.

The Radar answers four questions: what Jev categories have more activity,
how that compares with the previous equal period, how many distinct
publishers and exact-normalized headline groups support it, and what
counter-direction evidence is present. Source and timestamp controls remain
next to those results. On mobile the same navigation and company selector
must remain reachable without horizontal overflow.

## Supported inputs and calculations

- Include only Jev `scored` judgments on source observations for the selected
  watchlist company. Jev remains the per-item sentiment, investor-relevance,
  event-type, and takeaway classifier; Radar makes no model call.
- Use the fixed Jev event taxonomy: results, corporate action,
  legal/regulatory, leadership, product, analyst action, macro/sector, and
  other. These are classification buckets, not claims that items describe
  the same real-world event.
- Compare publisher-declared publication/filing time in the current window
  with the immediately preceding equal-duration window. Do not substitute
  provider observation, retrieval, ingestion, or legacy-unverified time.
- Show current/prior item counts, change, positive/neutral/negative counts,
  unique publisher domains (publisher names only where a domain is absent),
  and exact-normalized headline groups. Deduplicate counts by normalized
  headline within a company/category/window; keep every matching source row
  inspectable, and label this as headline matching rather than event identity.
- Show scored items retrieved in the current window but excluded for absent
  or unverified publication time in a separate untimed count. Never turn
  unknown timing into zero activity.
- Show source links, publisher identity, Jev category/sentiment/takeaway,
  publisher time, and collection time on evidence rows. Surface coverage
  delivery state so empty, pending, and failed input are not conflated.
- Supported source families are the existing news RSS and SEC 8-K collectors,
  GDELT when its public endpoint is reachable, plus optional Finnhub, X, and
  Reddit only when operator credentials and source terms permit use. A source
  not enabled or currently failing is a visible coverage gap.

## Explicit limits

This release does not claim sentiment velocity across the whole public web,
retail investor movement, high-confidence thesis validation, causality, alpha,
or investment merit. It does not use options flow, short interest, float,
retail order flow, search trends, app-store reviews, jobs, YouTube, podcasts,
or arbitrary scraped pages. It does not infer supply-chain relationships or
second-order beneficiaries from co-mentions. Any later addition needs a
supported provider, verified units and timing, applicable rights, and its own
acceptance tests.

## Acceptance

1. The running Radar view uses persisted Jev judgments and includes publisher
   provenance and the fixed current/past equal time windows.
2. Independent examples prove exact headline grouping, publisher counting,
   sentiment balance, comparison deltas, category separation, and evidence
   links. Same-collector replays and aggregator copies do not inflate the
   publisher count; similar but distinct headlines remain visible separately.
   Every headline group and each source row can be inspected through paginated
   current- and previous-window evidence, beyond the five groups initially
   shown per category.
3. Unknown and legacy-unverified times are excluded from velocity and appear
   in an explicit untimed count. Missing Jev judgments are not counted as
   neutral or as an absence of activity.
4. Empty, partial, failed, and disabled collectors stay distinguishable from
   successful empty delivery in the supporting coverage state.
5. The in-app view preserves the selected company and returns cleanly to Desk;
   desktop and 390px flows expose the comparison, supporting evidence, and
   source-time basis without horizontal overflow.
6. Unit, type, production-build, API-path, browser, and final Compose recovery
   checks pass. Documentation and project records state which source families
   are supported and which rights or coverage questions remain unverified.
7. The optional demo route is visibly labeled synthetic and never presented as
   Jev or live evidence.

## Evaluation contract

Hard gates are criteria 1–7 above. Objective measures and their proxy limits:

| Measure | Expected evidence | Proxy limit |
| --- | --- | --- |
| Headline grouping | Case and punctuation variants produce one exact-normalized group; a paraphrase remains a separate group. | Does not establish whether two headlines report the same event. |
| Publisher convergence | Same publisher through two collectors counts once per exact headline; a second publisher increases publisher count. | Domain/name is not corporate ownership or editorial-independence proof. |
| Direction balance | Positive, neutral, negative, and inconsistent same-publisher copies are counted in their explicit buckets. | Jev judgment quality is not re-evaluated by aggregation tests. |
| Time comparison | Current and immediately prior equal windows have independently derived totals; missing publisher time appears separately. | Does not prove upstream source timestamps are correct or comprehensive. |
| User workflow | A browser user can select the company, open Radar, inspect category evidence and source clocks, change the period, and return to Desk. | Agent browser automation proves the rendered workflow only, not researcher decision quality or usability. |
| Degraded input | Failed/disabled source delivery and pending evidence remain visible beside scored evidence. | A local fixture proves state rendering, not provider uptime or rights. |

Representative success cases use same-publisher syndicated copies, the same
headline from another publisher, a distinct but related product headline, a
separate results event, and a prior-period item. Failure cases add an untimed
provider observation, a pending Jev judgment, an unsupported stored category,
an unknown company, and a failed collector receipt. Expected counters are
derived from the saved row list before checking the API response.

Subjective choices left visible for user review are the shared-company tab
versus a cross-company Radar, the default comparison period (currently 24h),
and whether the neutral visual language is clear enough to distinguish
category activity from an “opportunity” recommendation. The selected defaults
preserve the existing company context, match the Desk's 24h baseline, and
avoid implying investment action. User preference can change those choices;
it cannot turn unavailable data into evidence.
