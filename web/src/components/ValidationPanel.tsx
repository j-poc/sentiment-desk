import { useEffect, useState } from "react";
import { getJSON, type ValidationBucket } from "../lib/api.js";

/**
 * Signal validation: the "show me it works" table. Judged events bucketed by
 * event strength, measured against realized 30-minute price reactions. The
 * claim under test is monotonicity: stronger event scores should come with
 * larger absolute reactions and higher hit rates. Small n stays visible.
 */
export function ValidationPanel() {
  const [data, setData] = useState<{
    totalEvents: number;
    withReaction: number;
    rankIC: number | null;
    buckets: ValidationBucket[];
  } | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const d = await getJSON<{
          totalEvents: number;
          withReaction: number;
          rankIC: number | null;
          buckets: ValidationBucket[];
        }>("/api/validation?hours=120");
        if (alive) setData(d);
      } catch {
        /* keep last */
      }
    };
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!data) return null;

  return (
    <div className="panel mt-4">
      <div className="panel-head">
        <span className="micro">Signal validation · watchlist-wide</span>
        <span className="text-[9px] text-white/30">
          {data.withReaction}/{data.totalEvents} events with measured reaction
        </span>
      </div>
      {data.rankIC != null && (
        <div className="flex items-baseline gap-2 border-b border-white/[0.05] px-3 py-2">
          <span className="tabnum text-[15px] font-semibold" style={{ color: data.rankIC > 0.15 ? "#34d399" : data.rankIC < -0.15 ? "#f87171" : "rgba(232,235,242,0.6)" }}>
            {data.rankIC > 0 ? "+" : ""}{data.rankIC.toFixed(3)}
          </span>
          <span className="text-[10px] text-white/40">
            rank IC · event strength vs |30m move| · positive = stronger events move more
          </span>
        </div>
      )}
      <div className="px-3 py-2">
        <table className="w-full text-[10.5px]">
          <thead>
            <tr className="text-left text-white/30">
              <th className="pb-1 font-medium">event strength</th>
              <th className="pb-1 text-right font-medium">n</th>
              <th className="pb-1 text-right font-medium">med |30m|</th>
              <th className="pb-1 text-right font-medium">med 30m</th>
              <th className="pb-1 text-right font-medium">hit rate</th>
            </tr>
          </thead>
          <tbody className="tabnum">
            {data.buckets.map((b) => {
              const color = b.hitRate == null ? "rgba(232,235,242,0.4)" : b.hitRate >= 55 ? "#34d399" : b.hitRate <= 45 ? "#f87171" : "#fbbf24";
              return (
                <tr key={b.range} className="border-t border-white/[0.04]">
                  <td className="py-1 text-white/70">{b.range}</td>
                  <td className="py-1 text-right text-white/60">{b.n}</td>
                  <td className="py-1 text-right text-white/70">
                    {b.medianAbs30 == null ? "--" : `${b.medianAbs30.toFixed(2)}%`}
                  </td>
                  <td className="py-1 text-right text-white/70">
                    {b.median30 == null ? "--" : `${b.median30 > 0 ? "+" : ""}${b.median30.toFixed(2)}%`}
                  </td>
                  <td className="py-1 text-right font-medium" style={{ color }}>
                    {b.hitRate == null ? "--" : `${b.hitRate}%`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        <div className="mt-1.5 text-[9.5px] text-white/30">
          Under test: stronger event scores should predict larger absolute reactions and higher directional hit rates.
          Sample grows as the desk runs; treat small n as what it is.
        </div>
      </div>
    </div>
  );
}
