import type { HealthDTO } from "./api.js";

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
