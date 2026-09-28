import type { Desk } from "./db.js";

export type RateLimitedProvider = "google_news" | "yahoo" | "sec" | "finnhub" | "reddit" | "x";

const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1_000;
const lastProviderRequestAt = new Map<RateLimitedProvider, number>();
const providerRequestQueues = new Map<RateLimitedProvider, Promise<void>>();

export class ProviderRateLimitError extends Error {
  constructor(
    readonly provider: RateLimitedProvider,
    readonly retryAfterMs?: number,
    message = `${provider} HTTP 429`,
  ) {
    super(message);
    this.name = "ProviderRateLimitError";
  }
}

/** Serializes request starts for a provider across its collectors in this process. */
export async function paceProviderRequest(provider: RateLimitedProvider, minIntervalMs: number): Promise<void> {
  const previous = providerRequestQueues.get(provider) ?? Promise.resolve();
  let release!: () => void;
  const turn = new Promise<void>((resolve) => { release = resolve; });
  providerRequestQueues.set(provider, turn);
  await previous;
  try {
    const interval = Number.isSafeInteger(minIntervalMs) && minIntervalMs > 0 ? minIntervalMs : 1_000;
    const previousAt = lastProviderRequestAt.get(provider) ?? 0;
    const delay = previousAt + interval - Date.now();
    if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    lastProviderRequestAt.set(provider, Date.now());
  } finally {
    release();
  }
}

export function parseRetryAfterMs(value: string | null, now = Date.now()): number | undefined {
  const header = value?.trim();
  if (!header) return undefined;
  if (/^\d+$/.test(header)) {
    const delayMs = Number(header) * 1_000;
    return Number.isSafeInteger(delayMs) ? delayMs : undefined;
  }
  const retryAt = Date.parse(header);
  if (!Number.isFinite(retryAt)) return undefined;
  const delayMs = Math.max(0, retryAt - now);
  return Number.isSafeInteger(delayMs) ? delayMs : undefined;
}

function cooldownKey(provider: RateLimitedProvider, field: "retry-at" | "failures"): string {
  return `provider-cooldown:${provider}:${field}`;
}

/** Returns the persisted retry time; corrupt state fails closed for one day. */
export function providerRetryAt(db: Desk, provider: RateLimitedProvider, now = Date.now()): number {
  const key = cooldownKey(provider, "retry-at");
  const raw = db.getKv(key);
  if (raw === undefined || raw === "0") return 0;
  const retryAt = Number(raw);
  if (!Number.isSafeInteger(retryAt) || retryAt < 0) {
    const safeRetryAt = now + MAX_COOLDOWN_MS;
    db.setKv(key, String(safeRetryAt));
    db.logEvent("warn", provider, "invalid persisted cooldown; delaying requests for up to one day");
    return safeRetryAt;
  }
  return retryAt;
}

export function providerCoolingDown(db: Desk, provider: RateLimitedProvider, now = Date.now()): boolean {
  return providerRetryAt(db, provider, now) > now;
}

export function recordProviderRateLimit(input: {
  db: Desk;
  provider: RateLimitedProvider;
  minDelayMs: number;
  retryAfterMs?: number;
  now?: number;
}): number {
  const now = input.now ?? Date.now();
  const minDelay = Number.isSafeInteger(input.minDelayMs) && input.minDelayMs > 0
    ? Math.min(input.minDelayMs, MAX_COOLDOWN_MS)
    : 1_000;
  const countKey = cooldownKey(input.provider, "failures");
  const prior = Number(input.db.getKv(countKey) ?? "0");
  const failures = Number.isSafeInteger(prior) && prior >= 0 ? prior + 1 : 1;
  const fallbackMs = Math.min(MAX_COOLDOWN_MS, minDelay * 2 ** Math.min(failures - 1, 16));
  const requestedMs = input.retryAfterMs == null ? fallbackMs : input.retryAfterMs;
  const delayMs = Math.min(MAX_COOLDOWN_MS, Math.max(minDelay, requestedMs));
  const previousRetryAt = providerRetryAt(input.db, input.provider, now);
  const proposedRetryAt = now + delayMs;
  const retryAt = Math.min(
    now + MAX_COOLDOWN_MS,
    Math.max(previousRetryAt > now ? previousRetryAt : 0, proposedRetryAt),
  );
  input.db.setKv(countKey, String(failures));
  input.db.setKv(cooldownKey(input.provider, "retry-at"), String(retryAt));
  return retryAt;
}

export function clearProviderRateLimit(
  db: Desk,
  provider: RateLimitedProvider,
  successfulRequestStartedAt = Number.MAX_SAFE_INTEGER,
): void {
  const raw = db.getKv(cooldownKey(provider, "retry-at"));
  const retryAt = Number(raw ?? "0");
  if (raw !== undefined && raw !== "0" && (!Number.isSafeInteger(retryAt) || retryAt < 0)) return;
  // A request already in flight when another request received a 429 must not
  // erase that newer cooldown merely because it completed successfully later.
  if (Number.isSafeInteger(retryAt) && retryAt > successfulRequestStartedAt) return;
  db.setKv(cooldownKey(provider, "retry-at"), "0");
  db.setKv(cooldownKey(provider, "failures"), "0");
}
