import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { Company } from "./types.js";

// Node's built-in .env loader. A missing .env is fine; the process env still applies.
try {
  process.loadEnvFile();
} catch {
  /* no .env file */
}

const bool = (v: string | undefined) => v === "1" || v?.toLowerCase() === "true";
const int = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

/**
 * Credential resolution, mirroring the newsjack chain: process env (which the
 * project .env feeds), then ~/.newsjack/.env as a shared-machine fallback. The
 * value never leaves the server process.
 */
function readEnvFile(filePath: string): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const text = fs.readFileSync(filePath, "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      const key = m?.[1];
      const value = m?.[2];
      if (key && value != null) out.set(key, value.replace(/^["']|["']$/g, ""));
    }
  } catch {
    /* file absent */
  }
  return out;
}

const newsjackEnv = readEnvFile(path.join(os.homedir(), ".newsjack", ".env"));
const envKey = process.env.TYPESAFE_API_KEY?.trim() || "";
const apiKey = envKey || newsjackEnv.get("TYPESAFE_API_KEY")?.trim() || "";
export const apiKeySource = envKey ? "env" : apiKey ? "~/.newsjack/.env" : "missing";

export const VERSION = "0.2.0";

export const config = {
  port: int(process.env.PORT, 8787),
  dbPath: process.env.DB_PATH?.trim() || path.resolve("data/desk.db"),
  companiesPath: process.env.COMPANIES_PATH?.trim() || path.resolve("config/companies.json"),
  jev: {
    apiKey,
    baseUrl: (process.env.TYPESAFE_BASE_URL?.trim() || "https://api.typesafe.ai").replace(/\/+$/, ""),
    model: process.env.TYPESAFE_MODEL?.trim() || "jev-latest",
    timeoutMs: 30_000,
    /** List price per million input tokens; output is free. */
    inputPricePerMTok: 0.042,
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
   * A generic research-desk default is used when none is set; personalize it
   * in .env (name + email) if this desk runs unattended for long.
   */
  secUserAgent: process.env.SEC_USER_AGENT?.trim() || "sentiment-desk/0.3 (personal research desk)",
  pollSecSeconds: int(process.env.POLL_SEC_SECONDS, 90),
  pollRssSeconds: int(process.env.POLL_RSS_SECONDS, 30),
  /** Webhook (Discord/Slack-style JSON) pinged on fresh, high-strength events. */
  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL?.trim() || "",
  alertEventScore: int(process.env.ALERT_EVENT_SCORE, 65),
  alertImpact: int(process.env.ALERT_IMPACT, 55),
  alertFreshMinutes: int(process.env.ALERT_FRESH_MINUTES, 15),
  pollXSeconds: int(process.env.POLL_X_SECONDS, 180),
  pollGdeltSeconds: int(process.env.POLL_GDELT_SECONDS, 300),
  pollQuotesSeconds: int(process.env.POLL_QUOTES_SECONDS, 45),
  scoreConcurrency: int(process.env.SCORE_CONCURRENCY, 6),
  rssConcurrency: int(process.env.RSS_CONCURRENCY, 4),
  demo: bool(process.env.DEMO),
  /** Market context rows shown on the tape; never scored, never in the watchlist. */
  indices: (process.env.INDICES?.split(",") ?? ["SPY", "QQQ", "^VIX"])
    .map((s) => s.trim())
    .filter(Boolean),
};

const companySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  ticker: z.string().min(1),
  sector: z.string().min(1),
  aliases: z.array(z.string().min(1)).min(1),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
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
