import type { HealthDTO } from "./api.js";

/** A compact status for the collapsed operations summary. Global request permission alone does not prove a feed is running. */
export function operationsStatusSummary(health: HealthDTO): string {
  const enabled = health.deliveryHealth.filter((delivery) => delivery.enabled);
  const currentCount = enabled.filter((delivery) => delivery.state === "current").length;
  const collection = health.storage.state !== "ready"
    ? "storage paused · saved data only"
    : !health.externalRequestsEnabled
      ? "external requests off · saved data only"
      : enabled.length === 0
        ? "no data feeds enabled"
        : `${currentCount}/${enabled.length} data feeds current`;

  const classifier = health.health.classifier ?? health.health.jev;
  const classifierName = health.health.classifier?.provider === "openai_luna" ? "Luna" : "Jev";
  const classifierBlockedReason = health.health.classifier?.blockedReason;
  const classifierStatus = classifier?.enabled
    ? `${classifierName} ready`
    : health.health.classifier?.accountingRoute === "chatgpt_plan" && classifierBlockedReason?.toLowerCase().includes("chatgpt plan")
      ? `${classifierName} paused · ChatGPT plan not connected`
      : classifierBlockedReason
        ? `${classifierName} blocked`
        : `${classifierName} paused`;

  return `${collection} · ${classifierStatus}`;
}

export function operationsAttentionCount(health: HealthDTO): number {
  const degradedDeliveries = health.deliveryHealth.filter((delivery) =>
    ["partial", "overdue", "failed", "processing"].includes(delivery.state)
    || delivery.latestIngestionState === "partial"
    || delivery.latestIngestionState === "failed",
  ).length;
  const sourceErrors = [health.health.rss, health.health.gdelt, health.health.x,
    health.health.quotes, health.health.sec, health.health.finnhub, health.health.reddit,
    health.health.classifier ?? health.health.jev]
    .filter((source) => source.lastErrorAt != null
      && (source.lastOkAt == null || source.lastErrorAt > source.lastOkAt)).length;
  const alerts = Object.values(health.alertDelivery.counts).reduce((sum, count) => sum + count, 0);
  const accounting = health.classifierUsage
    ? Math.max(health.classifierUsage.unpricedAttempts, health.classifierUsage.unknownOutcomes,
      health.classifierUsage.usageIncompleteAttempts)
    : 0;
  const storageIssue = health.storage.state === "ready" ? 0 : 1;
  return degradedDeliveries + sourceErrors + storageIssue + health.health.sourceApproval.blockedRequestedCollectors.length
    + alerts + accounting;
}
