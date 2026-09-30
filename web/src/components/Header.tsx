import type { HealthDTO } from "../lib/api.js";
import { clockTime, fmtCost } from "../lib/format.js";

/**
 * Engine chip states, so the desk never pretends:
 *  - JEV ENABLED: configured scoring requests may be sent for approved records
 *  - JEV PAUSED: the request path is unavailable; check its explicit gates
 */
function engineChip(health: HealthDTO | null) {
  if (!health) return null;
  if (!health.health.externalRequestsEnabled) {
    return (
      <span className="rounded-md border border-amber-300/25 bg-amber-300/[0.07] px-2 py-0.5 text-[9.5px] font-semibold tracking-[0.12em] text-amber-200/90" title="All provider and model requests are paused; the desk is serving saved local data.">
        SAVED DATA ONLY
      </span>
    );
  }
  if (health.health.jev.enabled) {
    return (
      <span className="flex items-center gap-1.5 rounded-md border border-emerald-400/25 bg-emerald-400/[0.07] px-2 py-0.5 text-[9.5px] font-semibold tracking-[0.14em] text-emerald-300">
        <span className="live-dot h-1.5 w-1.5 rounded-full bg-emerald-400" />
        JEV ENABLED
      </span>
    );
  }
  return (
    <span
      className="rounded-md border border-amber-300/25 bg-amber-300/[0.07] px-2 py-0.5 text-[9.5px] font-semibold tracking-[0.12em] text-amber-200/90"
      title="Jev dispatch is unavailable. Check credentials, account-use approval, approved source overlap, and configured daily request/byte limits."
    >
      JEV PAUSED
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
            title="Input-cost estimate for judgments with identified source provenance; excludes unknown-source history and failed or retried requests. Not an invoice."
          >
            est. input {fmtCost(usage.estimatedInputCostUsd)} · {usage.judgedItems} source-identified judgments today
          </span>
        )}
        <span className="tabnum hidden sm:inline">
          {totalMentions} source records/24h
        </span>
        <span
          className="flex items-center gap-1.5 font-medium tracking-wider"
          title="The local desk app is connected; source collection status is shown separately."
        >
          <span className={`h-1.5 w-1.5 rounded-full ${connected ? "live-dot bg-emerald-400" : "bg-red-400"}`} />
          {connected ? "APP CONNECTED" : "APP DISCONNECTED"}
        </span>
        <span className="tabnum w-16 text-right">{clockTime(clock)}</span>
      </div>
    </header>
  );
}
