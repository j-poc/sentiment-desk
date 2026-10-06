import { useEffect, useState } from "react";
import { getJSON, type AlertDeliveryHistoryPage, type AlertDeliveryRecord, type HealthDTO } from "../lib/api.js";
import { operationsAttentionCount } from "../lib/operations-attention.js";
import { fmtCost, shortTime, timeAgo } from "../lib/format.js";

function Row({ label, value, wrap = false }: { label: string; value: string; wrap?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px]">
      <span className="shrink-0 text-white/35">{label}</span>
      <span className={`tabnum min-w-0 text-right text-white/70 ${wrap ? "whitespace-normal break-words" : "truncate"}`}>{value}</span>
    </div>
  );
}

function bytes(value: number | null): string {
  if (value == null) return "unavailable";
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  if (value < 1024 ** 3) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}

function recordedDeliveryOutcome(result: string | null): string | null {
  if (result === "partial") return "partial response";
  if (result === "failed") return "failed";
  if (result === "rate_limited") return "rate limited";
  if (result === "invalid") return "invalid response";
  return null;
}

export function HealthPanel({ health }: { health: HealthDTO | null }) {
  if (!health) return null;
  const { jev, rss, gdelt, x } = health.health;
  const { sourceApproval } = health.health;
  const classifier = health.health.classifier ?? jev;
  const lunaSelected = health.health.classifier?.provider === "openai_luna";
  const storagePaused = health.storage.state !== "ready";

  return (
    <div className="px-4 py-3.5 text-[11px]">
      <Row label="global request switch" value={health.externalRequestsEnabled ? "on" : "off · saved data only"} />
      <Row
        label="source-use approvals"
        value={sourceApproval.blockedRequestedCollectors.length > 0
          ? `${sourceApproval.blockedRequestedCollectors.length} requested blocked · ${sourceApproval.blockedRequestedCollectors.join(", ")}`
          : `${sourceApproval.approvedCollectors.length} approved source flag(s) · ${sourceApproval.approvedCollectors.join(", ") || "none"}`}
        wrap
      />
      <Row label={lunaSelected ? "OpenAI account-use flag" : "Jev account-use flag"} value={(lunaSelected ? sourceApproval.openaiAccountUseApproved : sourceApproval.typesafeAccountUseApproved) ? "set · operator attestation" : "missing · dispatch blocked"} wrap />
      <Row label="engine" value={`${classifier.model} · ${health.externalRequestsEnabled ? classifier.enabled ? "enabled" : "blocked" : "paused"}`} />
      <div className="mt-3 border-t border-white/[0.05] pt-2.5">
        <Row label="database capacity" value={health.storage.state.replaceAll("_", " ")} />
        <Row label="SQLite logical / physical" value={`${bytes(health.storage.logicalDatabaseBytes)} logical · ${bytes(health.storage.mainBytes)} main`} wrap />
        <Row label="SQLite sidecars" value={`${bytes(health.storage.walBytes)} WAL · ${bytes(health.storage.shmBytes)} SHM · ${bytes(health.storage.journalBytes)} journal`} wrap />
        <Row label="file family / pause threshold" value={`${bytes(health.storage.familyBytes)} measured · ${bytes(health.storage.maxFamilyBytes)} threshold`} wrap />
        <Row label="volume free / required minimum" value={`${bytes(health.storage.availableBytes)} · ${bytes(health.storage.minimumFreeBytes)}`} wrap />
        <Row label="write headroom target" value={bytes(health.storage.writeHeadroomBytes)} />
        <Row label="logical database limit" value={`${bytes(health.storage.maxDatabaseBytes)} hard SQLite page ceiling`} wrap />
        <Row label="storage measured" value={timeAgo(health.storage.checkedAt)} />
        {storagePaused && (
          <div role="status" aria-live="polite" className="mt-1 rounded border border-amber-300/15 bg-amber-200/[0.035] px-2 py-1.5 text-amber-100/80">
            New external requests are paused; saved evidence remains available. File-family and free-space values are admission thresholds, not guaranteed completion reserves. {health.storage.reason ?? "Restore database capacity, then retry."}
          </div>
        )}
      </div>
      {health.health.classifier?.blockedReason && <Row label="classifier gate" value={health.health.classifier.blockedReason} wrap />}
      <div role="note" className="mt-1 text-[9.5px] text-amber-200/55">
        Approval flags are operator attestations; they do not independently verify source rights or account terms.
      </div>
      <Row label="historical Jev judgments today" value={String(health.usage.judgedItems)} />
      <Row label="Jev input estimate · identified sources" value={fmtCost(health.usage.estimatedInputCostUsd)} />
      {health.classifierUsage && (
        <>
          <Row label="Luna dispatched / reserved today" value={`${health.classifierUsage.requests} / ${health.classifierUsage.reservedRequests}`} />
          <Row label="Luna cost estimate / reserved" value={`${health.classifierUsage.estimatedCostUsd == null ? "unknown" : fmtCost(health.classifierUsage.estimatedCostUsd)} / ${fmtCost(health.classifierUsage.reservedCostUsd)}`} />
          {health.classifierUsage.unpricedAttempts > 0 && <Row label="Known cost subtotal · incomplete" value={`${fmtCost(health.classifierUsage.knownCostSubtotalUsd)} · ${health.classifierUsage.unpricedAttempts} unpriced request(s)`} wrap />}
          {health.classifierUsage.usageIncompleteAttempts > 0 && <Row label="Incomplete token receipts" value={String(health.classifierUsage.usageIncompleteAttempts)} />}
          <Row label="Luna unknown outcomes" value={String(health.classifierUsage.unknownOutcomes)} />
          <p className="mt-1 text-[9.5px] text-white/40">Input plus output estimates are not invoices or account balances. Unknown outcomes retain their full cost reservation.</p>
        </>
      )}
      {classifier.lastError && (
        <div className="mt-1 clamp-2 text-red-400/80" title={classifier.lastError}>
          {classifier.lastError}
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
          const recordedOutcome = recordedDeliveryOutcome(delivery.latestResult);
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
                <span>
                  {delivery.latestItemCount == null ? "no response" : `${delivery.latestItemCount} provider rows`}
                  {delivery.latestIngestionRequired && ` · ingestion ${delivery.latestIngestionState ?? "not started"} ${delivery.latestIngestionProcessedCount ?? 0}/${delivery.latestIngestionExpectedCount ?? 0}`}
                </span>
              </div>
              {recordedOutcome && (
                <div
                  role="status"
                  aria-live="polite"
                  className={`ml-1 mt-0.5 clamp-2 text-[9.5px] ${delivery.latestResult === "failed" || delivery.latestResult === "invalid" ? "text-red-300/75" : "text-amber-200/75"}`}
                  title={delivery.latestError ?? undefined}
                >
                  Last recorded outcome: {recordedOutcome}{delivery.latestDeliveryAt == null ? "" : ` · ${timeAgo(delivery.latestDeliveryAt)}`}{delivery.latestError ? ` · ${delivery.latestError}` : ""}
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

export function DeskHealthDisclosure({ health, loadState = "loading" }: { health: HealthDTO | null; loadState?: "loading" | "ready" | "failed" }) {
  if (!health) return (
    <p role="status" aria-live="polite" className="mb-2 px-1 text-[10.5px] text-amber-200/80">
      {loadState === "failed"
        ? "Operations status unavailable. Source, classifier, and webhook state could not be loaded. Waiting for the next server update."
        : "Checking source, classifier, and webhook status…"}
    </p>
  );
  const operationalIssues = operationsAttentionCount(health);
  const mode = health.storage.state !== "ready" ? "storage paused · saved data only"
    : health.externalRequestsEnabled ? "external requests enabled" : "saved data only";
  return (
    <>
    {loadState === "failed" && <p role="status" aria-live="polite" className="mb-2 px-1 text-[10.5px] text-amber-200/80">Operations refresh failed. Showing the last received source, classifier, and webhook status.</p>}
    <details className="mt-3 border-t border-desk-line pt-2.5 2xl:hidden">
      <summary className="flex min-h-9 cursor-pointer list-none items-center gap-2 rounded px-1 text-white/55 hover:bg-white/[0.025] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 [&::-webkit-details-marker]:hidden">
        <span className="micro">Desk health</span>
        <span role="status" aria-live="polite" className={operationalIssues > 0 ? "text-amber-200/85" : "text-white/35"}>
          {operationalIssues > 0 ? `${operationalIssues} signal${operationalIssues === 1 ? "" : "s"} · ${mode}` : mode}
        </span>
        <span className="ml-auto text-white/25">details</span>
      </summary>
      <HealthPanel health={health} />
    </details>
    </>
  );
}

function eta(ms: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.ceil((ms - now) / 1000));
  if (seconds < 60) return `in ${seconds}s`;
  if (seconds < 3600) return `in ${Math.ceil(seconds / 60)}m`;
  return `in ${Math.ceil(seconds / 3600)}h`;
}

function alertState(record: AlertDeliveryRecord): { label: string; color: string; detail: string } {
  if (record.state === "delivered") return { label: "endpoint accepted", color: "text-emerald-300/80", detail: "The webhook returned a successful HTTP response." };
  if (record.state === "retrying" && record.lastOutcome === "ambiguous") return { label: "delivery uncertain", color: "text-amber-200/90", detail: `Retry ${eta(record.nextAttemptAt)} · repeated sends may occur.` };
  if (record.state === "retrying") return { label: "retry scheduled", color: "text-amber-200/90", detail: `Next attempt ${eta(record.nextAttemptAt)}.` };
  if (record.state === "sending") return { label: "sending", color: "text-white/65", detail: "Waiting for a webhook response." };
  if (record.state === "pending") return { label: "queued", color: "text-white/55", detail: `Expires ${eta(record.expiresAt)}.` };
  if (record.state === "paused") return { label: "paused", color: "text-white/45", detail: "The configured destination changed." };
  if (record.state === "expired") return { label: "expired", color: "text-white/40", detail: "The freshness window closed before delivery." };
  return { label: "delivery failed", color: "text-red-300/85", detail: "No further automatic attempts are scheduled." };
}

export function AlertDeliveryStatus({
  delivery,
  onOpenEvidence,
}: {
  delivery: HealthDTO["alertDelivery"] | null;
  onOpenEvidence: (companyId: string, observationId: string) => Promise<boolean>;
}) {
  const [evidenceUnavailable, setEvidenceUnavailable] = useState(false);
  const [older, setOlder] = useState<AlertDeliveryRecord[]>([]);
  const [nextCursor, setNextCursor] = useState(delivery?.nextCursor ?? null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  useEffect(() => {
    setOlder([]);
    setNextCursor(delivery?.nextCursor ?? null);
    setHistoryUnavailable(false);
  }, [delivery?.nextCursor]);
  if (!delivery) return null;
  const latest = delivery.recent[0];
  const counts = delivery.counts;
  const attentionCount = counts.pending + counts.sending + counts.retrying + counts.failed + counts.paused;
  const deliveryConfigLabel = !delivery.configured ? "webhook not configured" : !delivery.enabled ? "dispatch paused" : null;
  const summary = attentionCount > 0
    ? `${attentionCount} alert${attentionCount === 1 ? "" : "s"} need attention${deliveryConfigLabel ? ` · ${deliveryConfigLabel}` : ""}`
    : deliveryConfigLabel ?? (latest ? alertState(latest).label : "no eligible alerts yet");
  const summaryColor = counts.failed > 0 ? "text-red-300/85"
    : attentionCount > 0 || !delivery.enabled ? "text-amber-200/85"
      : latest ? alertState(latest).color : "text-white/50";
  const visibleAlerts = [...delivery.recent, ...older.filter((record) => !delivery.recent.some((current) => current.alertId === record.alertId))];

  return (
    <details className="mx-3 mt-1.5 border-b border-desk-line/70 px-1 pb-1.5 text-[10px] sm:mx-4">
      <summary className="flex min-h-7 cursor-pointer list-none items-center gap-2 text-white/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 [&::-webkit-details-marker]:hidden">
        <span className="micro">Webhook alerts</span>
        <span className={`${summaryColor} truncate`} aria-live="polite">{summary}</span>
        {latest && <span className="ml-auto shrink-0 tabnum text-white/30">{latest.attemptCount} attempt{latest.attemptCount === 1 ? "" : "s"}</span>}
        <span className="shrink-0 text-white/25">details</span>
      </summary>
      <div className="grid gap-1.5 pt-1.5" aria-label="Recent webhook alert delivery outcomes">
        {attentionCount > 0 && (
          <div role="status" aria-live="polite" className={counts.failed > 0 ? "text-red-300/80" : "text-amber-200/75"}>
            {counts.failed > 0 ? `${counts.failed} terminal failure${counts.failed === 1 ? "" : "s"}. ` : ""}
            {counts.pending + counts.sending + counts.retrying + counts.paused} pending, sending, retrying, or paused.
          </div>
        )}
        {!delivery.enabled && delivery.configured && <div className="text-amber-200/70">External requests are paused; queued alerts are not sent.</div>}
        {visibleAlerts.length === 0 && <div className="text-white/40">No qualifying observation has created an alert.</div>}
        {visibleAlerts.map((record) => {
          const state = alertState(record);
          return (
            <div key={record.alertId} className="flex min-w-0 items-center gap-2 rounded border border-white/[0.06] bg-white/[0.015] px-2 py-1.5">
              <span className="w-14 shrink-0 font-mono text-white/55">{record.ticker}</span>
              <button
                type="button"
                onClick={async () => {
                  setEvidenceUnavailable(false);
                  if (!await onOpenEvidence(record.companyId, record.observationId)) setEvidenceUnavailable(true);
                }}
                className="min-w-0 flex-1 truncate text-left text-white/65 underline decoration-white/15 underline-offset-2 hover:text-white/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300"
                aria-label={`Open evidence for ${record.ticker}: ${record.title}`}
              >
                {record.title}
              </button>
              <span className={`shrink-0 ${state.color}`} title={state.detail}>{state.label}</span>
              <span className="hidden w-28 shrink-0 truncate text-right text-white/30 sm:block">{state.detail}</span>
              {record.lastHttpStatus != null && <span className="shrink-0 tabnum text-white/30">HTTP {record.lastHttpStatus}</span>}
              <span className="hidden shrink-0 tabnum text-white/25 md:block">{record.attemptCount} sent</span>
            </div>
          );
        })}
        {evidenceUnavailable && <div role="status" className="text-amber-200/70">The source evidence could not be loaded. Refresh the desk and try again.</div>}
        {historyUnavailable && <div role="status" className="text-amber-200/70">Older alert outcomes could not be loaded. Try again.</div>}
        {nextCursor != null && (
          <button
            type="button"
            disabled={loadingOlder}
            aria-busy={loadingOlder}
            onClick={async () => {
              if (!nextCursor || loadingOlder) return;
              setLoadingOlder(true);
              setHistoryUnavailable(false);
              try {
                const page = await getJSON<AlertDeliveryHistoryPage>(`/api/alerts?limit=10&cursor=${encodeURIComponent(nextCursor)}`);
                setOlder((current) => {
                  const byId = new Map(current.map((record) => [record.alertId, record]));
                  for (const record of page.items) byId.set(record.alertId, record);
                  return [...byId.values()];
                });
                setNextCursor(page.nextCursor);
              } catch {
                setHistoryUnavailable(true);
              } finally {
                setLoadingOlder(false);
              }
            }}
            className="justify-self-start rounded border border-white/10 px-2 py-1 text-white/55 hover:bg-white/[0.04] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:opacity-45"
          >
            {loadingOlder ? "Loading older outcomes…" : "Load older alert outcomes"}
          </button>
        )}
        <div className="text-[9px] text-white/25">“Endpoint accepted” means the webhook returned 2xx; it does not confirm downstream processing. Ambiguous network failures may be retried.</div>
      </div>
    </details>
  );
}
