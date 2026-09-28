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

interface GdeltResponse {
  articles?: Array<{
    url?: string;
    title?: string;
    seendate?: string;
    domain?: string;
    language?: string;
  }>;
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

export async function fetchGdeltArticles(
  query: string,
  timeoutMs = 15_000,
  maxRecords = 25,
): Promise<GdeltArticle[]> {
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
  if (!res.ok) throw new Error(`GDELT HTTP ${res.status}`);
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
  const out: GdeltArticle[] = [];
  for (const a of body.articles ?? []) {
    if (!a.url || !a.title) continue;
    const seenAt = parseSeenDate(a.seendate);
    out.push({
      title: a.title,
      url: a.url,
      domain: a.domain ?? "unknown",
      seenAt: Number.isFinite(seenAt) ? seenAt : null,
    });
  }
  return out;
}
