import fs from "node:fs";
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

export const config = {
  port: int(process.env.PORT, 8787),
  dbPath: process.env.DB_PATH?.trim() || path.resolve("data/desk.db"),
  companiesPath: process.env.COMPANIES_PATH?.trim() || path.resolve("config/companies.json"),
  jev: {
    apiKey: process.env.TYPESAFE_API_KEY?.trim() || "",
    baseUrl: (process.env.TYPESAFE_BASE_URL?.trim() || "https://api.typesafe.ai").replace(/\/+$/, ""),
    model: process.env.TYPESAFE_MODEL?.trim() || "jev-latest",
    timeoutMs: 30_000,
    /** List price per million input tokens; output is free. */
    inputPricePerMTok: 0.042,
  },
  xBearer: process.env.X_BEARER_TOKEN?.trim() || "",
  pollRssSeconds: int(process.env.POLL_RSS_SECONDS, 60),
  pollXSeconds: int(process.env.POLL_X_SECONDS, 180),
  scoreConcurrency: int(process.env.SCORE_CONCURRENCY, 6),
  demo: bool(process.env.DEMO),
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
