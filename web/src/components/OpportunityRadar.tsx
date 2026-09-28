import { useEffect, useRef, useState } from "react";
import { getJSON, type RadarDTO, type RadarEvidencePageDTO, type RadarEventType } from "../lib/api.js";
import { timeAgo } from "../lib/format.js";

const EVENT_LABELS: Record<RadarEventType, string> = {
  results: "Results & guidance",
  corporate_action: "Corporate actions",
  legal_regulatory: "Legal & regulatory",
  leadership: "Leadership",
  product: "Products & operations",
  analyst_action: "Analyst actions",
  macro_sector: "Macro & sector",
  other: "Other company news",
};

const SOURCE_LABELS: Record<string, string> = {
  google_news_rss: "Google News",
  yahoo_finance_rss: "Yahoo Finance news",
  gdelt_doc_api: "GDELT",
  sec_edgar: "SEC EDGAR",
  finnhub: "Finnhub",
  reddit: "Reddit",
  x: "X",
};

const STATE_STYLES: Record<RadarDTO["coverage"][number]["state"], string> = {
  current: "text-emerald-300",
  overdue: "text-amber-300",
  failed: "text-rose-300",
  partial: "text-amber-300",
  never: "text-white/40",
  disabled: "text-white/35",
};

function timestamp(value: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short",
  }).format(value);
}

function changeText(value: number): string {
  return value > 0 ? `+${value}` : String(value);
}

function changeColor(value: number): string {
  return value > 0 ? "text-emerald-300" : value < 0 ? "text-rose-300" : "text-white/45";
}

export function OpportunityRadar({
  companyId,
  ticker,
  hours,
  onHours,
}: {
  companyId: string;
  ticker: string;
  hours: number;
  onHours: (hours: number) => void;
}) {
  const [loaded, setLoaded] = useState<{ key: string; data: RadarDTO } | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [showInactive, setShowInactive] = useState(false);
  const requestKey = `${companyId}:${hours}`;
  const data = loaded?.key === requestKey ? loaded.data : null;

  useEffect(() => {
    let active = true;
    let request = 0;
    const refresh = async () => {
      const currentRequest = ++request;
      try {
        const result = await getJSON<RadarDTO>(`/api/companies/${companyId}/radar?hours=${hours}`);
        if (!active || currentRequest !== request) return;
        setLoaded({ key: requestKey, data: result });
        setRefreshFailed(false);
      } catch {
        if (active && currentRequest === request) setRefreshFailed(true);
      } finally {
        if (active && currentRequest === request) setLoading(false);
      }
    };
    setLoading(data == null);
    setRefreshFailed(false);
    void refresh();
    const timer = setInterval(() => void refresh(), 30_000);
    return () => {
      active = false;
      request += 1;
      clearInterval(timer);
    };
  }, [companyId, hours, requestKey, retryKey]);

  const windows = [
    { value: 6, label: "6H" },
    { value: 24, label: "24H" },
    { value: 72, label: "3D" },
    { value: 168, label: "7D" },
  ];
  const activeCategories = (data?.categories ?? [])
    .filter((category) => category.current.headlineGroups > 0 || category.previous.headlineGroups > 0)
    .sort((a, b) => Math.abs(b.headlineChange) - Math.abs(a.headlineChange) || b.current.headlineGroups - a.current.headlineGroups);
  const inactiveCategories = (data?.categories ?? []).filter(
    (category) => category.current.headlineGroups === 0 && category.previous.headlineGroups === 0,
  );
  const visibleCategories = showInactive ? data?.categories ?? [] : activeCategories;

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-1" aria-labelledby="radar-title">
      <div className="panel shrink-0 px-3 py-3 sm:px-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="micro">JEV · PUBLISHED EVIDENCE</div>
            <h1 id="radar-title" className="mt-1 text-[17px] font-semibold text-white/90">Opportunity Radar <span className="text-white/40">· {ticker}</span></h1>
            <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-white/45">
              Jev classifies each item. Counts compare its event categories across equal publication-time windows; exact headline matches group coverage, not real-world events.
            </p>
          </div>
          <div className="flex shrink-0 gap-1 rounded-md border border-white/[0.08] bg-black/20 p-1" aria-label="Comparison window">
            {windows.map((window) => (
              <button
                key={window.value}
                type="button"
                aria-pressed={hours === window.value}
                onClick={() => onHours(window.value)}
                className={`rounded px-2 py-1 text-[10px] tabnum focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 ${hours === window.value ? "bg-white/[0.12] text-white" : "text-white/45 hover:text-white/75"}`}
              >
                {window.label}
              </button>
            ))}
          </div>
        </div>
        {data && (
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-white/[0.06] pt-2 text-[10px] text-white/40">
            <span>Current: {timestamp(data.currentFrom)} – {timestamp(data.currentTo)}</span>
            <span>Previous: {timestamp(data.previousFrom)} – {timestamp(data.previousTo)}</span>
            <span>Updated {timeAgo(data.generatedAt)}</span>
          </div>
        )}
        {refreshFailed && (
          <div role="status" className="mt-2 rounded border border-amber-300/20 bg-amber-300/[0.06] px-2 py-1 text-[10px] text-amber-200/80">
            Radar refresh failed. {data ? "The last successful comparison is still shown." : "No comparison is available yet."}
            <button type="button" onClick={() => setRetryKey((key) => key + 1)} className="ml-2 underline underline-offset-2 hover:text-amber-100">Retry</button>
          </div>
        )}
      </div>

      {loading && !data ? (
        <div className="panel px-4 py-6 text-[12px] text-white/45">Loading Jev-scored evidence…</div>
      ) : data ? (
        <>
          <div className="grid shrink-0 grid-cols-2 gap-2 xl:grid-cols-4">
            <Metric label="Exact headline groups" current={data.current.headlineGroups} previous={data.previous.headlineGroups} change={data.headlineChange} />
            <Metric label="Distinct publishers" current={data.current.publisherCount} previous={data.previous.publisherCount} />
            <Metric label="Publisher judgments" current={data.current.publisherJudgments} previous={data.previous.publisherJudgments} />
            <div className="panel px-3 py-2.5">
              <div className="micro">Not in comparison</div>
              <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                <span><b className="tabnum text-amber-200">{data.untimedScored}</b> <span className="text-white/45">untimed</span></span>
                <span><b className="tabnum text-white/75">{data.unjudged}</b> <span className="text-white/45">unjudged / failed</span></span>
              </div>
            </div>
          </div>

          <div className="panel shrink-0 p-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div className="micro">Source delivery coverage</div>
              <div className="text-[9.5px] text-white/35">Delivery recency and evidence age are separate.</div>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 sm:grid-cols-3 xl:grid-cols-4">
              {data.coverage.map((source) => (
                <div key={source.collector} className="flex min-w-0 items-center justify-between gap-2 rounded border border-white/[0.05] bg-black/10 px-2 py-1">
                  <span className="truncate text-[10px] text-white/55">{SOURCE_LABELS[source.collector] ?? source.collector}</span>
                  <span
                    className={`shrink-0 text-[9px] uppercase ${STATE_STYLES[source.state]}`}
                    title={[source.latestError, source.latestObservationAt == null ? "Latest source time unknown" : `Latest ${source.latestObservationBasis?.replaceAll("_", " ")} evidence ${timestamp(source.latestObservationAt)}`].filter(Boolean).join(" · ")}
                  >
                    {source.state}{source.latestDeliveryAt == null ? " · no delivery" : ` · ${timeAgo(source.latestDeliveryAt)}`}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {data.current.headlineGroups === 0 && data.previous.headlineGroups === 0 && (
            <div className="panel shrink-0 border border-amber-300/10 px-3 py-2.5 text-[11px] leading-relaxed text-white/55">
            No eligible Jev-scored items with publisher-declared time in these windows. Untimed items and pending or failed judgments are shown separately; this is not evidence that no activity occurred.
            </div>
          )}

          <div className="flex min-h-0 flex-col gap-2">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 px-1">
              <span className="micro">Jev event categories <span className="ml-1 font-normal normal-case text-white/35">ordered by absolute change</span></span>
              <button
                type="button"
                aria-expanded={showInactive}
                onClick={() => setShowInactive((value) => !value)}
                className="text-[9.5px] text-white/45 underline decoration-white/15 underline-offset-2 hover:text-white/75 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300"
              >
                {showInactive ? "Hide inactive categories" : `Show ${inactiveCategories.length} inactive categories`}
              </button>
            </div>
            {activeCategories.length === 0 && !showInactive && (
              <div className="panel shrink-0 px-3 py-2 text-[10.5px] text-white/45">
                No Jev event category has eligible, publisher-timed evidence in these periods. Open inactive categories to inspect their zero counts.
              </div>
            )}
            <div className="grid shrink-0 gap-2 xl:grid-cols-2">
              {visibleCategories.map((category) => (
                <CategoryCard key={`${companyId}:${hours}:${category.eventType}`} companyId={companyId} category={category} hours={hours} asOf={data.generatedAt} />
              ))}
            </div>
          </div>
          <p className="shrink-0 px-1 pb-1 text-[9.5px] leading-relaxed text-white/30">
            This view covers the enabled company-news and filing collectors. It does not measure retail order flow, options, short interest, search trends, app reviews, podcasts, or supplier relationships, and it is not an investment recommendation. Provider display, retention, and model-use terms still require review.
            {data.unclassified > 0 ? ` ${data.unclassified} scored rows with unsupported stored classifications were withheld.` : ""}
          </p>
        </>
      ) : (
        <div role="alert" className="panel px-4 py-5 text-[12px] text-rose-200/80">
          Radar could not load this comparison. Check the server, then <button type="button" onClick={() => setRetryKey((key) => key + 1)} className="underline underline-offset-2">retry</button>.
        </div>
      )}
    </section>
  );
}

function Metric({ label, current, previous, change }: { label: string; current: number; previous: number; change?: number }) {
  return (
    <div className="panel min-w-0 px-3 py-2.5">
      <div className="micro truncate">{label}</div>
      <div className="mt-1 flex items-baseline justify-between gap-2">
        <div className="tabnum text-[16px] font-medium text-white/90">{current}</div>
        <div className="text-right text-[9.5px] text-white/40">
          prev {previous}{change == null ? "" : <span className={`ml-1 font-medium ${changeColor(change)}`}>({changeText(change)})</span>}
        </div>
      </div>
    </div>
  );
}

function CategoryCard({ companyId, category, hours, asOf }: { companyId: string; category: RadarDTO["categories"][number]; hours: number; asOf: number }) {
  const direction = category.current;
  return (
    <section className="panel min-w-0 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-[12px] font-medium text-white/80">{EVENT_LABELS[category.eventType]}</h2>
          <div className="mt-1 text-[9.5px] text-white/40">
            {direction.publisherCount} publishers · {direction.headlineGroups} headline groups · {direction.sourceRows} source rows
          </div>
        </div>
        <div className="text-right">
          <div className="tabnum text-[16px] font-medium text-white/90">{direction.headlineGroups}</div>
          <div className={`tabnum text-[9.5px] ${changeColor(category.headlineChange)}`}>
            {changeText(category.headlineChange)} vs prior {hours}h ({category.previous.headlineGroups})
          </div>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-2.5 gap-y-1 border-t border-white/[0.06] pt-2 text-[9.5px] tabnum">
        <span className="text-emerald-300">+{direction.positive} positive</span>
        <span className="text-white/45">~{direction.neutral} neutral</span>
        <span className="text-rose-300">−{direction.negative} negative</span>
        <span className="text-amber-200" title="Same publisher and exact headline had differing Jev direction judgments across source copies.">{direction.mixed} mixed copies</span>
      </div>
      <details className="mt-2 border-t border-white/[0.06] pt-2">
        <summary className="cursor-pointer select-none text-[10px] text-white/55 hover:text-white/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300">
          Evidence · {direction.headlineGroups} current, {category.previous.headlineGroups} previous headline groups
        </summary>
        <div className="mt-2 space-y-3">
          <EvidenceWindow companyId={companyId} hours={hours} asOf={asOf} eventType={category.eventType} period="current" label="Current period" initial={category.recentEvidence} total={direction.headlineGroups} />
          <EvidenceWindow companyId={companyId} hours={hours} asOf={asOf} eventType={category.eventType} period="previous" label="Previous period" initial={category.previousEvidence} total={category.previous.headlineGroups} />
        </div>
      </details>
    </section>
  );
}

function EvidenceWindow({
  companyId,
  hours,
  asOf,
  eventType,
  period,
  label,
  initial,
  total,
}: {
  companyId: string;
  hours: number;
  asOf: number;
  eventType: RadarEventType;
  period: RadarEvidencePageDTO["period"];
  label: string;
  initial: RadarEvidencePageDTO["items"];
  total: number;
}) {
  const [additional, setAdditional] = useState<RadarEvidencePageDTO["items"]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const requestSnapshot = useRef(asOf);
  const groups = [...initial, ...additional];

  useEffect(() => {
    requestSnapshot.current = asOf;
    setAdditional([]);
    setFailed(false);
  }, [asOf]);

  const loadMore = async () => {
    if (loading || groups.length >= total) return;
    setLoading(true);
    setFailed(false);
    try {
      const result = await getJSON<RadarEvidencePageDTO>(
        `/api/companies/${companyId}/radar/evidence?hours=${hours}&asOf=${asOf}&period=${period}&eventType=${eventType}&offset=${groups.length}&limit=5`,
      );
      if (requestSnapshot.current === asOf && result.generatedAt === asOf) {
        setAdditional((current) => [...current, ...result.items]);
      }
    } catch {
      if (requestSnapshot.current === asOf) setFailed(true);
    } finally {
      if (requestSnapshot.current === asOf) setLoading(false);
    }
  };

  return (
    <div>
      <div className="micro">{label} · {groups.length} of {total} headline groups</div>
      {groups.length === 0 ? (
        <p className="mt-1 text-[10px] text-white/35">No eligible evidence in this period.</p>
      ) : (
        <div className="mt-1.5 space-y-2.5">
          {groups.map((group) => (
            <div key={`${group.latestPublishedAt}:${group.title}`} className="border-l border-white/10 pl-2.5">
              <div className="text-[10.5px] leading-snug text-white/75">{group.title}</div>
              <div className="mt-1 space-y-1">
                {group.sources.map((source) => (
                  <div key={source.id} className="flex flex-wrap items-baseline gap-x-1.5 text-[9px] text-white/40">
                    <a href={source.sourceUrl} target="_blank" rel="noreferrer" className="max-w-full truncate text-sky-200/75 underline decoration-white/15 underline-offset-2 hover:text-sky-100">
                      {source.publisherName || source.publisherDomain || "Open source"} ↗
                    </a>
                    <span>{source.sentiment} · {source.takeaway.replaceAll("_", " ")} · {timestamp(source.publishedAt)}</span>
                    <span title={`Collected ${new Date(source.retrievedAt).toISOString()}`}>(collected {timeAgo(source.retrievedAt)})</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
      {groups.length < total && (
        <div className="mt-1.5">
          {failed && <span role="status" className="mr-2 text-[9px] text-amber-200/75">Could not load more evidence.</span>}
          <button type="button" disabled={loading} onClick={() => void loadMore()} className="text-[9.5px] text-sky-200/70 underline decoration-white/15 underline-offset-2 hover:text-sky-100 disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300">
            {loading ? "Loading…" : failed ? "Retry" : `Show next ${Math.min(5, total - groups.length)} groups`}
          </button>
        </div>
      )}
    </div>
  );
}
