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
  const { jev, rss, gdelt, x } = health.health;

  return (
    <div className="px-4 py-3.5 text-[11px]">
      <Row label="external requests" value={health.externalRequestsEnabled ? "enabled" : "paused · saved data only"} />
      <Row label="engine" value={`${jev.model} · ${health.externalRequestsEnabled ? jev.enabled ? "live" : "off" : "paused"}`} />
      <Row label="source-identified judged today" value={String(health.usage.judgedItems)} />
      <Row label="est. input cost · identified sources" value={fmtCost(health.usage.estimatedInputCostUsd)} />
      {jev.lastError && (
        <div className="mt-1 clamp-2 text-red-400/80" title={jev.lastError}>
          {jev.lastError}
        </div>
      )}

      <div className="mt-3 border-t border-white/[0.05] pt-2.5">
        <Row label="rss news" value={!health.externalRequestsEnabled ? "paused (offline mode)" : rss.enabled ? `${rss.ok} ok / ${rss.fail} fail · ${timeAgo(rss.lastOkAt)}` : "off (configuration)"} />
        <Row
          label="gdelt news"
          value={!health.externalRequestsEnabled ? "paused (offline mode)" : gdelt.enabled ? `${gdelt.ok} ok / ${gdelt.fail} fail · ${timeAgo(gdelt.lastOkAt)}` : "disabled (source allowlist)"}
        />
        <Row
          label="x api"
          value={!health.externalRequestsEnabled ? "paused (offline mode)" : x.enabled ? `${x.ok} ok / ${x.fail} fail · ${timeAgo(x.lastOkAt)}` : "off (configuration)"}
        />
        <Row
          label="quotes"
          value={!health.externalRequestsEnabled ? "paused (offline mode)" : health.health.quotes.enabled ? `${health.health.quotes.ok} ok / ${health.health.quotes.fail} fail · ${timeAgo(health.health.quotes.lastOkAt)}` : "off (configuration)"}
        />
        <Row
          label="sec edgar"
          value={!health.externalRequestsEnabled ? "paused (offline mode)" : health.health.sec.enabled ? `${health.health.sec.ok} ok / ${health.health.sec.fail} fail · ${timeAgo(health.health.sec.lastOkAt)}` : "off (configuration)"}
        />
        <Row
          label="finnhub"
          value={!health.externalRequestsEnabled ? "paused (offline mode)" : health.health.finnhub.enabled ? `${health.health.finnhub.ok} ok / ${health.health.finnhub.fail} fail · ${timeAgo(health.health.finnhub.lastOkAt)}` : "off (configuration)"}
        />
        <Row
          label="reddit"
          value={!health.externalRequestsEnabled ? "paused (offline mode)" : health.health.reddit.enabled ? `${health.health.reddit.ok} ok / ${health.health.reddit.fail} fail · ${timeAgo(health.health.reddit.lastOkAt)}` : "off (configuration)"}
        />
        <Row label="sse clients" value={String(health.sseClients)} />
        <Row label="uptime" value={`${Math.max(1, Math.floor(health.uptimeSec / 60))}m`} />
      </div>

      <div className="mt-3 border-t border-white/[0.05] pt-2.5">
        <div className="mb-1 text-[10px] uppercase tracking-[0.14em] text-white/30">source delivery and evidence age</div>
        {health.deliveryHealth.map((delivery) => {
          const color = delivery.state === "current" ? "text-emerald-300/70"
            : delivery.state === "failed" ? "text-red-300/80"
              : delivery.state === "disabled" || delivery.state === "never" ? "text-white/30"
                : "text-amber-300/80";
          const name = delivery.collector.replaceAll("_", " ");
          const evidenceLabel = delivery.latestObservationAt == null
            ? delivery.latestObservationBasis === "unknown" || delivery.latestObservationBasis === "legacy_unknown" ? "source time unknown" : "no stored item"
            : `${delivery.latestObservationBasis === "provider_observed" ? "seen" : "published"} ${timeAgo(delivery.latestObservationAt)}`;
          return (
            <div key={delivery.collector} className="py-[2px]" title={delivery.adapterVersion ?? undefined}>
              <div className="flex items-baseline gap-2 text-[10.5px]">
                <span className="min-w-0 flex-1 truncate text-white/45">{name}</span>
                <span className={`w-16 shrink-0 text-right uppercase ${color}`}>{delivery.state}</span>
                <span className="tabnum shrink-0 text-white/30">{delivery.latestDeliveryAt == null ? "no delivery" : timeAgo(delivery.latestDeliveryAt)}</span>
                <span className="w-32 shrink-0 truncate text-right text-white/30">{evidenceLabel}</span>
              </div>
              <div className="ml-1 flex items-baseline justify-between gap-2 text-[9px] text-white/25">
                <span>recent coverage {delivery.coverageCount}/{delivery.targetCount} companies</span>
                <span>{delivery.latestItemCount == null ? "no response" : `${delivery.latestItemCount} provider rows`}</span>
              </div>
              {delivery.latestError && (delivery.state === "partial" || delivery.state === "failed" || delivery.state === "overdue") && (
                <div
                  role="status"
                  aria-live="polite"
                  className={`ml-1 mt-0.5 clamp-2 text-[9.5px] ${delivery.state === "failed" ? "text-red-300/75" : "text-amber-200/75"}`}
                >
                  {delivery.latestError}
                </div>
              )}
            </div>
          );
        })}
        {health.deliveryHealth.length === 0 && <div className="text-[10.5px] text-white/30">No source delivery schedules configured.</div>}
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
