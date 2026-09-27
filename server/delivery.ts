import { createHash } from "node:crypto";
import type { Desk, SourceDeliveryInput } from "./db.js";
import type { CollectorId } from "./types.js";

export type DeliveryHealthState = "current" | "overdue" | "failed" | "partial" | "never" | "disabled";

export function deliveryHealthState(input: {
  enabled: boolean;
  hasDelivery: boolean;
  latestDeliveryAt: number | null;
  latestResult: string | null;
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
}): void {
  opts.db.recordDelivery({
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
  });
}
