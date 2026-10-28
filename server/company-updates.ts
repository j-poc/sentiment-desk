import type { CollectorId, Company } from "./types.js";
import type { Desk } from "./db.js";
import type { Pipeline } from "./pipeline.js";
import { classifyDeliveryError, processDeliveryItems, recordDelivery } from "./delivery.js";
import { fetchFeed, googleNewsUrl, yahooFinanceUrl, type FeedFetchResult } from "./sources/rss.js";

type UpdateCollector = "google_news_rss" | "yahoo_finance_rss";
type SourceResult = {
  collector: UpdateCollector;
  state: "updated" | "empty" | "unavailable" | "failed";
  found: number;
  saved: number;
};

export type CompanyUpdatesResult = {
  companyId: string;
  completedAt: number;
  sources: SourceResult[];
};

const feeds: ReadonlyArray<{
  collector: UpdateCollector;
  provider: "google_news" | "yahoo";
  url: (company: Company) => string;
  fallbackName: (company: Company) => string;
}> = [
  { collector: "google_news_rss", provider: "google_news", url: (company) => googleNewsUrl(company), fallbackName: () => "Google News" },
  { collector: "yahoo_finance_rss", provider: "yahoo", url: (company) => yahooFinanceUrl(company), fallbackName: () => "Yahoo Finance" },
];

function matchesCompany(company: Company, title: string, snippet: string): boolean {
  const terms = [...company.aliases, company.name, company.ticker]
    .filter((term) => term.trim().length > 0)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`\\b(?:${terms.join("|")})\\b`, "i").test(`${title} ${snippet}`);
}

export class CompanyUpdatesService {
  private readonly inFlight = new Map<string, Promise<CompanyUpdatesResult>>();

  constructor(private readonly options: {
    db: Desk;
    pipeline: Pipeline;
    allowedCollectors: ReadonlySet<CollectorId>;
    externalRequestsEnabled: boolean;
    now?: () => number;
    fetchFeed?: typeof fetchFeed;
  }) {}

  refresh(companyId: string): Promise<CompanyUpdatesResult> {
    const active = this.inFlight.get(companyId);
    if (active) return active;
    const task = this.refreshOnce(companyId).finally(() => this.inFlight.delete(companyId));
    this.inFlight.set(companyId, task);
    return task;
  }

  private async refreshOnce(companyId: string): Promise<CompanyUpdatesResult> {
    const company = this.options.db.companies().find((item) => item.id === companyId);
    if (!company) throw new Error("unknown_company");
    const now = this.options.now ?? Date.now;
    const fetch = this.options.fetchFeed ?? fetchFeed;
    const sources: SourceResult[] = [];
    for (const feed of feeds) {
      if (!this.options.allowedCollectors.has(feed.collector)) {
        sources.push({ collector: feed.collector, state: "unavailable", found: 0, saved: 0 });
        continue;
      }
      if (!this.options.externalRequestsEnabled || !this.options.db.prepareExternalWork()) {
        sources.push({ collector: feed.collector, state: "unavailable", found: 0, saved: 0 });
        continue;
      }
      const url = feed.url(company);
      const startedAt = now();
      let result: FeedFetchResult = { items: [], providerItemCount: 0, malformedItemCount: 0 };
      let deliveryId: string | null = null;
      try {
        result = await fetch(url);
        const malformedNotice = result.malformedItemCount > 0
          ? `RSS discarded ${result.malformedItemCount} malformed item${result.malformedItemCount === 1 ? "" : "s"}`
          : undefined;
        deliveryId = recordDelivery({
          db: this.options.db,
          collector: feed.collector,
          companyId,
          requestKey: url,
          startedAt,
          adapterVersion: `${feed.collector}/3`,
          result: result.providerItemCount > 0 && result.items.length === 0 ? "invalid"
            : malformedNotice ? "partial"
              : result.providerItemCount === 0 ? "empty" : "success",
          parsedItemCount: result.providerItemCount,
          normalizedItems: result.items,
          error: malformedNotice,
          processingExpected: true,
        });
        let saved = 0;
        processDeliveryItems({ db: this.options.db, deliveryId, expectedCount: result.items.length, process: (itemProcessed) => {
          for (const item of result.items) {
            let inserted = false;
            if (matchesCompany(company, item.title, item.snippet)) {
              inserted = this.options.pipeline.ingestUnscored({
                companyId,
                kind: "rss",
                sourceName: item.sourceName || feed.fallbackName(company),
                publisherName: item.sourceName || feed.fallbackName(company),
                sourceUrl: item.url,
                sourceItemId: item.sourceItemId,
                deliveryId,
                collector: feed.collector,
                adapterVersion: `${feed.collector}/3`,
                tier: item.tier,
                publisherDomain: item.publisherDomain,
                title: item.title,
                snippet: item.snippet,
                publishedAt: item.publishedAt,
                aggregatorPublishedAt: item.aggregatorPublishedAt,
                retrievedAt: now(),
                scoped: feed.collector === "yahoo_finance_rss",
              });
            }
            if (inserted) saved += 1;
            itemProcessed(inserted);
          }
        } });
        sources.push({ collector: feed.collector, state: result.providerItemCount === 0 ? "empty" : "updated", found: result.providerItemCount, saved });
      } catch (error) {
        if (deliveryId == null) recordDelivery({
          db: this.options.db,
          collector: feed.collector,
          companyId,
          requestKey: url,
          startedAt,
          adapterVersion: `${feed.collector}/3`,
          result: classifyDeliveryError(error),
          parsedItemCount: result.providerItemCount,
          normalizedItems: result.items,
          error,
        });
        sources.push({ collector: feed.collector, state: "failed", found: result.providerItemCount, saved: 0 });
      }
    }
    return { companyId, completedAt: now(), sources };
  }
}
