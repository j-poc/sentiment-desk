import fs from "node:fs";
import { isIP } from "node:net";
import { homedir } from "node:os";
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

export function parseChatGPTPlanBudget(env: NodeJS.ProcessEnv): { maxRequestsPerDay: number; maxRequestBytesPerDay: number } {
  return {
    maxRequestsPerDay: env.CHATGPT_PLAN_MAX_REQUESTS_PER_DAY === undefined
      ? 100
      : boundedNonNegativeInt(env.CHATGPT_PLAN_MAX_REQUESTS_PER_DAY, 100),
    maxRequestBytesPerDay: env.CHATGPT_PLAN_MAX_REQUEST_BYTES_PER_DAY === undefined
      ? 1_638_400
      : boundedNonNegativeInt(env.CHATGPT_PLAN_MAX_REQUEST_BYTES_PER_DAY, 1_638_400),
  };
}

export function parseChatGPTPlanLocalOrigin(value: string | undefined, fallback: string): string {
  if (value === undefined || value.trim() === "") return fallback;
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("CHATGPT_PLAN_LOCAL_ORIGIN must be an exact loopback HTTP origin."); }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  const loopback = hostname === "localhost" || hostname === "::1"
    || (isIP(hostname) === 4 && hostname.split(".")[0] === "127");
  if (url.protocol !== "http:" || !loopback || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("CHATGPT_PLAN_LOCAL_ORIGIN must be an exact loopback HTTP origin.");
  }
  return url.origin;
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
  "sec_company_facts",
  "sec_latest_filings_8k",
  "nasdaq_symbol_directories",
  "finnhub",
  "reddit",
  "x",
]);

const DEFAULT_PUBLIC_SEC_COLLECTORS = "sec_edgar,sec_company_facts";

export function parseExternalSourceCollectors(value: string | undefined): Set<CollectorId> {
  const collectors = z.array(externalSourceCollectorSchema).parse(
    (value === undefined ? DEFAULT_PUBLIC_SEC_COLLECTORS : value)
      .split(",")
      .map((collector) => collector.trim())
      .filter(Boolean),
  );
  return new Set(collectors satisfies CollectorId[]);
}

const DEFAULT_OPENAI_ALLOWED_COLLECTORS = "google_news_rss,yahoo_finance_rss";

/** Luna may process the two approved public RSS feeds by default; request and rights gates still apply. */
export function parseOpenAILunaAllowedCollectors(value: string | undefined): Set<CollectorId> {
  return parseExternalSourceCollectors(value?.trim() ? value : DEFAULT_OPENAI_ALLOWED_COLLECTORS);
}

/** Operator attestation gate, kept separate from the request allowlist. */
export function parseSourceRightsApprovedCollectors(value: string | undefined): Set<CollectorId> {
  return parseExternalSourceCollectors(value);
}

export const VERSION = "0.2.0";

export function secContactUserAgent(raw: string | undefined): string {
  const candidate = raw?.trim() ?? "";
  if (!candidate || candidate.length > 256 || /[\u0000-\u001f\u007f]/.test(candidate)) return "";
  const contact = candidate.match(/[^\s@]+@[^\s@]+\.[^\s@]+/);
  if (!contact) return "";
  const identifier = candidate.replace(contact[0], " ").trim();
  if (identifier.length >= 3) return candidate;
  if (identifier.length === 0) return `Sentiment Desk/${VERSION} ${contact[0]}`;
  return "";
}

export function parseSecUserAgent(value: string | undefined): string {
  const userAgent = secContactUserAgent(value);
  if (!userAgent) return "";
  const email = userAgent.match(/[^\s@]+@([^\s@]+\.[^\s@]+)/)?.[1]?.toLowerCase();
  if (!email || email === "example.com" || email === "example.org" || email === "example.net"
    || email.endsWith(".example") || email.endsWith(".invalid") || email.endsWith(".test")) return "";
  return userAgent;
}

export const config = {
  classificationProvider: parseClassificationProvider(process.env.CLASSIFICATION_PROVIDER),
  /** Every network request requires an explicit operator opt-in. */
  externalRequestsEnabled: parseExternalRequestsEnabled(process.env.EXTERNAL_REQUESTS_ENABLED),
  /** A fresh local desk requests only public SEC records unless another source is explicitly configured. */
  externalSourceCollectors: parseExternalSourceCollectors(process.env.EXTERNAL_SOURCE_COLLECTORS),
  /** The same SEC-only default allows issuer facts and filings; other sources require separate use review. */
  sourceRightsApprovedCollectors: parseSourceRightsApprovedCollectors(process.env.SOURCE_RIGHTS_APPROVED_COLLECTORS),
  /** Native runs stay loopback-only; container images override this for port publishing. */
  host: process.env.HOST?.trim() || "127.0.0.1",
  port: int(process.env.PORT, 8787),
  chatgptPlanLocalOrigin: parseChatGPTPlanLocalOrigin(
    process.env.CHATGPT_PLAN_LOCAL_ORIGIN,
    `http://127.0.0.1:${int(process.env.PORT, 8787)}`,
  ),
  publicDataHubInstallationFile: process.env.DESK_HUB_INSTALLATION_FILE?.trim()
    || path.join(homedir(), ".codex", "references", "sentiment-desk-public-data-hub-installation.json"),
  dbPath: process.env.DB_PATH?.trim() || path.resolve("data/desk.db"),
  storage: storageConfig,
  companiesPath: process.env.COMPANIES_PATH?.trim() || path.resolve("config/companies.json"),
  jev: {
    model: process.env.TYPESAFE_MODEL?.trim() || "jev-latest",
  },
  openai: {
    model: "gpt-6-luna",
    timeoutMs: 30_000,
    allowedCollectors: parseOpenAILunaAllowedCollectors(process.env.OPENAI_ALLOWED_COLLECTORS),
    ...parseChatGPTPlanBudget(process.env),
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
  /** SEC requests stay disabled until the operator supplies a real contact-bearing identifier. */
  secUserAgent: parseSecUserAgent(process.env.SEC_USER_AGENT),
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
  if (value === undefined) return false;
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
  listingStatus: z.literal("publicly_listed"),
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
