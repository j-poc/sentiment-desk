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
import { isFinanceRelevant, mentionDigest } from "./scoring.js";
import { fetchPrimaryDocText, fetchRecent8Ks, titleForItems } from "./sources/sec.js";
import { generateDemoMention } from "./demo.js";

/**
 * Polling schedulers. Each source loop is failure-isolated: one company's feed
 * erroring never blocks the others, and failures land in health counters and
 * the events table. The RSS rotation sleeps briefly between companies to stay
 * polite to the feed host.
 */

export interface SchedulerControl {
  stop(): void;
}

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
      const feeds: Array<{ company: Company; url: string; fallbackName: string }> = [];
      for (const company of deps.companies) {
        feeds.push({ company, url: googleNewsUrl(company), fallbackName: company.name });
        feeds.push({ company, url: yahooFinanceUrl(company), fallbackName: "Yahoo Finance" });
      }
      let next = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const job = feeds[next];
          next += 1;
          if (!job) return;
          const { company, feed } = { company: job.company, feed: { url: job.url, fallbackName: job.fallbackName } };
          try {
            const items = await fetchFeed(feed.url);
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
                sourceUrl: item.url,
                tier: item.tier,
                title: item.title,
                snippet: item.snippet,
                publishedAt: item.publishedAt,
                retrievedAt: Date.now(),
                scoped: feed.fallbackName === "Yahoo Finance",
                digest: mentionDigest("rss", item.url, item.title),
              });
              if (inserted) added += 1;
            }
            deps.health.recordRss(true);
            if (added > 0) {
              deps.db.logEvent("info", "rss", `${company.ticker}: ${added} new mentions`);
            }
            if (dropped > 0) {
              deps.db.logEvent("info", "relevance", `${company.ticker}: ${dropped} dropped by ingest guard`);
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
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
  const timer = setInterval(() => void tick(), deps.intervalSeconds * 1000);
  void tick();
  return { stop: () => clearInterval(timer) };
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
        try {
          const sinceId = deps.db.getKv(`x:since:${company.id}`);
          const res = await searchRecent({ bearer: deps.bearer, company, sinceId });
          if (res.rateLimited) {
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
              publishedAt: Number.isFinite(post.createdAt) ? post.createdAt : Date.now(),
              retrievedAt: Date.now(),
              scoped: true,
              digest: mentionDigest("x", url, post.text),
            });
            if (inserted) added += 1;
          }
          if (res.newestId) deps.db.setKv(`x:since:${company.id}`, res.newestId);
          deps.health.recordX(true);
          if (added > 0) deps.db.logEvent("info", "x", `${company.ticker}: ${added} new posts`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          deps.health.recordX(false, `${company.ticker}: ${message}`);
          deps.db.logEvent("warn", "x", `${company.ticker}: ${message}`);
        }
        await sleep(300);
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), deps.intervalSeconds * 1000);
  void tick();
  return { stop: () => clearInterval(timer) };
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
        try {
          const filings = await fetchRecent8Ks({ cik, ticker: company.ticker, sinceMs: since, userAgent: deps.userAgent });
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
              filedAt: Number.isFinite(f.filedAt) ? f.filedAt : undefined,
              retrievedAt: Date.now(),
              digest: mentionDigest("sec", f.accessionNo, f.items.join(",")),
            });
            if (inserted) added += 1;
          }
          deps.health.recordSec(true);
          if (added > 0) deps.db.logEvent("info", "sec", `${company.ticker}: ${added} new 8-K filings`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          deps.health.recordSec(false, `${company.ticker}: ${message}`);
          deps.db.logEvent("warn", "sec", `${company.ticker}: ${message}`);
        }
        await sleep(150); // SEC fair-access pacing: ~6.7 req/s ceiling
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), deps.intervalSeconds * 1000);
  void tick();
  return { stop: () => clearInterval(timer) };
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
        try {
          const articles = await fetchGdeltArticles(`"${company.name}" OR "${company.ticker}"`);
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
              publishedAt: a.seenAt,
              retrievedAt: Date.now(),
              scoped: false,
              digest: mentionDigest("gdelt", a.url, a.title),
            });
            if (inserted) added += 1;
          }
          deps.health.recordRss(true);
          if (added > 0) deps.db.logEvent("info", "gdelt", `${company.ticker}: ${added} new`);
          if (dropped > 0) deps.db.logEvent("info", "relevance", `gdelt ${company.ticker}: ${dropped} dropped`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          deps.health.recordRss(false, `gdelt ${company.ticker}: ${message}`);
          deps.db.logEvent("warn", "gdelt", `${company.ticker}: ${message}`);
        }
        await sleep(2_000);
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), deps.intervalSeconds * 1000);
  void tick();
  return { stop: () => clearInterval(timer) };
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
      try {
        const news = await fetchFinnhubNews(company.ticker, deps.token, deps.backfillDays);
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
            publishedAt: n.datetime || Date.now(),
            retrievedAt: Date.now(),
            digest: mentionDigest("finnhub", n.url, n.headline),
          });
          if (inserted) added += 1;
        }
        deps.db.logEvent("info", "backfill", `${company.ticker}: ${added} historical mentions`);
      } catch (err) {
        deps.db.logEvent("warn", "backfill", `${company.ticker}: ${err instanceof Error ? err.message : String(err)}`);
      }
      await sleep(300);
    }
  };
  const refreshEarnings = async (): Promise<void> => {
    const symbols = new Set(deps.companies.map((c) => c.ticker));
    try {
      const upcoming = await fetchUpcomingEarnings(deps.token, symbols);
      for (const company of deps.companies) {
        const at = upcoming.get(company.ticker);
        if (at) deps.db.setKv(`finnhub:earnings:${company.id}`, String(at));
      }
      deps.health.recordFinnhub(true);
    } catch (err) {
      deps.health.recordFinnhub(false, `calendar: ${err instanceof Error ? err.message : String(err)}`);
    }
    for (const company of deps.companies) {
      try {
        const entries = await fetchEarningsHistory(company.ticker, deps.token);
        const surprise = latestSurprise(entries);
        if (surprise) deps.db.setKv(`finnhub:surprise:${company.id}`, JSON.stringify(surprise));
        deps.health.recordFinnhub(true);
      } catch (err) {
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
        try {
          const news = await fetchFinnhubNews(company.ticker, deps.token);
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
              publishedAt: n.datetime || Date.now(),
              retrievedAt: Date.now(),
              scoped: true,
              digest: mentionDigest("finnhub", n.url, n.headline),
            });
            if (inserted) added += 1;
          }
          deps.health.recordFinnhub(true);
          if (added > 0) deps.db.logEvent("info", "finnhub", `${company.ticker}: ${added} new`);
          if (dropped > 0) deps.db.logEvent("info", "relevance", `finnhub ${company.ticker}: ${dropped} dropped`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          deps.health.recordFinnhub(false, `${company.ticker}: ${message}`);
          deps.db.logEvent("warn", "finnhub", `${company.ticker}: ${message}`);
        }
        await sleep(250);
      }
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), deps.intervalSeconds * 1000);
  void tick();
  return { stop: () => clearInterval(timer) };
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
        deps.health.recordReddit(false, err instanceof Error ? err.message : String(err));
        return;
      }
      for (const company of deps.companies) {
        const active = client;
        if (!active) break;
        try {
          const posts = await searchReddit(active, `"${company.name}" OR "$${company.ticker}"`);
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
              publishedAt: p.createdAt || Date.now(),
              retrievedAt: Date.now(),
              scoped: true,
              digest: mentionDigest("reddit", p.permalink, p.title),
            });
            if (inserted) added += 1;
          }
          deps.health.recordReddit(true);
          if (added > 0) deps.db.logEvent("info", "reddit", `${company.ticker}: ${added} new`);
          if (dropped > 0) deps.db.logEvent("info", "relevance", `reddit ${company.ticker}: ${dropped} dropped`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
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
  const timer = setInterval(() => void tick(), deps.intervalSeconds * 1000);
  void tick();
  return { stop: () => clearInterval(timer) };
}

export function startDemoLoop(deps: { companies: Company[]; pipeline: Pipeline }): SchedulerControl {
  const timer = setInterval(() => {
    if (Math.random() < 0.72) {
      void deps.pipeline.ingest(generateDemoMention(deps.companies));
    }
  }, 5_000);
  return { stop: () => clearInterval(timer) };
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
