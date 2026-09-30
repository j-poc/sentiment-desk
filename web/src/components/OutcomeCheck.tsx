import { useEffect, useRef, useState } from "react";
import { getJSON, type ReactionsDTO, type ReactionSummary } from "../lib/api.js";
import { shortTime, timeAgo } from "../lib/format.js";

export function OutcomeCheckLoadState({ ticker, failed, onRetry }: {
  ticker: string;
  failed: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="panel mt-4">
      <div className="panel-head">
        <span className="micro">Post-score reaction · {ticker}</span>
        <span className="text-[9px] text-white/30">exploratory · not a prediction or causal estimate</span>
      </div>
      <div className="px-3 py-3 text-[10.5px] text-white/35" role={failed ? "alert" : "status"}>
        {failed ? (
          <>Outcome data could not be loaded. <button type="button" onClick={onRetry} aria-label="Retry loading outcome data">Retry</button></>
        ) : "Loading outcome data…"}
      </div>
    </div>
  );
}

export function OutcomeCheckRefreshNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <span className="ml-2 normal-case tracking-normal text-amber-300/80" role="alert">
      refresh failed · showing prior data{" "}
      <button type="button" className="underline underline-offset-2" aria-label="Retry refreshing outcome data" onClick={onRetry}>
        Retry
      </button>
    </span>
  );
}

const TYPE_LABEL: Record<string, string> = {
  results: "RESULTS",
  corporate_action: "CORP ACT",
  legal_regulatory: "LEGAL",
  leadership: "LEADERSHIP",
  product: "PRODUCT",
  analyst_action: "ANALYST",
  macro_sector: "MACRO",
  other: "NEWS",
};

function SummaryRow({ label, s, color }: { label: string; s: ReactionSummary; color: string }) {
  const fmt = (v: number | null) => (v == null ? "--" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);
  return (
    <div className="grid grid-cols-[3.5rem_minmax(0,1fr)_minmax(0,1fr)_4rem] items-center gap-2 border-b border-white/[0.04] px-3 py-1.5 text-[10.5px]">
      <span className="w-14 font-semibold tracking-wider" style={{ color }}>
        {label}
      </span>
      <span className="tabnum truncate text-white/70">30m {fmt(s.median30m)} · n={s.n30m}</span>
      <span className="tabnum truncate text-white/70">4h {fmt(s.median4h)} · n={s.n4h}</span>
      <span className="tabnum text-right text-white/50">
        {s.hitRate == null ? "" : `match ${s.hitRate}%`}
      </span>
    </div>
  );
}

/** Exploratory price reactions after the completed Jev score became available. */
export function OutcomeCheck({
  companyId,
  ticker,
  hours,
  refreshToken,
  onRetry,
}: {
  companyId: string;
  ticker: string;
  hours: number;
  refreshToken: number;
  onRetry: () => void;
}) {
  const [dataByKey, setDataByKey] = useState<Record<string, ReactionsDTO>>({});
  const [errorByKey, setErrorByKey] = useState<Record<string, boolean>>({});
  const [pollRevision, setPollRevision] = useState(0);
  const lastFetch = useRef(new Map<string, number>());
  const pending = useRef(new Map<string, Promise<ReactionsDTO>>());
  const requestKey = `${companyId}:${hours}`;
  const data = dataByKey[requestKey] ?? null;
  const failed = errorByKey[requestKey] === true;

  useEffect(() => {
    const key = `${companyId}:${hours}`;
    if (pending.current.has(key)) return;
    const now = Date.now();
    if (dataByKey[key] && now - (lastFetch.current.get(key) ?? 0) < 8_000) return;
    const request = getJSON<ReactionsDTO>(`/api/companies/${companyId}/reactions?hours=${hours}`);
    lastFetch.current.set(key, now);
    pending.current.set(key, request);
    setErrorByKey((prev) => ({ ...prev, [key]: false }));
    void request.then((result) => {
      setDataByKey((prev) => ({ ...prev, [key]: result }));
    }).catch(() => {
      lastFetch.current.delete(key);
      setErrorByKey((prev) => ({ ...prev, [key]: true }));
    }).finally(() => {
      if (pending.current.get(key) === request) pending.current.delete(key);
    });
  }, [companyId, hours, refreshToken, pollRevision, dataByKey]);

  useEffect(() => {
    const timer = window.setInterval(() => setPollRevision((revision) => revision + 1), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  if (!data) {
    return <OutcomeCheckLoadState ticker={ticker} failed={failed} onRetry={onRetry} />;
  }
  const top = [...data.events]
    .filter((e) => e.r30 != null || e.r240 != null)
    .sort((a, b) => b.eventScore - a.eventScore)
    .slice(0, 8);

  return (
    <div className="panel mt-4">
      <div className="panel-head">
        <span className="micro">
          Post-score reaction · {data.ticker}
          {failed && <OutcomeCheckRefreshNotice onRetry={onRetry} />}
        </span>
        <span className="text-[9px] text-white/30">exploratory · not a prediction or causal estimate</span>
      </div>
      <div className="pt-1">
        <SummaryRow label="ALL" s={data.all} color="#e8ebf2" />
        <SummaryRow label="BEAR" s={data.bear} color="#f87171" />
        <SummaryRow label="BULL" s={data.bull} color="#34d399" />
      </div>
      <div className="px-3 py-1 text-[9px] text-white/30">
        Baseline: sourced price captured near score availability. 30m/4h windows start after Jev finished; late historical backfills are excluded. This does not establish predictive value.
        {data.measuredEventCount > top.length && ` Showing top ${top.length} of ${data.measuredEventCount} measured items by score.`}
      </div>
      {top.length > 0 && (
        <div className="mt-1 border-t border-white/[0.05]">
          {top.map((e) => {
            const dir = e.sentiment === "negative" ? "#f87171" : e.sentiment === "positive" ? "#34d399" : "#94a3b8";
            const rColor = (r: number | null) =>
              r == null ? "text-white/25" : r > 0 ? "text-emerald-400" : r < 0 ? "text-red-400" : "text-white/50";
            return (
              <div key={e.id} className="flex items-baseline gap-2 px-3 py-1.5 text-[10.5px]">
                <span className="tabnum w-9 shrink-0 text-white/35" title={`${e.publishedAt == null ? "Publication time unknown" : `Published ${new Date(e.publishedAt).toISOString()}`}; Jev score available ${new Date(e.availableAt).toISOString()}`}>
                  {shortTime(e.availableAt)}
                </span>
                <span className="w-16 shrink-0 text-[9px] font-semibold tracking-wider text-white/45">
                  {TYPE_LABEL[e.eventType] ?? "NEWS"}
                </span>
                <span className="shrink-0 text-[9px]" style={{ color: dir }}>
                  {e.sentiment === "negative" ? "▼" : e.sentiment === "positive" ? "▲" : "·"}
                </span>
                <span className="clamp-1 min-w-0 flex-1 text-white/70">{e.title}</span>
                <span className={`tabnum w-14 shrink-0 text-right ${rColor(e.r30)}`}>
                  30m {e.r30 == null ? "--" : `${e.r30 > 0 ? "+" : ""}${e.r30.toFixed(2)}%`}
                </span>
                <span className={`tabnum w-14 shrink-0 text-right ${rColor(e.r240)}`}>
                  4h {e.r240 == null ? "--" : `${e.r240 > 0 ? "+" : ""}${e.r240.toFixed(2)}%`}
                </span>
              </div>
            );
          })}
        </div>
      )}
      {top.length === 0 && (
        <div className="px-3 py-3 text-[10.5px] text-white/30">
          No point-in-time post-score reactions yet. The desk needs price points captured near the score and follow-up windows; historical backfills are not counted. Oldest score: {timeAgo(data.events[data.events.length - 1]?.availableAt)}.
        </div>
      )}
    </div>
  );
}
