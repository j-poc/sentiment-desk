import type { HealthDTO } from "../lib/api.js";
import { clockTime, fmtCost } from "../lib/format.js";

export function Header({
  connected,
  demo,
  health,
  totalMentions,
  clock,
}: {
  connected: boolean;
  demo: boolean;
  health: HealthDTO | null;
  totalMentions: number;
  clock: number;
}) {
  const usage = health?.usage;
  return (
    <header className="flex h-14 shrink-0 items-center gap-4 border-b border-desk-line bg-black/40 px-5 backdrop-blur">
      <div className="flex items-center gap-2.5">
        <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
          <rect width="32" height="32" rx="8" fill="rgba(255,255,255,0.06)" />
          <path d="M8 22a8 8 0 0 1 16 0" stroke="#34d399" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          <line x1="16" y1="22" x2="21" y2="13" stroke="#e8ebf2" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
        <div className="text-[12.5px] font-semibold tracking-[0.22em]">SENTIMENT DESK</div>
      </div>

      {demo && (
        <span className="rounded-md border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 text-[10px] font-semibold tracking-[0.12em] text-amber-300">
          DEMO DATA
        </span>
      )}

      <div className="ml-auto flex items-center gap-5 text-[11px] text-white/45">
        {usage && (
          <span className="tabnum hidden md:inline">
            jev {fmtCost(usage.costUsd)} · {usage.calls} calls today
          </span>
        )}
        <span className="tabnum hidden sm:inline">{totalMentions} mentions/24h</span>
        <span className="flex items-center gap-1.5 font-medium tracking-wider">
          <span
            className={`h-1.5 w-1.5 rounded-full ${connected ? "live-dot bg-emerald-400" : "bg-red-400"}`}
          />
          {connected ? "LIVE" : "OFFLINE"}
        </span>
        <span className="tabnum w-16 text-right">{clockTime(clock)}</span>
      </div>
    </header>
  );
}
