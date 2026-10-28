import { useEffect, useId, useMemo, useState } from "react";
import { z } from "zod";
import { codexLunaSavedSchema } from "../../../shared/codex-luna.js";
import { validatedSourceClock } from "../../../shared/source-clock.js";
import type { Mention } from "../lib/api.js";
import { withReadDeadline } from "../lib/bounded-read.js";
import { displayBucketMsForWindow, displayIntervalLabel, formatUtcInstant, formatUtcRange } from "../lib/categorical-chart.js";

const timestamp = z.number().int().nonnegative().safe().max(8_640_000_000_000_000);
const sentiment = z.enum(["positive", "neutral", "negative"]);
const collector = z.enum(["legacy_unknown", "google_news_rss", "yahoo_finance_rss", "yahoo_quote", "gdelt_doc_api", "sec_edgar", "sec_company_facts", "finnhub", "reddit", "x", "yahoo_chart"]);
const mentionSchema: z.ZodType<Mention> = z.object({
  id: z.string().min(1), companyId: z.string().min(1), title: z.string(), snippet: z.string(),
  source: z.object({ name: z.string(), url: z.string().url(), kind: z.enum(["rss", "x", "sec", "finnhub", "reddit"]),
    tier: z.enum(["wire", "major", "trade", "blog", "social", "filing"]), collector, publisher: z.string(), publisherDomain: z.string().nullable(),
    deliveryId: z.string().nullable().optional().transform(value => value ?? undefined) }),
  publishedAt: timestamp.nullable(), aggregatorPublishedAt: timestamp.nullable().optional(), providerObservedAt: timestamp.nullable(),
  retrievedAt: timestamp, ingestedAt: timestamp, timeBasis: z.enum(["publisher_declared", "aggregator_declared", "provider_observed", "unknown", "legacy_unknown"]),
  collector, publisherName: z.string(), publisherDomain: z.string().nullable(), filedAt: timestamp.nullable().optional(),
  issuerIdentityStrong: z.boolean().optional(), companyBusinessRelevant: z.boolean().optional(),
  status: z.enum(["pending", "scoring", "retrying", "scored", "off_target", "failed", "corrupt", "classified", "excluded", "review_required"]),
  scoreRetryAt: timestamp.nullable(), usageCheckRequired: z.boolean(), error: z.string().nullable(),
  score: z.object({ sentiment, pPos: z.number().finite(), pNeu: z.number().finite(), pNeg: z.number().finite(), confidence: z.number().finite(),
    about: z.number().finite(), material: z.number().finite(), novel: z.number().finite(), credible: z.number().finite(), eventType: z.string(), takeaway: z.string(),
    magnitude: z.number().finite(), surprise: z.number().finite(), eventScore: z.number().finite(), impact: z.number().finite(), weight: z.number().finite(),
    engine: z.string(), inputTokens: timestamp, outputTokens: timestamp, estimatedInputCostUsd: z.number().finite(), latencyMs: z.number().finite(),
    rubricSha: z.string(), scoredAt: timestamp }).nullable(),
});
const seriesSchema = z.object({ companyId: z.string(), hours: z.number().int().min(1).max(168), fromMs: timestamp,
  throughMs: timestamp, items: z.array(z.object({ classification: codexLunaSavedSchema, mention: mentionSchema }).strict()) }).strict();
type Series = z.infer<typeof seriesSchema>;
type Item = Series["items"][number];
const statusSchema = z.object({ configured: z.boolean(), externalRequestsEnabled: z.boolean(), experimental: z.boolean(),
  unknownOutcome: z.boolean() }).passthrough();
type Status = z.infer<typeof statusSchema>;
type ReadState = { key: string; kind: "loading" | "error" } | { key: string; kind: "ready"; series: Series };
const categories = [
  { key: "positive", label: "Positive", color: "categorical-positive" },
  { key: "neutral", label: "Neutral", color: "categorical-neutral" },
  { key: "negative", label: "Negative", color: "categorical-negative" },
  { key: "reviewRequired", label: "Needs review", color: "categorical-review" },
  { key: "excluded", label: "Excluded", color: "categorical-excluded" },
] as const;
type Category = typeof categories[number]["key"];
function category(item: Item): Category {
  const result = item.classification;
  return result.disposition === "excluded" ? "excluded"
    : result.disposition === "review_required" || result.sentiment === null ? "reviewRequired" : result.sentiment;
}
function counts(items: Item[]) {
  return items.reduce((total, item) => { total[category(item)] += 1; return total; },
    { positive: 0, neutral: 0, negative: 0, reviewRequired: 0, excluded: 0 });
}
function parseSeries(value: unknown, companyId: string, hours: number): Series {
  const series = seriesSchema.parse(value);
  if (series.companyId !== companyId || series.hours !== hours || series.throughMs - series.fromMs !== hours * 3_600_000) {
    throw new Error("Saved sentiment window does not match the selected issuer");
  }
  const observations = new Set<string>();
  const attempts = new Set<string>();
  for (const item of series.items) {
    const { classification: result, mention } = item;
    const sourceTime = validatedSourceClock({ timeBasis: mention.timeBasis, collector: mention.collector,
      publisherAt: mention.publishedAt, aggregatorAt: mention.aggregatorPublishedAt ?? null, providerObservedAt: mention.providerObservedAt }).at;
    const selectedTime = result.sourceTimeAt ?? result.createdAt;
    if (result.companyId !== companyId || mention.companyId !== companyId || result.observationId !== mention.id
      || result.sourceTimeAt !== sourceTime || result.retrievedAt !== mention.retrievedAt
      || selectedTime < series.fromMs || selectedTime >= series.throughMs
      || observations.has(mention.id) || attempts.has(result.attemptId)) throw new Error("Saved sentiment does not reconcile with source records");
    observations.add(mention.id); attempts.add(result.attemptId);
  }
  return series;
}
async function readJSON(url: string, signal: AbortSignal): Promise<unknown> {
  return withReadDeadline(async requestSignal => {
    const response = await fetch(url, { method: "GET", signal: requestSignal, cache: "no-store" });
    if (!response.ok) throw new Error("Saved sentiment read failed");
    return response.json();
  }, signal);
}

export function CodexSentimentChart({ companyId, hours, refreshRevision, onOpenMention, onReviewSourceRecords }: {
  companyId: string; hours: number; refreshRevision: number;
  onOpenMention: (mention: Mention) => void; onReviewSourceRecords: () => void;
}) {
  const headingId = useId();
  const [retry, setRetry] = useState(0);
  const key = JSON.stringify([companyId, hours, refreshRevision, retry]);
  const [read, setRead] = useState<ReadState>({ key, kind: "loading" });
  const [status, setStatus] = useState<{ key: string; value: Status } | null>(null);
  const [selection, setSelection] = useState<{ key: string; bucket: number | "untimed" } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let current = true;
    setRead({ key, kind: "loading" });
    void readJSON(`/api/companies/${encodeURIComponent(companyId)}/codex-luna-series?hours=${encodeURIComponent(hours)}`, controller.signal)
      .then(value => parseSeries(value, companyId, hours))
      .then(series => { if (current) setRead({ key, kind: "ready", series }); })
      .catch(() => { if (current) setRead({ key, kind: "error" }); });
    void readJSON("/api/codex-luna/status", controller.signal).then(value => statusSchema.parse(value))
      .then(value => { if (current) setStatus({ key, value }); }).catch(() => {});
    return () => { current = false; controller.abort(); };
  }, [key, companyId, hours]);
  const series = read.key === key && read.kind === "ready" ? read.series : null;
  const interval = displayBucketMsForWindow(hours);
  const buckets = useMemo(() => {
    if (!series) return [];
    const result = [];
    for (let start = Math.floor(series.fromMs / interval) * interval; start < series.throughMs; start += interval) {
      const from = Math.max(start, series.fromMs), through = Math.min(start + interval, series.throughMs);
      const items = series.items.filter(item => item.classification.sourceTimeAt !== null
        && item.classification.sourceTimeAt >= from && item.classification.sourceTimeAt < through);
      result.push({ from, through, items, counts: counts(items) });
    }
    return result;
  }, [series, interval]);
  const untimed = series?.items.filter(item => item.classification.sourceTimeAt === null) ?? [];
  const totals = series ? counts(series.items) : null;
  const plotted = (series?.items.length ?? 0) - untimed.length;
  const axisMax = Math.max(1, ...buckets.map(bucket => bucket.items.length));
  const chosen = selection?.key === key ? selection.bucket : null;
  const selectedItems = chosen === "untimed" ? untimed : buckets.find(bucket => bucket.from === chosen)?.items;
  const readiness = status?.key === key ? status.value : null;
  const loading = read.key !== key || read.kind === "loading";
  return <section className="categorical-trend-panel" aria-labelledby={headingId} aria-busy={loading}>
    <header className="categorical-trend-header">
      <div className="categorical-trend-title-block">
        <p className="micro">SAVED SOURCE SENTIMENT</p><h2 id={headingId}>Sentiment · Codex</h2>
        <p>Category counts by validated source time · {hours} hours · repeated coverage included</p>
      </div>
      {series && <div className="categorical-trend-total"><strong>{plotted}</strong><span>plotted · {untimed.length} untimed</span></div>}
    </header>
    <details className="categorical-data-table"><summary>Luna requested · returned model not exposed</summary>
      <p>Uses your existing Codex sign-in through its native experimental interface. Each source requires your approval. Reading this chart sends no inference requests. The configured model is GPT-6 Luna; Codex does not expose the returned model for each turn.</p>
    </details>
    {loading ? <p className="categorical-trend-state" role="status">Loading saved Codex sentiment…</p>
      : read.kind === "error" ? <div className="categorical-trend-state categorical-trend-error" role="alert">
        Saved Codex sentiment could not be read or reconciled with its sources. The current window is unknown.
        <button type="button" onClick={() => setRetry(value => value + 1)}>Retry sentiment</button>
      </div> : series && series.items.length === 0 ? <div className="categorical-trend-empty" role="status"><div>
        <strong>No saved Codex classifications in this window</strong>
        <p>This is an empty result, not a neutral sentiment reading. Review a real saved source and approve its Luna analysis to begin.</p>
        {readiness && (!readiness.configured || !readiness.externalRequestsEnabled || readiness.unknownOutcome) && <p className="categorical-blocked-reason">
          {!readiness.configured ? "Existing Codex sign-in is unavailable." : !readiness.externalRequestsEnabled ? "External requests are paused." : "Review uncertain provider usage before another analysis."}
        </p>}
        <div className="categorical-empty-actions"><button type="button" onClick={onReviewSourceRecords}>Review saved source records</button></div>
      </div></div> : series && <>
        <div className="categorical-trend-meta">{categories.map(({ key: categoryKey, label }) => <span key={categoryKey}>{totals?.[categoryKey]} {label.toLowerCase()}</span>)}</div>
        {untimed.length > 0 && <div className="categorical-lineage-warning" role="status">
          {untimed.length} saved {untimed.length === 1 ? "classification has" : "classifications have"} no validated source time and {untimed.length === 1 ? "is" : "are"} not plotted. Retrieval and classification times are not substituted.
          <button className="ml-2 underline" type="button" onClick={() => setSelection({ key, bucket: "untimed" })}>Review untimed sources</button>
        </div>}
        {plotted > 0 && <>
          <div className="categorical-chart-legend" aria-label="Category legend">{categories.map(({ key: categoryKey, label, color }) => <span key={categoryKey}><i className={color} aria-hidden="true" />{label}</span>)}<span className="categorical-interval-label">{displayIntervalLabel(interval)} · UTC</span></div>
          <div className="categorical-plot-layout">
            <div className="categorical-y-axis" aria-hidden="true"><span>{axisMax}</span><span>{Math.floor(axisMax / 2)}</span><span>0</span></div>
            <div className="categorical-plot-column" role="region" aria-label="Codex sentiment by validated source time">
              <div className="categorical-plot-content" style={{ width: `max(100%, ${buckets.length * 24}px)` }}>
                <div className="categorical-bars" style={{ gridTemplateColumns: `repeat(${buckets.length}, minmax(24px, 1fr))` }} role="group" aria-label="Source sentiment buckets">
                  {buckets.map(bucket => {
                    const label = `${formatUtcRange(bucket.from, bucket.through)}. ${categories.map(item => `${item.label.toLowerCase()} ${bucket.counts[item.key]}`).join(", ")}. Total ${bucket.items.length} source observations.`;
                    return <button type="button" key={bucket.from} className={`categorical-bar${bucket.items.length === 0 ? " is-empty" : ""}${chosen === bucket.from ? " is-selected" : ""}`}
                      aria-label={label} title={label} aria-pressed={chosen === bucket.from} onClick={() => setSelection({ key, bucket: bucket.from })}>
                      <span className="categorical-stack" style={{ height: `${bucket.items.length / axisMax * 100}%` }}>{categories.map(item => bucket.counts[item.key] > 0
                        && <i aria-hidden="true" key={item.key} className={`categorical-segment ${item.color}`} style={{ height: `${bucket.counts[item.key] / bucket.items.length * 100}%` }} />)}</span>
                    </button>;
                  })}
                </div>
                <div className="categorical-x-axis" aria-hidden="true"><span>{formatUtcInstant(series.fromMs)}</span><span>{formatUtcInstant(series.throughMs)}</span></div>
              </div>
            </div>
          </div>
        </>}
        {selectedItems && <section className="categorical-bucket-evidence" aria-label="Selected Codex source observations">
          <header><div><h3>{chosen === "untimed" ? "Untimed sources" : "Selected source bucket"}</h3><p>{selectedItems.length} source observations · exact saved chart records</p></div>
            <button type="button" onClick={() => setSelection(null)}>Close source bucket</button></header>
          {selectedItems.length === 0 && <p className="categorical-evidence-status">No saved classifications in this interval.</p>}
          {selectedItems.map(item => <article className="categorical-evidence-status" key={item.mention.id}>
            <strong>{categories.find(entry => entry.key === category(item))?.label} · {item.mention.title}</strong>
            <p>{item.mention.publisherName} · {item.classification.sourceTimeAt === null ? "Source time unknown" : formatUtcInstant(item.classification.sourceTimeAt)}</p>
            {item.classification.summary && <p>{item.classification.summary}</p>}
            {item.classification.supportingExcerpt && <blockquote>{item.classification.supportingExcerpt}</blockquote>}
            <button type="button" onClick={() => onOpenMention(item.mention)}>Open saved source record</button>
          </article>)}
        </section>}
      </>}
  </section>;
}
