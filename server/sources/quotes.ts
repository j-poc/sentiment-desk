/**
 * Market data from Yahoo Finance's public chart endpoint, the same no-key
 * source the major open-source terminal projects rely on (Neuberg, the
 * Bloomberg clones). Two shapes:
 *
 *  - snapshot quotes: last price + session change % per ticker (tape, watchlist)
 *  - intraday/daily series: for the price overlay on the sentiment chart
 *
 * Failures degrade visibly: the caller marks health, the UI keeps the last
 * good value and shows "as of" age. Nothing here touches scoring.
 */

import { paceProviderRequest, parseRetryAfterMs, ProviderRateLimitError } from "../provider-cooldown.js";

export interface Quote {
  ticker: string;
  price: number;
  changePct: number;
  currency: string;
  at: number | null; // ms, exchange-reported regularMarketTime; never inferred from retrieval
}

export interface PricePoint {
  t: number;
  price: number;
  currency: string;
  collector?: "yahoo_chart";
  retrievedAt?: number;
  adapterVersion?: string;
  deliveryId?: string;
}

interface ChartMeta {
  symbol?: string;
  regularMarketPrice?: number;
  chartPreviousClose?: number;
  previousClose?: number;
  regularMarketTime?: number;
  currency?: string;
}

interface ChartResponse {
  chart?: {
    result?: Array<{
      meta?: ChartMeta;
      timestamp?: number[];
      indicators?: { quote?: Array<{ close?: Array<number | null> }> };
    }>;
  };
}

type ChartResult = NonNullable<NonNullable<ChartResponse["chart"]>["result"]>[number];

// Yahoo throttles long browser-fingerprint UAs but serves the plain one.
const UA = "Mozilla/5.0";

export class RateLimitedError extends ProviderRateLimitError {
  constructor(retryAfterMs?: number, message = "Yahoo Finance HTTP 429", readonly deferred = false) {
    super("yahoo", retryAfterMs, message);
    this.name = "RateLimitedError";
  }
}

async function fetchChart(path: string, timeoutMs: number): Promise<unknown> {
  await paceProviderRequest("yahoo", 500);
  const res = await fetch(`https://query1.finance.yahoo.com${path}`, {
    headers: { "user-agent": UA, accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (res.status === 429) throw new RateLimitedError(parseRetryAfterMs(res.headers.get("retry-after")));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function chartResult(body: unknown): ChartResult | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("Yahoo chart returned an invalid response shape");
  }
  const chart = (body as Record<string, unknown>).chart;
  if (typeof chart !== "object" || chart === null || Array.isArray(chart)) {
    throw new Error("Yahoo chart response omitted chart metadata");
  }
  const chartObject = chart as Record<string, unknown>;
  if (chartObject.error != null) throw new Error("Yahoo chart provider returned an error");
  if (!Array.isArray(chartObject.result)) throw new Error("Yahoo chart response omitted its result list");
  if (chartObject.result.length === 0) return null;
  const result = chartObject.result[0];
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error("Yahoo chart response contains an invalid result row");
  }
  return result as ChartResult;
}

export async function fetchQuote(ticker: string, timeoutMs = 10_000): Promise<Quote> {
  const body = await fetchChart(
    `/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=5d&includePrePost=false`,
    timeoutMs,
  );
  const meta = chartResult(body)?.meta;
  if (typeof meta?.symbol !== "string" || meta.symbol.toUpperCase() !== ticker.toUpperCase()) {
    throw new Error(`Yahoo quote symbol missing or mismatched for ${ticker}`);
  }
  const price = meta?.regularMarketPrice;
  const prev = meta?.chartPreviousClose ?? meta?.previousClose;
  if (price == null || !Number.isFinite(price) || price <= 0
    || prev == null || !Number.isFinite(prev) || prev <= 0) {
    throw new Error(`quote incomplete for ${ticker}`);
  }
  const currency = meta?.currency;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    throw new Error(`quote currency missing or invalid for ${ticker}`);
  }
  return {
    ticker,
    price,
    changePct: Math.round(((price - prev) / prev) * 10000) / 100,
    currency,
    at: typeof meta?.regularMarketTime === "number" && Number.isFinite(meta.regularMarketTime)
      ? meta.regularMarketTime * 1000
      : null,
  };
}

export function seriesRangeFor(hours: number): { range: string; interval: string } {
  if (hours <= 24) return { range: "1d", interval: "5m" };
  if (hours <= 72) return { range: "5d", interval: "30m" };
  if (hours <= 168) return { range: "5d", interval: "60m" };
  return { range: "1mo", interval: "1d" };
}

export async function fetchPriceSeries(
  ticker: string,
  hours: number,
  timeoutMs = 10_000,
): Promise<PricePoint[]> {
  const { range, interval } = seriesRangeFor(hours);
  const body = await fetchChart(
    `/v8/finance/chart/${encodeURIComponent(ticker)}?interval=${interval}&range=${range}&includePrePost=false`,
    timeoutMs,
  );
  const result = chartResult(body);
  if (result === null) return [];
  if (typeof result.meta?.symbol !== "string" || result.meta.symbol.toUpperCase() !== ticker.toUpperCase()) {
    throw new Error(`Yahoo chart symbol missing or mismatched for ${ticker}`);
  }
  const currency = result.meta?.currency;
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    throw new Error(`Yahoo chart currency missing or invalid for ${ticker}`);
  }
  const ts = result.timestamp;
  const closes = result.indicators?.quote?.[0]?.close;
  if (!Array.isArray(ts) || !Array.isArray(closes)) {
    throw new Error("Yahoo chart result omitted timestamp or close arrays");
  }
  if (ts.length !== closes.length) {
    throw new Error("Yahoo chart timestamp and close arrays have inconsistent lengths");
  }
  const out: PricePoint[] = [];
  for (let i = 0; i < ts.length; i++) {
    const rawTimestamp = ts[i];
    const c = closes[i];
    if (typeof rawTimestamp !== "number" || !Number.isFinite(rawTimestamp) || rawTimestamp <= 0) {
      throw new Error("Yahoo chart result contains an invalid timestamp");
    }
    if (c == null) continue;
    if (typeof c !== "number" || !Number.isFinite(c) || c <= 0) {
      throw new Error("Yahoo chart result contains an invalid close value");
    }
    out.push({ t: rawTimestamp * 1000, price: c, currency });
  }
  return out;
}
