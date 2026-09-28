import type { HealthDTO } from "../lib/api.js";
import { clockTime, fmtCost } from "../lib/format.js";

/**
 * Engine chip states, so the desk never pretends:
 *  - JEV LIVE: real scoring active
 *  - ADD API KEY: real ingestion, no scoring until TYPESAFE_API_KEY lands in .env
 */
function engineChip(health: HealthDTO | null) {
  if (!health) return null;
  if (health.health.jev.enabled) {
    return (
      <span className="flex items-center gap-1.5 rounded-md border border-emerald-400/25 bg-emerald-400/[0.07] px-2 py-0.5 text-[9.5px] font-semibold tracking-[0.14em] text-emerald-300">
        <span className="live-dot h-1.5 w-1.5 rounded-full bg-emerald-400" />
        JEV LIVE
      </span>
    );
  }
  return (
    <span
      className="live-dot rounded-md border border-red-400/30 bg-red-400/[0.08] px-2 py-0.5 text-[9.5px] font-semibold tracking-[0.14em] text-red-300"
      title="Add TYPESAFE_API_KEY to .env, then restart"
    >
      ADD API KEY
    </span>
  );
}

export function Header({
  connected,
  health,
  totalMentions,
  clock,
}: {
  connected: boolean;
  health: HealthDTO | null;
  totalMentions: number;
  clock: number;
}) {
  const usage = health?.usage;
  return (
    <header className="flex h-[46px] shrink-0 items-center gap-4 border-b border-desk-line bg-black/50 px-4 backdrop-blur">
      <div className="flex items-center gap-2.5">
        <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
          <rect width="32" height="32" rx="8" fill="rgba(255,255,255,0.06)" />
          <path d="M8 22a8 8 0 0 1 16 0" stroke="#34d399" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          <line x1="16" y1="22" x2="21" y2="13" stroke="#e8ebf2" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
        <div className="text-[12px] font-semibold tracking-[0.24em]">SENTIMENT DESK</div>
      </div>

      {engineChip(health)}

      <div className="ml-auto flex items-center gap-5 text-[11px] text-white/45">
        {usage && (
          <span
            className="tabnum hidden md:inline"
            title="Estimate from saved provider judgments; excludes failed or retried requests and is not an invoice."
          >
            est. input {fmtCost(usage.estimatedInputCostUsd)} · {usage.judgedItems} judged today
          </span>
        )}
        <span className="tabnum hidden sm:inline">
          {totalMentions} mentions/24h
        </span>
        <span className="flex items-center gap-1.5 font-medium tracking-wider">
          <span className={`h-1.5 w-1.5 rounded-full ${connected ? "live-dot bg-emerald-400" : "bg-red-400"}`} />
          {connected ? "CONNECTED" : "OFFLINE"}
        </span>
        <span className="tabnum w-16 text-right">{clockTime(clock)}</span>
      </div>
    </header>
  );
}
