# Phase 1 architecture: operational Sentiment Desk

Status: selected after comparing two storage shapes and an independent review.
This design does not implement Opportunity Radar. Radar consumes the proven
observation/judgment records after the Phase 1 acceptance gate.

## Caller usage

Source adapters submit a provider observation. They do not submit a sentiment
score or choose a final event impact:

```ts
const stored = desk.insertObservation({
  companyId,
  collector: "google_news_rss",
  channel: "news",
  publisher: { name: item.publisherName, domain: item.publisherDomain },
  sourceItemId: item.guid,
  canonicalUrl: item.url,
  title: item.title,
  snippet: item.snippet,
  publisherPublishedAt: item.publishedAt,
  providerObservedAt: null,
  retrievedAt,
  adapterVersion: "google-news-rss/2",
});
if (stored.inserted) pipeline.enqueue(stored.observationId);
```

The Jev worker reads exactly one observation, uses the existing `RUBRIC`,
applies the current deterministic post-rules, and records a judgment against
that observation. It does not call a second model for aggregation.

The current dashboard keeps its mention/tape API through a read-only
compatibility projection over observations and judgments. It shows publisher
time when known; otherwise it shows provider observation time or local
collection time with the correct label.

## Shape

### Domain records

```ts
type CollectorId =
  | "google_news_rss" | "yahoo_finance_rss" | "gdelt_doc_api"
  | "sec_edgar" | "finnhub" | "reddit" | "x" | "yahoo_chart";
type EvidenceChannel = "news" | "filing" | "social" | "market_context";
type ObservationTime = number | null;
type TimeBasis = "publisher_declared" | "provider_observed" | "unknown" | "legacy_unknown";

interface ObservationInput {
  companyId: string;
  collector: CollectorId;
  channel: EvidenceChannel;
  publisher: { name: string; domain: string | null };
  sourceItemId: string | null;
  canonicalUrl: string;
  title: string;
  snippet: string;
  publisherPublishedAt: ObservationTime;
  providerObservedAt: ObservationTime;
  filedAt: ObservationTime;
  retrievedAt: number;
  scoped: boolean;
  responseDigest: string | null;
  adapterVersion: string;
}

interface Observation extends ObservationInput {
  id: string;
  identityKey: string;
  timeBasis: TimeBasis;
  ingestedAt: number;
}

interface JevJudgment {
  id: string;
  observationId: string;
  status: "pending" | "scored" | "off_target" | "failed" | "corrupt";
  rubricSha: string | null;
  score: MentionScore | null;
  error: string | null;
}

interface SourceDelivery {
  id: string;
  collector: CollectorId;
  companyId: string | null;
  requestKeyHash: string;
  startedAt: number;
  completedAt: number;
  result: "success" | "empty" | "partial" | "failed" | "rate_limited" | "invalid";
  parsedItemCount: number;
  responseDigest: string | null;
  adapterVersion: string;
  error: string | null;
}
```

Publisher is distinct from collector. A Google News or GDELT delivery of a
Reuters article remains one publisher report, not two independent publishers.
Separate articles stay separate observations even when their headlines are
similar. A repeated stable source item with the same content digest is an
idempotent replay. A changed digest for the same provider item is retained as a
new immutable revision and links to the same identity key.

Four clocks stay separate: publisher-declared publication/filing time,
provider observation time, local retrieval time, and local ingestion time.
GDELT `seendate` is provider observation time, not publisher time. Missing
source time remains `null`; the UI can use retrieval time to order live work
only when it labels that time as collection time. Unknown or legacy-unverified
times do not enter publication-time sentiment windows or forward-return math.

### Persistence boundary

`source_observations` is append-only source evidence. `jev_judgments` stores
the validated Jev output and lifecycle separately. `source_deliveries` records
provider request outcomes even when the response contains no items or fails.
The SQL `mentions` view combines the latest judgment with its source
observation for current read-only API consumers. No public API accepts a score.

SQLite migration runs inside one transaction:

1. Preserve the existing `mentions` table as `mentions_legacy_v1` for rollback
   and verification.
2. Insert one observation and one judgment for every legacy row, preserving
   status, score, rubric hash, cost, latency, `filed_at`, and `scoped`.
3. Mark legacy non-SEC publication times `legacy_unknown`; retain their old
   timestamp only as an explicitly unverified legacy value. SEC acceptance
   times remain source-declared because the current adapter stores EDGAR's
   `acceptanceAt`.
4. Create the read-only `mentions` compatibility view and indexes. A schema
   version makes a rerun a no-op.

The migration does not score any item. Startup queues only a persisted Jev
judgment whose status is already `pending`. A completed judgment with an older
rubric hash remains unchanged and visible as older-version evidence. An
incomplete row that claims `scored` is surfaced as `corrupt`, with no
manufactured neutral score or default probabilities.

### Modules and signatures

```ts
class Desk {
  insertObservation(input: ObservationInput): { inserted: boolean; observationId: string };
  observation(id: string): Observation | undefined;
  pendingObservationIds(limit: number): string[];
  recordJudgment(judgment: JevJudgment): void;
  recordDelivery(delivery: SourceDelivery): void;
  deliveryHealth(now: number): CollectorHealth[];
  mentionsForCompany(companyId: string, window: EvidenceWindow, limit: number): MentionDTO[];
}

class Pipeline {
  ingest(input: ObservationInput): boolean; // inserts observation and queues Jev
  drainPending(limit: number): number;
  private scoreOne(observationId: string): Promise<void>;
}
```

`server/db.ts` owns SQLite rows, transactions, migrations, and compatibility
projections. `server/pipeline.ts` owns the bounded queue and the only Jev call.
Source adapters own HTTP parsing and collector identity. `server/health.ts` and
`server/app.ts` expose persisted delivery state and Jev usage. Existing React
components keep their product language and display source time, collection
time, and delivery freshness without adding Radar navigation.

No raw response body is retained by default. Where the source policy permits a
response digest, it is stored with the delivery. Otherwise the normalized
observation and URL are the local evidence record. This supports Jev replay
from normalized items, not parser replay from raw network bytes; the ETL record
must state that limit.

## Alternatives and synthesis

Two structurally different candidates were reviewed:

- **Immutable observation and judgment tables.** Chosen. It preserves source
  evidence independently of Jev lifecycle and supports future revisions and
  additional evidence types without rewriting the live score path.
- **Extend `mentions` in place plus a delivery-attempt table.** Rejected for
  this rebuild. It is a smaller migration, but couples immutable source facts
  to mutable model status and makes the later Radar source/revision model a
  second migration.

Two independent design runners converged on the ledger. The first cross-judge
reported that convergence semantics and source independence still needed work.
After the user's phase-order correction, the second review compared the
mention-row alternative and scored the ledger 20/25 versus 18/25 for Phase 1.
The review also required separating collector from publisher, preserving
unknown legacy timestamps, removing destructive title dedupe, preventing
automatic rubric re-scoring, making migration atomic, persisting delivery
outcomes, and rejecting incomplete stored scores. Those are design
requirements, not deferred review notes.

This phase deliberately does not infer that two stories cover the same event,
count news aggregators as independent publishers, synthesize opportunity
hypotheses, calculate retail order flow, or make value-chain claims. Those
belong to Phase 2 after this operational path passes.

## Verification contract

Before Phase 2 begins, prove all of the following against the running product:

- A network source produces a persisted observation with provider, publisher,
  timestamps, adapter, identity, and delivery outcome.
- Replaying an exact item inserts once, while two publishers with similar
  titles remain separate.
- Missing time remains unknown through API, UI, and restart; GDELT seen time
  is labeled as provider observation time.
- A Jev pending item becomes scored through the existing client and rubric;
  a missing key stays pending; malformed or partial output never becomes a
  score.
- The v1 database migrates once, preserves every status and score field, and
  never issues a model request during migration or boot because a rubric hash
  changed.
- A successful empty response, provider failure, malformed response, and
  restart are distinguishable in persistent source health.
- `npm test`, typecheck, web/server build, local browser workflow, and isolated
  Docker persistent-volume verification pass.
