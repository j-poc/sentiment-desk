import { XMLParser } from "fast-xml-parser";
import type { Company, SourceTier } from "../types.js";
import { tierForHost } from "./tiers.js";

/**
 * RSS ingestion. Google News runs one query per company (name OR ticker,
 * bounded to the last 2 days) and needs no key, which makes it the reliable
 * spine of the news firehose. The parser here is pure so tests can pin it
 * against fixture XML.
 */

export interface FeedItem {
  title: string;
  url: string;
  sourceName: string;
  publishedAt: number;
  snippet: string;
  tier: SourceTier;
}

export function googleNewsUrl(company: Company, windowDays = 2): string {
  const query = `"${company.name}" OR "${company.ticker}" when:${windowDays}d`;
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  cdataPropName: "__cdata",
});

export function parseRss(xml: string): FeedItem[] {
  const doc = parser.parse(xml) as {
    rss?: { channel?: { item?: unknown } };
  };
  const rawItems = doc.rss?.channel?.item;
  if (rawItems == null) return [];
  const items = (Array.isArray(rawItems) ? rawItems : [rawItems]) as Array<Record<string, unknown>>;

  const out: FeedItem[] = [];
  for (const item of items) {
    const title = cleanText(asText(item["title"]));
    const link = asText(item["link"]);
    if (!title || !link) continue;

    const sourceNode = item["source"] as Record<string, unknown> | undefined;
    const sourceName =
      cleanText(asText(sourceNode?.["#text"] ?? sourceNode ?? "")) || hostOf(link);

    let clean = title;
    const suffix = ` - ${sourceName}`;
    if (sourceName && clean.endsWith(suffix)) clean = clean.slice(0, -suffix.length);

    const pubRaw = asText(item["pubDate"]);
    const publishedAt = pubRaw ? Date.parse(pubRaw) : NaN;

    out.push({
      title: clean,
      url: link,
      sourceName,
      publishedAt: Number.isFinite(publishedAt) ? publishedAt : Date.now(),
      snippet: cleanText(asText(item["description"])).slice(0, 600),
      tier: tierForHost(sourceNode && typeof sourceNode["@_url"] === "string" ? sourceNode["@_url"] : link),
    });
  }
  return out;
}

export async function fetchFeed(url: string, timeoutMs = 15_000): Promise<FeedItem[]> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": "SentimentDesk/0.1 (+https://github.com; personal research desk)" },
  });
  if (!res.ok) throw new Error(`feed HTTP ${res.status}`);
  return parseRss(await res.text());
}

function asText(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return asText(o["#text"] ?? o["__cdata"]);
  }
  return "";
}

function cleanText(s: string): string {
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/&\w+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}
