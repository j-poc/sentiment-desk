import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CollectorId, Company } from "./types.js";
import { DEFAULT_STORAGE_LIMITS, type StorageLimits } from "./storage-capacity.js";

// Node's built-in .env loader. A missing .env is fine; the process env still applies.
try {
  process.loadEnvFile();
} catch {
  /* no .env file */
}

const int = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

const storageBytes = (value: string | undefined, fallback: number): number => {
  if (value === undefined || !/^\d+$/.test(value.trim())) return fallback;
  const parsed = Number(value.trim());
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 16 * 1024 * 1024 * 1024 ? parsed : fallback;
};

const storageMaxDatabaseBytes = storageBytes(process.env.DESK_DB_MAX_BYTES, DEFAULT_STORAGE_LIMITS.maxDatabaseBytes);
const storageHeadroomBytes = storageBytes(process.env.DESK_STORAGE_WRITE_HEADROOM_BYTES, DEFAULT_STORAGE_LIMITS.writeHeadroomBytes);
const defaultStorageFamilyBytes = Math.max(DEFAULT_STORAGE_LIMITS.maxFamilyBytes, storageMaxDatabaseBytes * 2 + storageHeadroomBytes);
const storageConfig: StorageLimits = {
  maxDatabaseBytes: storageMaxDatabaseBytes,
  maxFamilyBytes: storageBytes(process.env.DESK_DB_FAMILY_MAX_BYTES, defaultStorageFamilyBytes),
  minimumFreeBytes: storageBytes(process.env.DESK_DISK_MIN_FREE_BYTES, DEFAULT_STORAGE_LIMITS.minimumFreeBytes),
  writeHeadroomBytes: storageHeadroomBytes,
};

export function boundedNonNegativeInt(v: string | undefined, maximum: number): number {
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= 0 && n <= maximum ? n : 0;
}

export function boundedUsdMicros(v: string | undefined, maximumUsd: number): number {
  if (v === undefined || !/^\d+(?:\.\d{1,6})?$/.test(v.trim())) return 0;
  const micros = Number(v) * 1_000_000;
  return Number.isSafeInteger(micros) && micros >= 0 && micros <= maximumUsd * 1_000_000 ? micros : 0;
}

export function parseClassificationProvider(value: string | undefined): "openai_luna" {
  if (value === undefined || value.trim() === "") return "openai_luna";
  const selected = value.trim();
  if (selected === "typesafe") {
    throw new Error("CLASSIFICATION_PROVIDER=typesafe is retired; historical Jev records remain readable, while new classifications use OpenAI Luna.");
  }
  return z.enum(["openai_luna"]).parse(selected);
}

const externalSourceCollectorSchema = z.enum([
  "google_news_rss",
  "yahoo_finance_rss",
  "yahoo_quote",
  "yahoo_chart",
  "gdelt_doc_api",
  "sec_edgar",
  "finnhub",
  "reddit",
  "x",
]);

export function parseExternalSourceCollectors(value: string | undefined): Set<CollectorId> {
  const collectors = z.array(externalSourceCollectorSchema).parse(
    (value ?? "")
      .split(",")
      .map((collector) => collector.trim())
      .filter(Boolean),
  );
  return new Set(collectors satisfies CollectorId[]);
}

/** Operator attestation gate, kept separate from the request allowlist. */
export function parseSourceRightsApprovedCollectors(value: string | undefined): Set<CollectorId> {
  return parseExternalSourceCollectors(value);
}

export function secContactUserAgent(raw: string | undefined): string {
  const candidate = raw?.trim() ?? "";
  if (!candidate || candidate.length > 256 || /[\u0000-\u001f\u007f]/.test(candidate)) return "";
  const contact = candidate.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
  if (!contact) return "";
  const identifier = candidate.replace(contact[0], " ").trim();
  return identifier.length >= 3 ? candidate : "";
}

export const VERSION = "0.2.0";

export const config = {
  classificationProvider: parseClassificationProvider(process.env.CLASSIFICATION_PROVIDER),
  /** Provider and model requests require an explicit opt-in; false serves saved data only. */
  externalRequestsEnabled: parseExternalRequestsEnabled(process.env.EXTERNAL_REQUESTS_ENABLED),
  /** Empty by default: external request opt-in still needs a per-source allowlist. */
  externalSourceCollectors: parseExternalSourceCollectors(process.env.EXTERNAL_SOURCE_COLLECTORS),
  /** Empty by default: each requested source also needs a separate operator approval flag. */
  sourceRightsApprovedCollectors: parseSourceRightsApprovedCollectors(process.env.SOURCE_RIGHTS_APPROVED_COLLECTORS),
  /** Native runs stay loopback-only; container images override this for port publishing. */
  host: process.env.HOST?.trim() || "127.0.0.1",
  port: int(process.env.PORT, 8787),
  dbPath: process.env.DB_PATH?.trim() || path.resolve("data/desk.db"),
  storage: storageConfig,
  companiesPath: process.env.COMPANIES_PATH?.trim() || path.resolve("config/companies.json"),
  jev: {
    model: process.env.TYPESAFE_MODEL?.trim() || "jev-latest",
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY?.trim() || "",
    model: "gpt-6-luna",
    timeoutMs: 30_000,
    accountUseApproved: parseExplicitBoolean(process.env.OPENAI_ACCOUNT_USE_APPROVED),
    allowedCollectors: new Set<CollectorId>(parseExternalSourceCollectors(process.env.OPENAI_ALLOWED_COLLECTORS)),
    maxRequestsPerDay: boundedNonNegativeInt(process.env.OPENAI_MAX_REQUESTS_PER_DAY, 100),
    maxRequestBytesPerDay: boundedNonNegativeInt(process.env.OPENAI_MAX_REQUEST_BYTES_PER_DAY, 400_000),
    maxDailyCostMicros: boundedUsdMicros(process.env.OPENAI_MAX_DAILY_COST_USD, 100),
  },
  xBearer: process.env.X_BEARER_TOKEN?.trim() || "",
  /** Finnhub free tier: per-symbol news + EPS surprises + earnings calendar. */
  finnhubKey: process.env.FINNHUB_API_KEY?.trim() || "",
  pollFinnhubSeconds: int(process.env.POLL_FINNHUB_SECONDS, 120),
  /** One-time news backfill per company (days). Gives the outcome check sample depth. */
  backfillDays: int(process.env.BACKFILL_DAYS, 5),
  /** Reddit free OAuth app (script type): social tier source. */
  redditClientId: process.env.REDDIT_CLIENT_ID?.trim() || "",
  redditClientSecret: process.env.REDDIT_CLIENT_SECRET?.trim() || "",
  pollRedditSeconds: int(process.env.POLL_REDDIT_SECONDS, 180),
  /**
   * SEC fair-access policy wants a User-Agent that identifies the requester.
   * Do not send SEC requests until the operator supplies a descriptive
   * identifier with contact information.
   */
  secUserAgent: secContactUserAgent(process.env.SEC_USER_AGENT),
  pollSecSeconds: int(process.env.POLL_SEC_SECONDS, 90),
  pollRssSeconds: int(process.env.POLL_RSS_SECONDS, 180),
  /** Webhook (Discord/Slack-style JSON) pinged on fresh, high-strength events. */
  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL?.trim() || "",
  alertEventScore: int(process.env.ALERT_EVENT_SCORE, 65),
  alertImpact: int(process.env.ALERT_IMPACT, 55),
  alertFreshMinutes: int(process.env.ALERT_FRESH_MINUTES, 15),
  pollXSeconds: int(process.env.POLL_X_SECONDS, 180),
  pollGdeltSeconds: int(process.env.POLL_GDELT_SECONDS, 300),
  pollQuotesSeconds: int(process.env.POLL_QUOTES_SECONDS, 90),
  scoreConcurrency: int(process.env.SCORE_CONCURRENCY, 6),
  rssConcurrency: int(process.env.RSS_CONCURRENCY, 2),
  /** Market context rows shown on the tape; never scored, never in the watchlist. */
  indices: (process.env.INDICES?.split(",") ?? ["SPY", "QQQ", "^VIX"])
    .map((s) => s.trim())
    .filter(Boolean),
};

export function parseExternalRequestsEnabled(value: string | undefined): boolean {
  return parseExplicitBoolean(value);
}

export function parseExplicitBoolean(value: string | undefined): boolean {
  if (value === undefined) return false;
  return z.enum(["true", "false"]).parse(value.trim().toLowerCase()) === "true";
}

const companySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  ticker: z.string().min(1),
  sector: z.string().min(1),
  aliases: z.array(z.string().min(1)).min(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  ambiguous: z.boolean().optional(),
});

export function loadCompanies(filePath = config.companiesPath): Company[] {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as { companies: unknown };
  const parsed = z.object({ companies: z.array(companySchema).min(1) }).parse(raw);
  const seen = new Set<string>();
  for (const c of parsed.companies) {
    if (seen.has(c.id)) throw new Error(`duplicate company id ${c.id}`);
    seen.add(c.id);
  }
  return parsed.companies;
}
