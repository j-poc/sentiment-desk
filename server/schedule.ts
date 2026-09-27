import type { Company } from "./types.js";
import type { Desk } from "./db.js";
import type { HealthTracker } from "./health.js";
import type { Pipeline } from "./pipeline.js";
import { fetchGdeltArticles } from "./sources/gdelt.js";
import { fetchEarningsHistory, fetchFinnhubNews, fetchUpcomingEarnings, latestSurprise } from "./sources/finnhub.js";
import { getRedditToken, searchReddit, type RedditClient } from "./sources/reddit.js";
import { tierForHost } from "./sources/tiers.js";
import { fetchFeed, googleNewsUrl, yahooFinanceUrl } from "./sources/rss.js";
import { searchRecent } from "./sources/x.js";
import { isFinanceRelevant } from "./scoring.js";
import { fetchPrimaryDocText, fetchRecent8Ks, titleForItems } from "./sources/sec.js";
import { generateDemoMention } from "./demo.js";
import { classifyDeliveryError, recordDelivery } from "./delivery.js";
import { scheduleTask, type SchedulerControl } from "./scheduler.js";

/**
 * Polling schedulers. Each source loop is failure-isolated: one company's feed
 * erroring never blocks the others, and failures land in health counters and
 * the events table. The RSS rotation sleeps briefly between companies to stay
 * polite to the feed host.
 */

export function startRssPoller(deps: {
  companies: Company[];
  pipeline: Pipeline;
  db: Desk;
  health: HealthTracker;
  intervalSeconds: number;
  concurrency: number;
}): SchedulerControl {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      // Two feeds per company: Google News for breadth, Yahoo Finance's
      // per-ticker feed for speed. Fetched with a small worker pool so a full
      // sweep completes in seconds, not minutes: detection lag is the product.
      const feeds: Array<{ company: Company; url: string; fallbackName: string; collector: "google_news_rss" | "yahoo_finance_rss" }> = [];
      for (const company of deps.companies) {
        feeds.push({ company, url: googleNewsUrl(company), fallbackName: company.name, collector: "google_news_rss" });
        feeds.push({ company, url: yahooFinanceUrl(company), fallbackName: "Yahoo Finance", collector: "yahoo_finance_rss" });
      }
      let next = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const job = feeds[next];
          next += 1;
          if (!job) return;
          const { company, feed } = { company: job.company, feed: { url: job.url, fallbackName: job.fallbackName, collector: job.collector } };
          const startedAt = Date.now();
          let items: Awaited<ReturnType<typeof fetchFeed>> = [];
          try {
            items = await fetchFeed(feed.url);
            let added = 0;
            let dropped = 0;
            for (const item of items) {
              if (!matchesCompany(company, item.title, item.snippet)) continue;
              if (
                !isFinanceRelevant({
                  title: item.title,
                  snippet: item.snippet,
                  tier: item.tier,
                  kind: "rss",
                  ticker: company.ticker,
                })
              ) {
                dropped += 1;
                continue;
              }
              const inserted = deps.pipeline.ingest({
                companyId: company.id,
                kind: "rss",
                sourceName: item.sourceName || feed.fallbackName,
                publisherName: item.sourceName || feed.fallbackName,
                sourceUrl: item.url,
                sourceItemId: item.sourceItemId,
                collector: feed.collector,
                adapterVersion: `${feed.collector}/2`,
                tier: item.tier,
                title: item.title,
                snippet: item.snippet,
                publishedAt: item.publishedAt,
                retrievedAt: Date.now(),
                scoped: feed.fallbackName === "Yahoo Finance",
              });
              if (inserted) added += 1;
            }
            recordDelivery({
              db: deps.db, collector: feed.collector, companyId: company.id,
              requestKey: feed.url, startedAt, adapterVersion: `${feed.collector}/2`,
              result: items.length === 0 ? "empty" : "success", parsedItemCount: items.length,
              normalizedItems: items,
            });
            deps.health.recordRss(true);
            if (added > 0) {
              deps.db.logEvent("info", "rss", `${company.ticker}: ${added} new mentions`);
            }
            if (dropped > 0) {
              deps.db.logEvent("info", "relevance", `${company.ticker}: ${dropped} dropped by ingest guard`);
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            recordDelivery({
              db: deps.db, collector: feed.collector, companyId: company.id,
              requestKey: feed.url, startedAt, adapterVersion: `${feed.collector}/2`,
              result: items.length > 0 ? "partial" : classifyDeliveryError(err), parsedItemCount: items.length,
              normalizedItems: items, error: err,
            });
            deps.health.recordRss(false, `${company.ticker}: ${message}`);
            deps.db.logEvent("warn", "rss", `${company.ticker}: ${message}`);
          }
          await sleep(120);
        }
      };
      const workers = Array.from({ length: Math.max(1, deps.concurrency) }, () => worker());
      await Promise.all(workers);
    } finally {
      running = false;
    }
  };
  return scheduleTask(tick, deps.intervalSeconds * 1000);
}

export function startXPoller(deps: {
  bearer: string;
  companies: Company[];
  pipeline: Pipeline;
  db: Desk;
  health: HealthTracker;
  intervalSeconds: number;
}): SchedulerControl {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      for (const company of deps.companies) {
        const startedAt = Date.now();
        let posts: Awaited<ReturnType<typeof searchRecent>>["posts"] = [];
        try {
          const sinceId = deps.db.getKv(`x:since:${company.id}`);
          const res = await searchRecent({ bearer: deps.bearer, company, sinceId });
          posts = res.posts;
          if (res.rateLimited) {
            recordDelivery({
              db: deps.db, collector: "x", companyId: company.id,
              requestKey: `x:${company.id}:${sinceId ?? "initial"}`, startedAt,
              adapterVersion: "x-search/1", result: "rate_limited", parsedItemCount: 0,
              error: "X API rate limited this request",
            });
            deps.health.recordX(false, "rate limited");
            deps.db.logEvent("warn", "x", `${company.ticker}: rate limited, pausing this cycle`);
            break;
          }
          let added = 0;
          for (const post of res.posts) {
            if (!matchesCompany(company, post.text)) continue;
            if (
              !isFinanceRelevant({
                title: post.text,
                snippet: "",
                tier: "social",
                kind: "x",
                ticker: company.ticker,
              })
            ) {
              continue;
            }
            const url = `https://x.com/${post.handle}/status/${post.id}`;
            const inserted = deps.pipeline.ingest({
              companyId: company.id,
              kind: "x",
              sourceName: `@${post.handle}`,
              sourceUrl: url,
              tier: "social",
              title: post.text.slice(0, 140),
              snippet: post.text.slice(0, 600),
              publishedAt: Number.isFinite(post.createdAt) ? post.createdAt : null,
              collector: "x",
              sourceItemId: post.id,
              publisherName: `@${post.handle}`,
              publisherDomain: "x.com",
              adapterVersion: "x-search/1",
              retrievedAt: Date.now(),
              scoped: true,
            });
            if (inserted) added += 1;
          }
          recordDelivery({
            db: deps.db, collector: "x", companyId: company.id,
            requestKey: `x:${company.id}:${sinceId ?? "initial"}`, startedAt,
            adapterVersion: "x-search/1", result: posts.length === 0 ? "empty" : "success",
            parsedItemCount: posts.length, normalizedItems: posts,
          });
          if (res.newestId) deps.db.setKv(`x:since:${company.id}`, res.newestId);
          deps.health.recordX(true);
          if (added > 0) deps.db.logEvent("info", "x", `${company.ticker}: ${added} new posts`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          recordDelivery({
            db: deps.db, collector: "x", companyId: company.id,
            requestKey: `x:${company.id}`, startedAt, adapterVersion: "x-search/1",
            result: posts.length > 0 ? "partial" : classifyDeliveryError(err), parsedItemCount: posts.length,
            normalizedItems: posts, error: err,
          });
          deps.health.recordX(false, `${company.ticker}: ${message}`);
          deps.db.logEvent("warn", "x", `${company.ticker}: ${message}`);
        }
        await sleep(300);
      }
    } finally {
      running = false;
    }
  };
  return scheduleTask(tick, deps.intervalSeconds * 1000);
}

/**
 * SEC EDGAR poller: recent 8-Ks per watchlisted company, with the primary
 * document fetched for state text. Filings are ground truth; acceptance
 * timestamps are exchange-accepted instants, not estimates.
 */
export function startSecPoller(deps: {
  companies: Company[];
  cikByTicker: Map<string, string>;
  userAgent: string;
  pipeline: Pipeline;
  db: Desk;
  health: HealthTracker;
  intervalSeconds: number;
}): SchedulerControl {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const since = Date.now() - 3 * 24 * 60 * 60 * 1000;
      for (const company of deps.companies) {
        const cik = deps.cikByTicker.get(company.ticker);
        if (!cik) continue;
        const startedAt = Date.now();
        let filings: Awaited<ReturnType<typeof fetchRecent8Ks>> = [];
        try {
          filings = await fetchRecent8Ks({ cik, ticker: company.ticker, sinceMs: since, userAgent: deps.userAgent });
          let added = 0;
          for (const f of filings) {
            let snippet = "";
            try {
              snippet = await fetchPrimaryDocText(f.primaryDocUrl, deps.userAgent);
            } catch {
              /* scoring proceeds on the item-typed title if the doc fails */
            }
            const url = f.primaryDocUrl || `https://www.sec.gov/Archives/edgar/data/${Number(f.cik)}/${f.accessionNo.replace(/-/g, "")}/`;
            const inserted = deps.pipeline.ingest({
              companyId: company.id,
              kind: "sec",
              scoped: true,
              sourceName: "SEC EDGAR",
              sourceUrl: url,
              tier: "filing",
              title: titleForItems(f.formType, f.items),
              snippet: snippet || `Form ${f.formType}, items ${(f.items.join(", ") || "none")}. Accepted ${new Date(f.acceptanceAt).toISOString()}.`,
              publishedAt: f.acceptanceAt,
              collector: "sec_edgar",
              sourceItemId: f.accessionNo,
              publisherName: "SEC EDGAR",
              publisherDomain: "sec.gov",
              adapterVersion: "sec-submissions/1",
              filedAt: f.filedAt ?? undefined,
              retrievedAt: Date.now(),
            });
            if (inserted) added += 1;
          }
          recordDelivery({
            db: deps.db, collector: "sec_edgar", companyId: company.id,
            requestKey: `sec:${cik}:8-k:${since}`, startedAt, adapterVersion: "sec-submissions/1",
            result: filings.length === 0 ? "empty" : "success", parsedItemCount: filings.length,
            normalizedItems: filings,
          });
          deps.health.recordSec(true);
          if (added > 0) deps.db.logEvent("info", "sec", `${company.ticker}: ${added} new 8-K filings`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          recordDelivery({
            db: deps.db, collector: "sec_edgar", companyId: company.id,
            requestKey: `sec:${cik}:8-k:${since}`, startedAt, adapterVersion: "sec-submissions/1",
            result: filings.length > 0 ? "partial" : classifyDeliveryError(err), parsedItemCount: filings.length,
            normalizedItems: filings, error: err,
          });
          deps.health.recordSec(false, `${company.ticker}: ${message}`);
          deps.db.logEvent("warn", "sec", `${company.ticker}: ${message}`);
        }
        await sleep(150); // SEC fair-access pacing: ~6.7 req/s ceiling
      }
    } finally {
      running = false;
    }
  };
  return scheduleTask(tick, deps.intervalSeconds * 1000);
}

/**
 * GDELT poller: slow, spaced, breadth-only. Two seconds between companies so
 * a full 24-name rotation takes under a minute against a 5-minute cycle.
 */
export function startGdeltPoller(deps: {
  companies: Company[];
  pipeline: Pipeline;
  db: Desk;
  health: HealthTracker;
  intervalSeconds: number;
}): SchedulerControl {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      for (const company of deps.companies) {
        const startedAt = Date.now();
        let articles: Awaited<ReturnType<typeof fetchGdeltArticles>> = [];
        try {
          const query = `"${company.name}" OR "${company.ticker}"`;
          articles = await fetchGdeltArticles(query);
          let added = 0;
          let dropped = 0;
          for (const a of articles) {
            if (!matchesCompany(company, a.title)) continue;
            if (
              !isFinanceRelevant({
                title: a.title,
                snippet: "",
                tier: tierForHost(a.url),
                kind: "rss",
                ticker: company.ticker,
              })
            ) {
              dropped += 1;
              continue;
            }
            const inserted = deps.pipeline.ingest({
              companyId: company.id,
              kind: "rss",
              sourceName: a.domain,
              sourceUrl: a.url,
              tier: tierForHost(a.url),
              title: a.title,
              snippet: "",
              publishedAt: null,
              providerObservedAt: a.seenAt,
              collector: "gdelt_doc_api",
              sourceItemId: a.url,
              publisherName: a.domain,
              publisherDomain: a.domain,
              adapterVersion: "gdelt-doc/1",
              retrievedAt: Date.now(),
              scoped: false,
            });
            if (inserted) added += 1;
          }
          recordDelivery({
            db: deps.db, collector: "gdelt_doc_api", companyId: company.id,
            requestKey: `gdelt:${query}`, startedAt, adapterVersion: "gdelt-doc/1",
            result: articles.length === 0 ? "empty" : "success", parsedItemCount: articles.length,
            normalizedItems: articles,
          });
          deps.health.recordRss(true);
          if (added > 0) deps.db.logEvent("info", "gdelt", `${company.ticker}: ${added} new`);
          if (dropped > 0) deps.db.logEvent("info", "relevance", `gdelt ${company.ticker}: ${dropped} dropped`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          recordDelivery({
            db: deps.db, collector: "gdelt_doc_api", companyId: company.id,
            requestKey: `gdelt:${company.id}`, startedAt, adapterVersion: "gdelt-doc/1",
            result: articles.length > 0 ? "partial" : classifyDeliveryError(err), parsedItemCount: articles.length,
            normalizedItems: articles, error: err,
          });
          deps.health.recordRss(false, `gdelt ${company.ticker}: ${message}`);
          deps.db.logEvent("warn", "gdelt", `${company.ticker}: ${message}`);
        }
        await sleep(2_000);
      }
    } finally {
      running = false;
    }
  };
  return scheduleTask(tick, deps.intervalSeconds * 1000);
}

/**
 * Finnhub poller: per-symbol company news on the fast clock, and a slow
 * earnings refresh (latest EPS surprise + upcoming calendar) stored in kv so
 * snapshots can carry measured surprise instead of model guesses.
 */
export function startFinnhubPoller(deps: {
  companies: Company[];
  token: string;
  pipeline: Pipeline;
  db: Desk;
  health: HealthTracker;
  intervalSeconds: number;
  backfillDays: number;
}): SchedulerControl {
  let running = false;
  let lastEarningsRefresh = 0;
  let backfilled = false;
  const runBackfill = async (): Promise<void> => {
    if (backfilled || deps.backfillDays <= 0) return;
    backfilled = true;
    for (const company of deps.companies) {
      const startedAt = Date.now();
      let news: Awaited<ReturnType<typeof fetchFinnhubNews>> = [];
      try {
        news = await fetchFinnhubNews(company.ticker, deps.token, deps.backfillDays);
        let added = 0;
        for (const n of news) {
          if (!matchesCompany(company, n.headline, n.summary)) continue;
          if (
            !isFinanceRelevant({
              title: n.headline,
              snippet: n.summary,
              tier: tierForHost(n.url),
              kind: "finnhub",
              ticker: company.ticker,
            })
          ) {
            continue;
          }
          const inserted = deps.pipeline.ingest({
            companyId: company.id,
            kind: "finnhub",
            sourceName: n.source,
            sourceUrl: n.url,
            tier: tierForHost(n.url),
            title: n.headline,
            snippet: n.summary,
            publishedAt: n.datetime,
            collector: "finnhub",
            sourceItemId: n.url,
            publisherName: n.source,
            adapterVersion: "finnhub-news/1",
            retrievedAt: Date.now(),
          });
          if (inserted) added += 1;
        }
        recordDelivery({
          db: deps.db, collector: "finnhub", companyId: company.id,
          requestKey: `finnhub:${company.ticker}:backfill:${deps.backfillDays}`, startedAt,
          adapterVersion: "finnhub-news/1", result: news.length === 0 ? "empty" : "success",
          parsedItemCount: news.length, normalizedItems: news,
        });
        deps.db.logEvent("info", "backfill", `${company.ticker}: ${added} historical mentions`);
      } catch (err) {
        recordDelivery({
          db: deps.db, collector: "finnhub", companyId: company.id,
          requestKey: `finnhub:${company.ticker}:backfill:${deps.backfillDays}`, startedAt,
          adapterVersion: "finnhub-news/1", result: news.length > 0 ? "partial" : classifyDeliveryError(err),
          parsedItemCount: news.length, normalizedItems: news, error: err,
        });
        deps.db.logEvent("warn", "backfill", `${company.ticker}: ${err instanceof Error ? err.message : String(err)}`);
      }
      await sleep(300);
    }
  };
  const refreshEarnings = async (): Promise<void> => {
    const symbols = new Set(deps.companies.map((c) => c.ticker));
    const calendarStartedAt = Date.now();
    try {
      const upcoming = await fetchUpcomingEarnings(deps.token, symbols);
      for (const company of deps.companies) {
        const at = upcoming.get(company.ticker);
        if (at) deps.db.setKv(`finnhub:earnings:${company.id}`, String(at));
      }
      recordDelivery({
        db: deps.db, collector: "finnhub", companyId: null,
        requestKey: `finnhub:earnings-calendar:${[...symbols].sort().join(",")}`,
        startedAt: calendarStartedAt, adapterVersion: "finnhub-calendar/1",
        result: upcoming.size === 0 ? "empty" : "success", parsedItemCount: upcoming.size,
        normalizedItems: [...upcoming.entries()],
      });
      deps.health.recordFinnhub(true);
    } catch (err) {
      recordDelivery({
        db: deps.db, collector: "finnhub", companyId: null,
        requestKey: `finnhub:earnings-calendar:${[...symbols].sort().join(",")}`,
        startedAt: calendarStartedAt, adapterVersion: "finnhub-calendar/1",
        result: classifyDeliveryError(err), parsedItemCount: 0, error: err,
      });
      deps.health.recordFinnhub(false, `calendar: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const company of deps.companies) {
      const startedAt = Date.now();
      let entries: Awaited<ReturnType<typeof fetchEarningsHistory>> = [];
      try {
        entries = await fetchEarningsHistory(company.ticker, deps.token);
        const surprise = latestSurprise(entries);
        if (surprise) deps.db.setKv(`finnhub:surprise:${company.id}`, JSON.stringify(surprise));
        recordDelivery({
          db: deps.db, collector: "finnhub", companyId: company.id,
          requestKey: `finnhub:earnings-history:${company.ticker}`, startedAt,
          adapterVersion: "finnhub-earnings/1", result: entries.length === 0 ? "empty" : "success",
          parsedItemCount: entries.length, normalizedItems: entries,
        });
        deps.health.recordFinnhub(true);
      } catch (err) {
        recordDelivery({
          db: deps.db, collector: "finnhub", companyId: company.id,
          requestKey: `finnhub:earnings-history:${company.ticker}`, startedAt,
          adapterVersion: "finnhub-earnings/1", result: entries.length > 0 ? "partial" : classifyDeliveryError(err),
          parsedItemCount: entries.length, normalizedItems: entries, error: err,
        });
        deps.health.recordFinnhub(false, `${company.ticker}: ${err instanceof Error ? err.message : String(err)}`);
      }
      await sleep(300);
    }
    lastEarningsRefresh = Date.now();
  };
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await runBackfill();
      if (Date.now() - lastEarningsRefresh > 6 * 60 * 60 * 1000) {
        await refreshEarnings();
      }
      for (const company of deps.companies) {
        const startedAt = Date.now();
        let news: Awaited<ReturnType<typeof fetchFinnhubNews>> = [];
        try {
          news = await fetchFinnhubNews(company.ticker, deps.token);
          let added = 0;
          let dropped = 0;
          for (const n of news) {
            if (!matchesCompany(company, n.headline, n.summary)) continue;
            if (
              !isFinanceRelevant({
                title: n.headline,
                snippet: n.summary,
                tier: tierForHost(n.url),
                kind: "finnhub",
                ticker: company.ticker,
              })
            ) {
              dropped += 1;
              continue;
            }
            const inserted = deps.pipeline.ingest({
              companyId: company.id,
              kind: "finnhub",
              sourceName: n.source,
              sourceUrl: n.url,
              tier: tierForHost(n.url),
              title: n.headline,
              snippet: n.summary,
              publishedAt: n.datetime,
              collector: "finnhub",
              sourceItemId: n.url,
              publisherName: n.source,
              adapterVersion: "finnhub-news/1",
              retrievedAt: Date.now(),
              scoped: true,
            });
            if (inserted) added += 1;
          }
          recordDelivery({
            db: deps.db, collector: "finnhub", companyId: company.id,
            requestKey: `finnhub:${company.ticker}:recent`, startedAt,
            adapterVersion: "finnhub-news/1", result: news.length === 0 ? "empty" : "success",
            parsedItemCount: news.length, normalizedItems: news,
          });
          deps.health.recordFinnhub(true);
          if (added > 0) deps.db.logEvent("info", "finnhub", `${company.ticker}: ${added} new`);
          if (dropped > 0) deps.db.logEvent("info", "relevance", `finnhub ${company.ticker}: ${dropped} dropped`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          recordDelivery({
            db: deps.db, collector: "finnhub", companyId: company.id,
            requestKey: `finnhub:${company.ticker}:recent`, startedAt,
            adapterVersion: "finnhub-news/1", result: news.length > 0 ? "partial" : classifyDeliveryError(err),
            parsedItemCount: news.length, normalizedItems: news, error: err,
          });
          deps.health.recordFinnhub(false, `${company.ticker}: ${message}`);
          deps.db.logEvent("warn", "finnhub", `${company.ticker}: ${message}`);
        }
        await sleep(250);
      }
    } finally {
      running = false;
    }
  };
  return scheduleTask(tick, deps.intervalSeconds * 1000);
}

/** Reddit poller: social search per company with cached OAuth tokens. */
export function startRedditPoller(deps: {
  companies: Company[];
  creds: { clientId: string; clientSecret: string };
  pipeline: Pipeline;
  db: Desk;
  health: HealthTracker;
  intervalSeconds: number;
}): SchedulerControl {
  let running = false;
  let client: RedditClient | null = null;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      try {
        client = await getRedditToken(deps.creds, client ?? undefined);
      } catch (err) {
        recordDelivery({
          db: deps.db, collector: "reddit", companyId: null, requestKey: "reddit:oauth",
          startedAt: Date.now(), adapterVersion: "reddit-oauth/1",
          result: classifyDeliveryError(err), parsedItemCount: 0, error: err,
        });
        deps.health.recordReddit(false, err instanceof Error ? err.message : String(err));
        return;
      }
      for (const company of deps.companies) {
        const active = client;
        if (!active) break;
        const startedAt = Date.now();
        let posts: Awaited<ReturnType<typeof searchReddit>> = [];
        try {
          const query = `"${company.name}" OR "$${company.ticker}"`;
          posts = await searchReddit(active, query);
          let added = 0;
          let dropped = 0;
          for (const p of posts) {
            if (!matchesCompany(company, p.title, p.selftext)) continue;
            if (
              !isFinanceRelevant({
                title: p.title,
                snippet: p.selftext,
                tier: "social",
                kind: "reddit",
                ticker: company.ticker,
              })
            ) {
              dropped += 1;
              continue;
            }
            const inserted = deps.pipeline.ingest({
              companyId: company.id,
              kind: "reddit",
              sourceName: `r/${p.subreddit}`,
              sourceUrl: p.permalink,
              tier: "social",
              title: p.title,
              snippet: p.selftext,
              publishedAt: Number.isFinite(p.createdAt) ? p.createdAt : null,
              collector: "reddit",
              sourceItemId: p.id,
              publisherName: `r/${p.subreddit}`,
              publisherDomain: "reddit.com",
              adapterVersion: "reddit-search/1",
              retrievedAt: Date.now(),
              scoped: true,
            });
            if (inserted) added += 1;
          }
          recordDelivery({
            db: deps.db, collector: "reddit", companyId: company.id,
            requestKey: `reddit:${company.id}:${query}`, startedAt,
            adapterVersion: "reddit-search/1", result: posts.length === 0 ? "empty" : "success",
            parsedItemCount: posts.length, normalizedItems: posts,
          });
          deps.health.recordReddit(true);
          if (added > 0) deps.db.logEvent("info", "reddit", `${company.ticker}: ${added} new`);
          if (dropped > 0) deps.db.logEvent("info", "relevance", `reddit ${company.ticker}: ${dropped} dropped`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          recordDelivery({
            db: deps.db, collector: "reddit", companyId: company.id,
            requestKey: `reddit:${company.id}`, startedAt, adapterVersion: "reddit-search/1",
            result: posts.length > 0 ? "partial" : classifyDeliveryError(err), parsedItemCount: posts.length,
            normalizedItems: posts, error: err,
          });
          deps.health.recordReddit(false, `${company.ticker}: ${message}`);
          client = null; // force token refresh next cycle
          deps.db.logEvent("warn", "reddit", `${company.ticker}: ${message}`);
        }
        await sleep(1_500);
      }
    } finally {
      running = false;
    }
  };
  return scheduleTask(tick, deps.intervalSeconds * 1000);
}

export function startDemoLoop(deps: { companies: Company[]; pipeline: Pipeline }): SchedulerControl {
  return scheduleTask(() => {
    if (Math.random() < 0.72) {
      void deps.pipeline.ingest(generateDemoMention(deps.companies));
    }
  }, 5_000, { immediate: false });
}

export function startJevRetryPoller(pipeline: Pipeline): SchedulerControl {
  return scheduleTask(() => { pipeline.drainPending(5_000); }, 15_000, { immediate: false });
}

/**
 * Company match guard with word boundaries, so "AAL" does not match "AALIANT"
 * and "Meta" does not match "metabolic". Compiled per call; watchlists are
 * small and cycles are seconds apart.
 */
export function matchesCompany(company: Company, ...texts: string[]): boolean {
  const hay = texts.join(" ");
  const words = [...company.aliases, company.name, company.ticker].map(escapeRegex);
  const re = new RegExp(`\\b(?:${words.join("|")})\\b`, "i");
  return re.test(hay);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
