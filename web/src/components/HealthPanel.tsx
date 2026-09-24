import type { HealthDTO } from "../lib/api.js";
import { fmtCost, shortTime, timeAgo } from "../lib/format.js";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px]">
      <span className="text-white/35">{label}</span>
      <span className="tabnum truncate text-right text-white/70">{value}</span>
    </div>
  );
}

export function HealthPanel({ health }: { health: HealthDTO | null }) {
  if (!health) return null;
  const { jev, rss, x } = health.health;

  return (
    <div className="px-4 py-3.5 text-[11px]">
      <Row label="engine" value={`${jev.model} · ${jev.enabled ? "live" : "off"}`} />
      <Row label="calls today" value={String(health.usage.calls)} />
      <Row label="cost today" value={fmtCost(health.usage.costUsd)} />
      {jev.lastError && (
        <div className="mt-1 clamp-2 text-red-400/80" title={jev.lastError}>
          {jev.lastError}
        </div>
      )}

      <div className="mt-3 border-t border-white/[0.05] pt-2.5">
        <Row label="rss news" value={`${rss.ok} ok / ${rss.fail} fail · ${timeAgo(rss.lastOkAt)}`} />
        <Row
          label="x api"
          value={x.enabled ? `${x.ok} ok / ${x.fail} fail · ${timeAgo(x.lastOkAt)}` : "disabled (no token)"}
        />
        <Row
          label="quotes"
          value={`${health.health.quotes.ok} ok / ${health.health.quotes.fail} fail · ${timeAgo(health.health.quotes.lastOkAt)}`}
        />
        <Row
          label="sec edgar"
          value={health.health.sec.enabled ? `${health.health.sec.ok} ok / ${health.health.sec.fail} fail · ${timeAgo(health.health.sec.lastOkAt)}` : "off (no UA)"}
        />
        <Row
          label="finnhub"
          value={health.health.finnhub.enabled ? `${health.health.finnhub.ok} ok / ${health.health.finnhub.fail} fail · ${timeAgo(health.health.finnhub.lastOkAt)}` : "off (no key)"}
        />
        <Row
          label="reddit"
          value={health.health.reddit.enabled ? `${health.health.reddit.ok} ok / ${health.health.reddit.fail} fail · ${timeAgo(health.health.reddit.lastOkAt)}` : "off (no app)"}
        />
        <Row label="sse clients" value={String(health.sseClients)} />
        <Row label="uptime" value={`${Math.max(1, Math.floor(health.uptimeSec / 60))}m`} />
      </div>

      {health.events.length > 0 && (
        <div className="mt-3 border-t border-white/[0.05] pt-2.5">
          <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-white/30">events</div>
          {health.events.slice(0, 6).map((e, i) => (
            <div key={`${e.at}-${i}`} className="flex items-baseline gap-2 py-[2px] text-[10.5px]">
              <span className="tabnum shrink-0 text-white/30">{shortTime(e.at)}</span>
              <span
                className={`shrink-0 font-medium ${
                  e.level === "error" ? "text-red-400" : e.level === "warn" ? "text-amber-400" : "text-white/40"
                }`}
              >
                {e.source}
              </span>
              <span className="clamp-1 min-w-0 flex-1 text-white/50">{e.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
