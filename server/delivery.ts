import { createHash } from "node:crypto";
import type { Desk, SourceDeliveryInput } from "./db.js";
import type { CollectorId } from "./types.js";

export type DeliveryHealthState = "current" | "processing" | "overdue" | "failed" | "partial" | "never" | "disabled";

export function deliveryHealthState(input: {
  enabled: boolean;
  hasDelivery: boolean;
  latestDeliveryAt: number | null;
  latestResult: string | null;
  ingestionRequired?: boolean;
  ingestionState?: "processing" | "success" | "partial" | "failed" | null;
  ingestionStartedAt?: number | null;
  recentFailureCount: number;
  recentPartialCount: number;
  coverageCount: number;
  targetCount: number;
  now: number;
  intervalSeconds: number;
}): DeliveryHealthState {
  if (!input.enabled) return "disabled";
  if (!input.hasDelivery || input.latestDeliveryAt == null) return "never";
  const dueAfterMs = Math.max(input.intervalSeconds * 3_000, 180_000);
  if (input.ingestionRequired) {
    if (input.ingestionState == null || input.ingestionState === "failed") return "failed";
    if (input.ingestionState === "partial") return "partial";
    if (input.ingestionState === "processing") {
      return input.now - (input.ingestionStartedAt ?? input.latestDeliveryAt) > dueAfterMs ? "failed" : "processing";
    }
  }
  if (input.now - input.latestDeliveryAt > dueAfterMs) return "overdue";
  if (input.recentFailureCount > 0 || ["failed", "rate_limited", "invalid"].includes(input.latestResult ?? "")) return "failed";
  if (input.recentPartialCount > 0 || input.latestResult === "partial") return "partial";
  if (input.targetCount > 0 && input.coverageCount < input.targetCount) return "partial";
  return "current";
}

export function normalizedDigest(value: unknown): string | null {
  if (value == null) return null;
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function classifyDeliveryError(error: unknown): SourceDeliveryInput["result"] {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof SyntaxError || (error instanceof TypeError && /not a function|not iterable|cannot read properties/i.test(message))) return "invalid";
  if (/\b429\b|rate.?limit/i.test(message)) return "rate_limited";
  if (/invalid|malformed|not valid json|contract validation|parse error/i.test(message)) return "invalid";
  return "failed";
}

export function recordDelivery(opts: {
  db: Desk;
  collector: CollectorId;
  companyId: string | null;
  requestKey: string;
  startedAt: number;
  adapterVersion: string;
  result: SourceDeliveryInput["result"];
  parsedItemCount: number;
  normalizedItems?: unknown;
  error?: unknown;
  processingExpected?: boolean;
}): string {
  return opts.db.recordDelivery({
    collector: opts.collector,
    companyId: opts.companyId,
    requestKey: opts.requestKey,
    startedAt: opts.startedAt,
    completedAt: Date.now(),
    result: opts.result,
    parsedItemCount: opts.parsedItemCount,
    responseDigest: normalizedDigest(opts.normalizedItems),
    adapterVersion: opts.adapterVersion,
    error: opts.error == null ? null : (opts.error instanceof Error ? opts.error.message : String(opts.error)),
    processingRequired: opts.processingExpected,
  });
}

/** Persist a separate, one-way ingestion outcome for a provider receipt. */
export function processDeliveryItems<T>(opts: {
  db: Desk;
  deliveryId: string;
  expectedCount: number;
  process: (itemProcessed: (inserted?: boolean) => void) => T;
}): T {
  opts.db.startDeliveryIngestion(opts.deliveryId, opts.expectedCount);
  let processedCount = 0;
  let insertedCount = 0;
  const itemProcessed = (inserted = false): void => {
    processedCount += 1;
    if (inserted) insertedCount += 1;
  };
  try {
    const result = opts.process(itemProcessed);
    opts.db.finishDeliveryIngestion(opts.deliveryId, {
      status: "success", processedCount, insertedCount,
    });
    return result;
  } catch (error) {
    try {
      opts.db.finishDeliveryIngestion(opts.deliveryId, {
        status: processedCount > 0 ? "partial" : "failed",
        processedCount,
        insertedCount,
        error: error instanceof Error ? error.message : String(error),
      });
    } catch (finalizeError) {
      throw new AggregateError([error, finalizeError], "Observation ingestion failed and its outcome could not be finalized");
    }
    throw error;
  }
}
