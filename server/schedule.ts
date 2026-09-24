import type { Company } from "./types.js";
import type { Desk } from "./db.js";
import type { HealthTracker } from "./health.js";
import type { Pipeline } from "./pipeline.js";
import { fetchFeed, googleNewsUrl } from "./sources/rss.js";
import { searchRecent } from "./sources/x.js";
import { mentionDigest } from "./scoring.js";
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
}): SchedulerControl {
  let running = false;
  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      for (const company of deps.companies) {
        try {
          const items = await fetchFeed(googleNewsUrl(company));
          let added = 0;
          for (const item of items) {
            if (!matchesCompany(company, item.title, item.snippet)) continue;
            const inserted = deps.pipeline.ingest({
              companyId: company.id,
              kind: "rss",
              sourceName: item.sourceName,
              sourceUrl: item.url,
              tier: item.tier,
              title: item.title,
              snippet: item.snippet,
              publishedAt: item.publishedAt,
              retrievedAt: Date.now(),
              digest: mentionDigest("rss", item.url, item.title),
            });
            if (inserted) added += 1;
          }
          deps.health.recordRss(true);
          if (added > 0) {
            deps.db.logEvent("info", "rss", `${company.ticker}: ${added} new mentions`);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          deps.health.recordRss(false, `${company.ticker}: ${message}`);
          deps.db.logEvent("warn", "rss", `${company.ticker}: ${message}`);
        }
        await sleep(400);
      }
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
