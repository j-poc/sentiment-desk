/**
 * Finnhub free tier: per-symbol company news, the earnings calendar, and EPS
 * surprise history (actual vs consensus). The surprise number is what upgrades
 * the desk's "surprise" judgment from model guess to measured fact. Free tier
 * is 60 calls/minute; the poller stays far under it.
 */

export interface FinnhubNewsItem {
  headline: string;
  summary: string;
  source: string;
  url: string;
  datetime: number; // unix seconds
}

export async function fetchFinnhubNews(
  symbol: string,
  token: string,
  fromDaysAgo = 3,
  timeoutMs = 15_000,
): Promise<FinnhubNewsItem[]> {
  const to = new Date();
  const from = new Date(to.getTime() - fromDaysAgo * 24 * 60 * 60 * 1000);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const params = new URLSearchParams({
    symbol,
    from: fmt(from),
    to: fmt(to),
    token,
  });
  const res = await fetch(`https://finnhub.io/api/v1/company-news?${params}`, {
    headers: { "user-agent": "Mozilla/5.0", accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 429) throw new Error("finnhub rate limited");
  if (!res.ok) throw new Error(`finnhub news HTTP ${res.status}`);
  const body = (await res.json()) as Array<{
    headline?: string;
    summary?: string;
    source?: string;
    url?: string;
    datetime?: number;
  }>;
  return body
    .filter((n) => n.headline && n.url)
    .map((n) => ({
      headline: n.headline ?? "",
      summary: (n.summary ?? "").slice(0, 600),
      source: n.source ?? "finnhub",
      url: n.url ?? "",
      datetime: (n.datetime ?? 0) * 1000,
    }));
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
  const res = await fetch(`https://finnhub.io/api/v1/stock/earnings?${params}`, {
    headers: { "user-agent": "Mozilla/5.0", accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`finnhub earnings HTTP ${res.status}`);
  const body = (await res.json()) as Array<{
    date?: string;
    epsActual?: number | null;
    epsEstimate?: number | null;
    period?: string;
  }>;
  return body
    .filter((e) => e.date)
    .map((e) => ({
      date: Date.parse(e.date ?? ""),
      epsActual: e.epsActual ?? null,
      epsEstimate: e.epsEstimate ?? null,
      period: e.period ?? "",
    }))
    .filter((e) => Number.isFinite(e.date));
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
  const res = await fetch(`https://finnhub.io/api/v1/calendar/earnings?${params}`, {
    headers: { "user-agent": "Mozilla/5.0", accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`finnhub calendar HTTP ${res.status}`);
  const body = (await res.json()) as {
    earningsCalendar?: Array<{ symbol?: string; date?: string }>;
  };
  const out = new Map<string, number>();
  for (const e of body.earningsCalendar ?? []) {
    if (!e.symbol || !e.date) continue;
    const t = Date.parse(e.date);
    if (!Number.isFinite(t)) continue;
    const upper = e.symbol.toUpperCase();
    if (symbols.has(upper) && (!out.has(upper) || t < (out.get(upper) ?? Infinity))) {
      out.set(upper, t);
    }
  }
  return out;
}
