/**
 * Optional Finnhub news and earnings endpoints. Plan quotas vary; requests are
 * paced to one start per second and stop source-wide on HTTP 429 until the
 * provider's Retry-After window or the bounded fallback expires.
 */

import { paceProviderRequest, parseRetryAfterMs, ProviderRateLimitError } from "../provider-cooldown.js";

export interface FinnhubNewsItem {
  headline: string;
  summary: string;
  source: string;
  url: string;
  datetime: number | null; // provider timestamp converted to milliseconds
}

export interface FinnhubNewsFetchResult {
  items: FinnhubNewsItem[];
  /** Rows returned by the provider before unusable rows are discarded. */
  providerItemCount: number;
  malformedItemCount: number;
}

export async function fetchFinnhubNews(
  symbol: string,
  token: string,
  fromDaysAgo = 3,
  timeoutMs = 15_000,
): Promise<FinnhubNewsFetchResult> {
  const to = new Date();
  const from = new Date(to.getTime() - fromDaysAgo * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const params = new URLSearchParams({
    symbol,
    from: fmt(from),
    to: fmt(to),
    token,
  });
  await paceProviderRequest("finnhub", 1_000);
  const res = await fetch(`https://finnhub.io/api/v1/company-news?${params}`, {
    headers: { "user-agent": "Mozilla/5.0", accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 429) throw new ProviderRateLimitError("finnhub", parseRetryAfterMs(res.headers.get("retry-after")), "Finnhub HTTP 429");
  if (!res.ok) throw new Error(`finnhub news HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new Error("finnhub news returned an invalid response shape");
  const items: FinnhubNewsItem[] = [];
  for (const row of body) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
    const item = row as Record<string, unknown>;
    if (typeof item.headline !== "string" || item.headline.trim() === ""
      || typeof item.url !== "string" || item.url.trim() === "") continue;
    items.push({
      headline: item.headline,
      summary: typeof item.summary === "string" ? item.summary.slice(0, 600) : "",
      source: typeof item.source === "string" && item.source.trim() !== "" ? item.source : "finnhub",
      url: item.url,
      datetime: typeof item.datetime === "number" && Number.isFinite(item.datetime) && item.datetime > 0
        ? item.datetime * 1000
        : null,
    });
  }
  return {
    items,
    providerItemCount: body.length,
    malformedItemCount: body.length - items.length,
  };
}

export interface EarningsEntry {
  date: number; // ms
  epsActual: number | null;
  epsEstimate: number | null;
  period: string;
}

export async function fetchEarningsHistory(
  symbol: string,
  token: string,
  timeoutMs = 15_000,
): Promise<EarningsEntry[]> {
  const params = new URLSearchParams({ symbol, token });
  await paceProviderRequest("finnhub", 1_000);
  const res = await fetch(`https://finnhub.io/api/v1/stock/earnings?${params}`, {
    headers: { "user-agent": "Mozilla/5.0", accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 429) throw new ProviderRateLimitError("finnhub", parseRetryAfterMs(res.headers.get("retry-after")), "Finnhub earnings HTTP 429");
  if (!res.ok) throw new Error(`finnhub earnings HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (!Array.isArray(body)) throw new Error("finnhub earnings returned an invalid response shape");
  const entries: EarningsEntry[] = [];
  for (const row of body) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new Error("finnhub earnings returned a malformed row");
    }
    const entry = row as Record<string, unknown>;
    if (typeof entry.date !== "string" || entry.date.trim() === "") {
      throw new Error("finnhub earnings returned a row without a date");
    }
    const date = Date.parse(entry.date);
    if (!Number.isFinite(date)) throw new Error("finnhub earnings returned an invalid date");
    const epsActual = entry.epsActual;
    const epsEstimate = entry.epsEstimate;
    if (epsActual != null && (typeof epsActual !== "number" || !Number.isFinite(epsActual))) {
      throw new Error("finnhub earnings returned an invalid actual EPS value");
    }
    if (epsEstimate != null && (typeof epsEstimate !== "number" || !Number.isFinite(epsEstimate))) {
      throw new Error("finnhub earnings returned an invalid estimated EPS value");
    }
    entries.push({
      date,
      epsActual: epsActual == null ? null : epsActual,
      epsEstimate: epsEstimate == null ? null : epsEstimate,
      period: typeof entry.period === "string" ? entry.period : "",
    });
  }
  return entries;
}

/** Surprise % of the most recent quarter with both actual and estimate present. */
export function latestSurprise(entries: EarningsEntry[]): {
  percent: number;
  period: string;
} | null {
  const sorted = [...entries].sort((a, b) => b.date - a.date);
  for (const e of sorted) {
    if (e.epsActual != null && e.epsEstimate != null && e.epsEstimate !== 0) {
      const percent = Math.round(((e.epsActual - e.epsEstimate) / Math.abs(e.epsEstimate)) * 10000) / 100;
      return { percent, period: e.period };
    }
  }
  return null;
}

/** Next scheduled earnings date at or after now, from the upcoming calendar. */
export async function fetchUpcomingEarnings(
  token: string,
  symbols: Set<string>,
  timeoutMs = 15_000,
): Promise<Map<string, number>> {
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const from = new Date();
  const to = new Date(from.getTime() + 21 * 24 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    from: fmt(from),
    to: fmt(to),
    token,
  });
  await paceProviderRequest("finnhub", 1_000);
  const res = await fetch(`https://finnhub.io/api/v1/calendar/earnings?${params}`, {
    headers: { "user-agent": "Mozilla/5.0", accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 429) throw new ProviderRateLimitError("finnhub", parseRetryAfterMs(res.headers.get("retry-after")), "Finnhub calendar HTTP 429");
  if (!res.ok) throw new Error(`finnhub calendar HTTP ${res.status}`);
  const body: unknown = await res.json();
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("finnhub earnings calendar returned an invalid response shape");
  }
  const rows = (body as Record<string, unknown>).earningsCalendar;
  if (!Array.isArray(rows)) throw new Error("finnhub earnings calendar omitted its result list");
  const out = new Map<string, number>();
  for (const row of rows) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) {
      throw new Error("finnhub earnings calendar returned a malformed row");
    }
    const entry = row as Record<string, unknown>;
    if (typeof entry.symbol !== "string" || entry.symbol.trim() === ""
      || typeof entry.date !== "string" || entry.date.trim() === "") {
      throw new Error("finnhub earnings calendar row is missing symbol or date");
    }
    const t = Date.parse(entry.date);
    if (!Number.isFinite(t)) throw new Error("finnhub earnings calendar returned an invalid date");
    const upper = entry.symbol.toUpperCase();
    if (symbols.has(upper) && (!out.has(upper) || t < (out.get(upper) ?? Infinity))) {
      out.set(upper, t);
    }
  }
  return out;
}
