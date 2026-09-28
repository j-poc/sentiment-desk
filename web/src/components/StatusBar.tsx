import type { HealthDTO, Mention } from "../lib/api.js";
import type { SessionInfo } from "../lib/marketHours.js";

function fmtBytes(n: number | null): string {
  if (n == null) return "--";
  if (n > 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

/** Detection lag: how far behind publication our ingestion runs. */
function ingestP50(tape: Mention[]): string {
  const vals = tape
    .filter((m) => m.publishedAt != null && m.timeBasis === "publisher_declared")
    .map((m) => Math.max(0, m.retrievedAt - m.publishedAt!))
    .sort((a, b) => a - b);
  if (vals.length === 0) return "--";
  const mid = vals[Math.floor(vals.length / 2)];
  const s = (mid ?? 0) / 1000;
  if (s < 90) return `${Math.round(s)}s`;
  if (s < 5400) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

function p50Latency(tape: Mention[]): string {
  const vals = tape
    .map((m) => m.score?.latencyMs)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);
  if (vals.length === 0) return "--";
  return `${vals[Math.floor(vals.length / 2)]}ms`;
}

/**
 * Terminal status bar: the small print that makes a desk feel operated, not
 * visited. Mode on the left, market session center, system vitals right.
 */
export function StatusBar({
  health,
  session,
  connected,
  tape,
}: {
  health: HealthDTO | null;
  session: SessionInfo;
  connected: boolean;
  tape: Mention[];
}) {
  const engine = health
    ? !health.externalRequestsEnabled
      ? "paused offline"
      : health.health.jev.enabled
      ? health.health.jev.model
      : "awaiting key"
    : "…";

  return (
    <footer className="flex h-[26px] shrink-0 items-center gap-2 whitespace-nowrap border-t border-desk-line bg-black/60 px-2 text-[9px] text-white/40 sm:gap-4 sm:px-4 sm:text-[10px]">
      <span className="tabnum">v{health?.version ?? "0.2.0"}</span>
      <span
        className="flex items-center gap-1.5"
        title="The local desk app is connected; source collection status is shown separately."
      >
        <span className={`h-1.5 w-1.5 rounded-full ${connected ? "live-dot bg-emerald-400" : "bg-red-400"}`} />
        {connected ? "app connected" : "app disconnected"}
      </span>
      <span className="hidden sm:inline">
        engine <span className="text-white/60">{engine}</span>
      </span>
      <span className="hidden md:inline">
        score p50 <span className="tabnum text-white/60">{p50Latency(tape)}</span>
      </span>
      <span className="hidden md:inline">
        ingest p50 <span className="tabnum text-white/60">{ingestP50(tape)}</span>
      </span>

      <span
        className="ml-auto tabnum font-medium tracking-wider"
        style={{
          color:
            session.state === "open" ? "#34d399" : session.state === "closed" ? "rgba(232,235,242,0.35)" : "#fbbf24",
        }}
      >
        {session.label}
      </span>
      <span className="tabnum">{session.etClock}</span>

      <span className="hidden tabnum md:inline" title="quote store age">
        quotes {health?.health.quotes.ok ? "ok" : "--"}
      </span>
      <span className="hidden tabnum md:inline">sse {health?.sseClients ?? 0}</span>
      <span className="hidden tabnum md:inline" title="sqlite file size">
        db {fmtBytes(health?.dbSizeBytes ?? null)}
      </span>
    </footer>
  );
}
