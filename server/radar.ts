import { EVENT_TYPES, type EventType } from "./rubric.js";
import type { RadarItemEvidence } from "./types.js";

const SENTIMENTS = ["positive", "neutral", "negative"] as const;
type Sentiment = (typeof SENTIMENTS)[number];
const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES);

export interface RadarHeadlineGroup {
  title: string;
  latestPublishedAt: number;
  sources: RadarItemEvidence[];
}

export interface RadarPeriodSummary {
  sourceRows: number;
  headlineGroups: number;
  publisherCount: number;
  publisherJudgments: number;
  positive: number;
  neutral: number;
  negative: number;
  mixed: number;
}

export interface RadarCategory {
  eventType: EventType;
  current: RadarPeriodSummary;
  previous: RadarPeriodSummary;
  headlineChange: number;
  recentEvidence: RadarHeadlineGroup[];
  previousEvidence: RadarHeadlineGroup[];
}

export interface RadarComparison {
  hours: number;
  generatedAt: number;
  currentFrom: number;
  currentTo: number;
  previousFrom: number;
  previousTo: number;
  current: RadarPeriodSummary;
  previous: RadarPeriodSummary;
  headlineChange: number;
  untimedScored: number;
  unjudged: number;
  unclassified: number;
  categories: RadarCategory[];
}

export function normalizeHeadline(title: string): string {
  return title
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function isRadarEventType(value: string): value is EventType {
  return EVENT_TYPE_SET.has(value);
}

export function radarEvidencePage(input: {
  rows: RadarItemEvidence[];
  eventType: EventType;
  offset: number;
  limit: number;
}): { eventType: EventType; offset: number; total: number; items: RadarHeadlineGroup[] } {
  const rows = validRows(input.rows).rows.filter((row) => row.eventType === input.eventType);
  const groups = headlineGroups(rows);
  return {
    eventType: input.eventType,
    offset: input.offset,
    total: groups.length,
    items: groups.slice(input.offset, input.offset + input.limit),
  };
}

export function buildRadar(input: {
  hours: number;
  now: number;
  currentRows: RadarItemEvidence[];
  previousRows: RadarItemEvidence[];
  untimedScored: number;
  unjudged: number;
}): RadarComparison {
  const current = validRows(input.currentRows);
  const previous = validRows(input.previousRows);
  const categories = EVENT_TYPES.map((eventType) => {
    const currentRows = current.rows.filter((row) => row.eventType === eventType);
    const previousRows = previous.rows.filter((row) => row.eventType === eventType);
    const currentSummary = summarize(currentRows);
    const previousSummary = summarize(previousRows);
    return {
      eventType,
      current: currentSummary,
      previous: previousSummary,
      headlineChange: currentSummary.headlineGroups - previousSummary.headlineGroups,
      recentEvidence: headlineGroups(currentRows).slice(0, 5),
      previousEvidence: headlineGroups(previousRows).slice(0, 5),
    };
  });
  const currentSummary = summarize(current.rows);
  const previousSummary = summarize(previous.rows);

  return {
    hours: input.hours,
    generatedAt: input.now,
    currentFrom: input.now - input.hours * 60 * 60 * 1000,
    currentTo: input.now,
    previousFrom: input.now - input.hours * 2 * 60 * 60 * 1000,
    previousTo: input.now - input.hours * 60 * 60 * 1000,
    current: currentSummary,
    previous: previousSummary,
    headlineChange: currentSummary.headlineGroups - previousSummary.headlineGroups,
    untimedScored: input.untimedScored,
    unjudged: input.unjudged,
    unclassified: current.unclassified + previous.unclassified,
    categories,
  };
}

function validRows(rows: RadarItemEvidence[]): { rows: RadarItemEvidence[]; unclassified: number } {
  const valid: RadarItemEvidence[] = [];
  let unclassified = 0;
  for (const row of rows) {
    if (
      !isRadarEventType(row.eventType) ||
      !isSentiment(row.sentiment) ||
      !Number.isFinite(row.publishedAt) ||
      !Number.isFinite(row.retrievedAt)
    ) {
      unclassified += 1;
      continue;
    }
    valid.push(row);
  }
  return { rows: valid, unclassified };
}

function publisherKey(item: RadarItemEvidence): string {
  const domain = item.publisherDomain?.trim().toLocaleLowerCase("en-US").replace(/^www\./, "");
  if (domain) return `domain:${domain}`;
  const name = item.publisherName.trim().toLocaleLowerCase("en-US");
  return name ? `name:${name}` : `unknown:${item.id}`;
}

function headlineGroups(rows: RadarItemEvidence[]): RadarHeadlineGroup[] {
  const groups = new Map<string, RadarHeadlineGroup>();
  for (const row of rows) {
    const key = normalizeHeadline(row.title) || `untitled:${row.id}`;
    const existing = groups.get(key);
    if (existing) {
      existing.sources.push(row);
      existing.latestPublishedAt = Math.max(existing.latestPublishedAt, row.publishedAt);
    } else {
      groups.set(key, { title: row.title, latestPublishedAt: row.publishedAt, sources: [row] });
    }
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      sources: [...group.sources].sort((a, b) => b.publishedAt - a.publishedAt || b.retrievedAt - a.retrievedAt),
    }))
    .sort((a, b) => b.latestPublishedAt - a.latestPublishedAt || a.title.localeCompare(b.title));
}

function summarize(rows: RadarItemEvidence[]): RadarPeriodSummary {
  const groups = headlineGroups(rows);
  const publishers = new Set<string>();
  const publisherJudgments = new Map<string, Set<Sentiment>>();
  for (const group of groups) {
    for (const row of group.sources) {
      if (!isSentiment(row.sentiment)) continue;
      const publisher = publisherKey(row);
      publishers.add(publisher);
      // Same publisher + same normalized headline through another collector is
      // one judgment for direction, while all source rows remain inspectable.
      const key = `${normalizeHeadline(group.title)}\u0000${publisher}`;
      publisherJudgments.set(key, new Set([...(publisherJudgments.get(key) ?? []), row.sentiment]));
    }
  }
  const directions = { positive: 0, neutral: 0, negative: 0, mixed: 0 };
  for (const sentiments of publisherJudgments.values()) {
    if (sentiments.size !== 1) {
      directions.mixed += 1;
      continue;
    }
    const [sentiment] = sentiments;
    if (sentiment) directions[sentiment] += 1;
  }
  return {
    sourceRows: rows.length,
    headlineGroups: groups.length,
    publisherCount: publishers.size,
    publisherJudgments: publisherJudgments.size,
    ...directions,
  };
}

function isSentiment(value: string): value is Sentiment {
  return value === "positive" || value === "neutral" || value === "negative";
}
