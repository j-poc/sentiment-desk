/**
 * GDELT DOC 2.0 API: a free, keyless, global news index updated every 15
 * minutes. Used as a breadth/confirmation source: it sees outlets the per-
 * ticker feeds miss, and its domain field feeds the same tier prior. Polite
 * pacing matters; this poller runs on its own slow clock, not the RSS cycle.
 */

export interface GdeltArticle {
  title: string;
  url: string;
  domain: string;
  seenAt: number | null;
}

export interface GdeltFetchResult {
  articles: GdeltArticle[];
  /** Number of rows returned by the provider before unusable rows are discarded. */
  providerResultCount: number;
  requestedLimit: number;
  /** True when the provider may have omitted older matches at the requested cap. */
  saturated: boolean;
}

export const GDELT_ARTICLE_LIMIT = 250;

export class GdeltHttpError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterMs?: number,
  ) {
    super(`GDELT HTTP ${status}`);
    this.name = "GdeltHttpError";
  }
}

interface GdeltResponse {
  articles?: unknown[];
}

interface GdeltRawArticle {
  url?: unknown;
  title?: unknown;
  seendate?: unknown;
  domain?: unknown;
}

function parseSeenDate(raw: string | undefined): number {
  // "20260924T121500Z"
  if (!raw || raw.length < 15) return NaN;
  const y = Number(raw.slice(0, 4));
  const mo = Number(raw.slice(4, 6));
  const d = Number(raw.slice(6, 8));
  const h = Number(raw.slice(9, 11));
  const mi = Number(raw.slice(11, 13));
  const s = Number(raw.slice(13, 15));
  if (![y, mo, d, h, mi, s].every(Number.isInteger) || mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return NaN;
  const t = Date.UTC(y, mo - 1, d, h, mi, s);
  const parsed = new Date(t);
  if (parsed.getUTCFullYear() !== y || parsed.getUTCMonth() !== mo - 1 || parsed.getUTCDate() !== d) return NaN;
  return Number.isFinite(t) ? t : NaN;
}

function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
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

export async function fetchGdeltArticles(
  query: string,
  timeoutMs = 15_000,
  maxRecords = GDELT_ARTICLE_LIMIT,
): Promise<GdeltFetchResult> {
  if (!Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > GDELT_ARTICLE_LIMIT) {
    throw new Error(`GDELT maxRecords must be an integer from 1 to ${GDELT_ARTICLE_LIMIT}`);
  }
  const params = new URLSearchParams({
    query: `${query} sourcelang:english`,
    mode: "ArtList",
    maxrecords: String(maxRecords),
    format: "json",
    sort: "DateDesc",
    timespan: "2d",
  });
  const res = await fetch(`https://api.gdeltproject.org/api/v2/doc/doc?${params}`, {
    headers: { "user-agent": "Mozilla/5.0", accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    if (res.status === 429) throw new GdeltHttpError(res.status, parseRetryAfter(res.headers.get("retry-after")));
    throw new GdeltHttpError(res.status);
  }
  const text = await res.text();
  // GDELT occasionally returns HTML error pages; fail loudly but safely.
  if (text.trim().startsWith("<")) throw new Error("GDELT returned non-JSON body");
  let body: GdeltResponse;
  try {
    body = JSON.parse(text) as GdeltResponse;
  } catch {
    // Do not echo provider response text into health/events or mistake a
    // plain-text error response for source content.
    throw new Error("GDELT response was not valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)
    || (body.articles != null && !Array.isArray(body.articles))) {
    throw new Error("GDELT response had an invalid shape");
  }
  const providerArticles = body.articles ?? [];
  const providerResultCount = providerArticles.length;
  const saturated = providerResultCount >= maxRecords;
  const out: GdeltArticle[] = [];
  for (const row of providerArticles) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) continue;
    const a = row as GdeltRawArticle;
    if (typeof a.url !== "string" || a.url.trim() === "" || typeof a.title !== "string" || a.title.trim() === "") continue;
    const seenAt = parseSeenDate(typeof a.seendate === "string" ? a.seendate : undefined);
    out.push({
      title: a.title,
      url: a.url,
      domain: typeof a.domain === "string" && a.domain.trim() !== "" ? a.domain : "unknown",
      seenAt: Number.isFinite(seenAt) ? seenAt : null,
    });
  }
  return {
    articles: out,
    providerResultCount,
    requestedLimit: maxRecords,
    saturated,
  };
}
