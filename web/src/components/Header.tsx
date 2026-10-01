import type { HealthDTO } from "../lib/api.js";
import { clockTime, fmtCost } from "../lib/format.js";

function engineChip(health: HealthDTO | null) {
  if (!health) return null;
  if (!health.health.externalRequestsEnabled) {
    return (
      <span className="whitespace-nowrap rounded-md border border-amber-300/25 bg-amber-300/[0.07] px-1.5 py-0.5 text-[9.5px] font-semibold tracking-[0.04em] text-amber-200/90 sm:px-2 sm:tracking-[0.12em]" title="All provider and model requests are paused; the desk is serving saved local data.">
        SAVED DATA ONLY
      </span>
    );
  }
  const classifier = health.health.classifier ?? health.health.jev;
  const engine = health.health.classifier?.provider === "openai_luna" ? "LUNA" : "JEV";
  if (classifier.enabled) {
    return (
        <span className="flex whitespace-nowrap items-center gap-1.5 rounded-md border border-emerald-400/25 bg-emerald-400/[0.07] px-1.5 py-0.5 text-[9.5px] font-semibold tracking-[0.08em] text-emerald-300 sm:px-2 sm:tracking-[0.14em]">
        <span className="live-dot h-1.5 w-1.5 rounded-full bg-emerald-400" />
        {engine} ENABLED
      </span>
    );
  }
  return (
    <span
      className="whitespace-nowrap rounded-md border border-amber-300/25 bg-amber-300/[0.07] px-1.5 py-0.5 text-[9.5px] font-semibold tracking-[0.04em] text-amber-200/90 sm:px-2 sm:tracking-[0.12em]"
      title={health.health.classifier?.blockedReason ?? "Classifier dispatch is unavailable. Check credentials, account approval, approved sources and daily budgets."}
    >
      {engine} PAUSED
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
    <header className="flex h-[46px] shrink-0 items-center gap-2 border-b border-desk-line bg-black/50 px-2 backdrop-blur sm:gap-4 sm:px-4">
      <div className="flex min-w-0 items-center gap-1.5 sm:gap-2.5">
        <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
          <rect width="32" height="32" rx="8" fill="rgba(255,255,255,0.06)" />
          <path d="M8 22a8 8 0 0 1 16 0" stroke="#34d399" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          <line x1="16" y1="22" x2="21" y2="13" stroke="#e8ebf2" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
        <div className="whitespace-nowrap text-[10px] font-semibold tracking-[0.1em] sm:text-[12px] sm:tracking-[0.24em]">SENTIMENT DESK</div>
      </div>

      {engineChip(health)}

      <div className="ml-auto flex items-center gap-2 text-[9px] text-white/45 sm:gap-5 sm:text-[11px]">
        {health?.health.classifier?.provider === "openai_luna" && health.classifierUsage ? (
          <span className="tabnum hidden md:inline" title="Estimated input plus output cost of responses with recorded usage; reserved cost also covers unknown outcomes. These are local controls, not provider invoice or balance evidence.">
            Luna est. {health.classifierUsage.estimatedCostUsd == null ? "unknown" : fmtCost(health.classifierUsage.estimatedCostUsd)} · {health.classifierUsage.requests} requests today
          </span>
        ) : usage && (
          <span
            className="tabnum hidden md:inline"
            title="Input-cost estimate for judgments with identified source provenance; excludes unknown-source history and failed or retried requests. Not an invoice."
          >
            Jev historical input est. {fmtCost(usage.estimatedInputCostUsd)} · {usage.judgedItems} source-identified judgments today
          </span>
        )}
        <span className="tabnum hidden sm:inline">
          {totalMentions} source records/24h
        </span>
        <span
          className="flex whitespace-nowrap items-center gap-1 font-medium tracking-[0.04em] sm:gap-1.5 sm:tracking-wider"
          title="The local desk app is connected; source collection status is shown separately."
        >
          <span className={`h-1.5 w-1.5 rounded-full ${connected ? "live-dot bg-emerald-400" : "bg-red-400"}`} />
          {connected ? "APP CONNECTED" : "APP DISCONNECTED"}
        </span>
        <span className="tabnum hidden w-16 text-right sm:inline">{clockTime(clock)}</span>
      </div>
    </header>
  );
}
