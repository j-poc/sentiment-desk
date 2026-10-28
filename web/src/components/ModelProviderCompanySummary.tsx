import { useEffect, useMemo, useState } from "react";

type ProviderId = "openai" | "google_gemini" | "typesafe_jev";
type Item = {
  attemptId: string; observationId: string; provider: ProviderId; modelRequested: string; modelReturned: string;
  sourceTimeAt: number | null; retrievedAt: number; sentiment: "negative" | "neutral" | "positive" | null;
  summary: string | null; supportingExcerpt: string | null; disposition: "classified" | "excluded" | "review_required";
  createdAt: number; title: string; publisherName: string; sourceUrl: string;
  takeaway?: string; eventType?: string; confidence?: number; impact?: number;
  pPositive?: number; pNeutral?: number; pNegative?: number;
};
type Feed = { companyId: string; provider: ProviderId; hours: number; fromMs: number; throughMs: number; items: Item[] };

export function bucketClassifiedAssessmentsBySourceDay(items: readonly Pick<Item, "sourceTimeAt" | "disposition" | "sentiment">[], days: readonly number[]) {
  return days.map(day => {
    const next = day + 24 * 60 * 60_000;
    const rows = items.filter(item => item.sourceTimeAt != null && item.sourceTimeAt >= day && item.sourceTimeAt < next
      && item.disposition === "classified" && item.sentiment != null);
    return {
      day,
      positive: rows.filter(item => item.sentiment === "positive").length,
      neutral: rows.filter(item => item.sentiment === "neutral").length,
      negative: rows.filter(item => item.sentiment === "negative").length,
    };
  });
}

const PROVIDERS: Record<ProviderId, { label: string; model: string }> = {
  openai: { label: "OpenAI", model: "gpt-6-luna" },
  google_gemini: { label: "Google Gemini", model: "gemini-3.8-flash" },
  typesafe_jev: { label: "TypeSafe Jev", model: "jev-latest" },
};
const COLORS: Record<string, string> = { positive: "#5ee5b2", neutral: "#a7b0c1", negative: "#ef8589" };

function dateLabel(at: number): string {
  return new Date(at).toLocaleDateString([], { month: "short", day: "numeric", timeZone: "UTC" });
}

function dateTime(at: number): string {
  return new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

export function utcDayBucketsForWindow(fromMs: number, throughMs: number): number[] {
  const first = new Date(fromMs);
  first.setUTCHours(0, 0, 0, 0);
  const last = new Date(throughMs);
  last.setUTCHours(0, 0, 0, 0);
  const days: number[] = [];
  for (let day = first.valueOf(); day <= last.valueOf(); day += 24 * 60 * 60_000) days.push(day);
  return days;
}

async function loadFeed(companyId: string, provider: ProviderId, signal: AbortSignal): Promise<Feed> {
  const response = await fetch(`/api/companies/${encodeURIComponent(companyId)}/model-classifications?provider=${provider}&hours=168`, { cache: "no-store", signal });
  const body = await response.json().catch(() => null) as Feed | null;
  if (!response.ok || !body || !Array.isArray(body.items)) throw new Error("classification_feed_unavailable");
  return body;
}

export function ModelProviderCompanySummary({
  companyId,
  companyName,
  onManageKeys,
  refreshRevision = 0,
}: {
  companyId: string;
  companyName: string;
  onManageKeys: () => void;
  refreshRevision?: number;
}) {
  const [provider, setProvider] = useState<ProviderId>("google_gemini");
  const [feed, setFeed] = useState<Feed | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);
    void loadFeed(companyId, provider, controller.signal).then(setFeed, error => {
      if (!controller.signal.aborted) { setFeed(null); setFailed(true); }
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [companyId, provider, refreshRevision]);

  const days = useMemo(() => feed ? utcDayBucketsForWindow(feed.fromMs, feed.throughMs) : [], [feed]);
  const counts = useMemo(() => {
    const valid = (feed?.items ?? []).filter(item => item.disposition === "classified" && item.sentiment != null);
    return {
      total: valid.length,
      positive: valid.filter(item => item.sentiment === "positive").length,
      neutral: valid.filter(item => item.sentiment === "neutral").length,
      negative: valid.filter(item => item.sentiment === "negative").length,
      review: (feed?.items ?? []).filter(item => item.disposition === "review_required").length,
      excluded: (feed?.items ?? []).filter(item => item.disposition === "excluded").length,
    };
  }, [feed]);
  const buckets = useMemo(() => bucketClassifiedAssessmentsBySourceDay(feed?.items ?? [], days), [days, feed]);
  const maxBucket = Math.max(1, ...buckets.map(bucket => bucket.positive + bucket.neutral + bucket.negative));
  const recent = (feed?.items ?? []).slice(0, 5);
  const untimedClassifiedCount = (feed?.items ?? []).filter(item => item.disposition === "classified" && item.sentiment != null && item.sourceTimeAt == null).length;

  return (
    <section className="panel mt-3 p-3" aria-labelledby="model-provider-company-summary-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="model-provider-company-summary-heading" className="micro m-0">OPTIONAL SOURCE ASSESSMENTS · API-KEY PROVIDERS</h2>
          <p className="mt-1 text-[10px] text-white/45">Separate from the main provider-specific sentiment chart and Historical Jev. Saved source assessments for {companyName} · last 7 days · selected provider only</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor={`provider-summary-${companyId}`}>Assessment provider</label>
          <select id={`provider-summary-${companyId}`} value={provider} onChange={event => setProvider(event.currentTarget.value as ProviderId)} className="rounded border border-white/15 bg-[#111318] px-2 py-1.5 text-[10px] text-white/80">
            <option value="google_gemini">Google Gemini</option>
            <option value="openai">OpenAI</option>
            <option value="typesafe_jev">TypeSafe Jev</option>
          </select>
          <button type="button" onClick={onManageKeys} className="rounded border border-white/10 px-2.5 py-1.5 text-[10px] text-white/65 hover:bg-white/[0.05]">Manage optional API-key providers</button>
        </div>
      </div>

      {loading ? <p role="status" className="mt-4 text-[11px] text-white/45">Loading saved source assessments…</p>
        : failed ? <p role="alert" className="mt-4 text-[11px] text-amber-100/75">Saved model assessments are unavailable right now.</p>
          : counts.total === 0 && counts.review === 0 && counts.excluded === 0 ? (
            <div className="mt-3 rounded-lg border border-white/[0.08] bg-white/[0.02] p-3">
              <p className="m-0 text-[11px] font-medium text-white/75">No {PROVIDERS[provider].label} source assessments in this window.</p>
              <p className="mt-1 text-[10px] leading-relaxed text-white/45">This is an empty result, not a neutral company signal. Open a saved public source, review exactly what will be sent, and authorize one request to create the first point.</p>
              <button type="button" onClick={onManageKeys} className="mt-2 rounded border border-emerald-200/20 px-2.5 py-1.5 text-[10px] text-emerald-100/80">Configure optional API-key provider</button>
            </div>
          ) : (
            <>
              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
                {(["positive", "neutral", "negative"] as const).map(key => <div key={key} className="rounded-md border border-white/[0.07] bg-white/[0.02] px-2.5 py-2">
                  <div className="text-[9px] uppercase tracking-wider text-white/40">{key}</div>
                  <div className="mt-1 text-lg font-semibold tabnum" style={{ color: COLORS[key] }}>{counts[key]}</div>
                </div>)}
                <div className="rounded-md border border-white/[0.07] bg-white/[0.02] px-2.5 py-2"><div className="text-[9px] uppercase tracking-wider text-white/40">needs review</div><div className="mt-1 text-lg font-semibold tabnum text-amber-100/80">{counts.review}</div></div>
                <div className="rounded-md border border-white/[0.07] bg-white/[0.02] px-2.5 py-2"><div className="text-[9px] uppercase tracking-wider text-white/40">excluded</div><div className="mt-1 text-lg font-semibold tabnum text-white/55">{counts.excluded}</div></div>
              </div>
              <figure className="mt-3 rounded-md border border-white/[0.07] bg-black/15 p-2.5" aria-label={`${PROVIDERS[provider].label} source assessment counts by UTC day`}>
                <figcaption className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[9px] text-white/40">
                  <span>{PROVIDERS[provider].label} · {PROVIDERS[provider].model} · past 7 days by UTC date</span>
                  <span>source-level classifications, not a company outlook</span>
                </figcaption>
                {untimedClassifiedCount > 0 && <p className="mb-2 text-[9px] text-amber-100/60">{untimedClassifiedCount} classified {untimedClassifiedCount === 1 ? "item has" : "items have"} no source time; {untimedClassifiedCount === 1 ? "it is" : "they are"} included in the counts above and omitted from dated bars.</p>}
                <div className="grid grid-cols-8 items-end gap-2" style={{ height: 104 }}>
                  {buckets.map(bucket => {
                    const positiveHeight = bucket.positive / maxBucket * 78;
                    const neutralHeight = bucket.neutral / maxBucket * 78;
                    const negativeHeight = bucket.negative / maxBucket * 78;
                    const total = bucket.positive + bucket.neutral + bucket.negative;
                    return <div key={bucket.day} className="flex h-full min-w-0 flex-col items-center justify-end gap-1">
                      <span className="text-[8px] tabnum text-white/40">{total || ""}</span>
                      <div className="flex w-full max-w-10 flex-col justify-end overflow-hidden rounded-t-sm" style={{ height: 78 }}>
                        {bucket.positive > 0 && <div title={`${bucket.positive} positive`} style={{ height: positiveHeight, background: COLORS.positive }} />}
                        {bucket.neutral > 0 && <div title={`${bucket.neutral} neutral`} style={{ height: neutralHeight, background: COLORS.neutral }} />}
                        {bucket.negative > 0 && <div title={`${bucket.negative} negative`} style={{ height: negativeHeight, background: COLORS.negative }} />}
                      </div>
                      <span className="text-[8px] text-white/35">{dateLabel(bucket.day)}</span>
                    </div>;
                  })}
                </div>
                <div className="mt-2 flex flex-wrap gap-3 text-[9px] text-white/40">
                  {(["positive", "neutral", "negative"] as const).map(key => <span key={key} className="flex items-center gap-1"><i className="inline-block h-2 w-2 rounded-sm" style={{ background: COLORS[key] }} />{key}</span>)}
                </div>
              </figure>
              <div className="mt-3 space-y-2">
                {recent.map(item => <article key={item.observationId} className="rounded-md border border-white/[0.07] bg-white/[0.018] p-2.5">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <strong className={`text-[10px] ${item.disposition === "classified" && item.sentiment === "positive" ? "text-emerald-200" : item.disposition === "classified" && item.sentiment === "negative" ? "text-rose-200" : "text-white/65"}`}>
                      {item.disposition === "classified" ? item.sentiment ?? "no label" : item.disposition === "review_required" ? "needs review" : "excluded"}
                    </strong>
                    <span className="text-[9px] text-white/35">source {item.sourceTimeAt == null ? "time unknown" : dateTime(item.sourceTimeAt)} · retrieved {dateTime(item.retrievedAt)}</span>
                  </div>
                  <a href={item.sourceUrl} target="_blank" rel="noreferrer" className="mt-1 block text-[10px] font-medium leading-relaxed text-white/75 underline decoration-white/20 underline-offset-2">{item.title || "Saved source"}</a>
                  <div className="mt-1 text-[9px] text-white/35">{item.publisherName} · {PROVIDERS[provider].label} {item.modelReturned}</div>
                  {item.summary && <p className="mt-1.5 text-[10px] leading-relaxed text-white/60">{item.summary}</p>}
                  {provider === "typesafe_jev" && (item.takeaway || item.eventType) && <p className="mt-1.5 text-[10px] text-white/55">Jev rubric · {item.eventType?.replaceAll("_", " ") ?? "event"}{item.takeaway ? ` · ${item.takeaway.replaceAll("_", " ")}` : ""}{item.confidence == null ? "" : ` · ${Math.round(item.confidence * 100)}% confidence`}</p>}
                  {provider === "typesafe_jev" && item.pPositive != null && item.pNegative != null && <p className="mt-1 text-[9px] text-white/40">bullish {Math.round(item.pPositive * 100)}% · neutral {Math.round((item.pNeutral ?? 0) * 100)}% · bearish {Math.round(item.pNegative * 100)}%</p>}
                </article>)}
              </div>
            </>
          )}
      <p className="mt-2 text-[9px] text-white/35">Counts describe saved model labels. They do not measure source quality, business materiality, future performance, or an investment recommendation.</p>
    </section>
  );
}
