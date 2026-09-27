import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { createApp } from "../server/app.js";
import { Desk } from "../server/db.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import { MarketData } from "../server/market.js";
import { Pipeline } from "../server/pipeline.js";
import { EVENT_TYPES, TAKEAWAY_KEYS } from "../server/rubric.js";
import type { Company, JevState, RawMention } from "../server/types.js";

const company: Company = {
  id: "retry-browser-fixture",
  name: "Retry Browser Fixture",
  ticker: "RBF",
  sector: "Synthetic",
  aliases: [],
  color: "#34d399",
};

function fixtureAnswers(): Record<string, unknown> {
  const choice = (values: readonly string[], selected: string) => ({
    type: "choice",
    choice: selected,
    confidence: 0.9,
    probabilities: Object.fromEntries(values.map((value) => [value, value === selected ? 0.9 : 0.1 / (values.length - 1)])),
  });
  return {
    sentiment: choice(["negative", "neutral", "positive"], "positive"),
    about: { type: "noul", noul: 0.95 },
    investor_relevant: { type: "noul", noul: 0.9 },
    material: { type: "noul", noul: 0.8 },
    novel: { type: "noul", noul: 0.8 },
    credible: { type: "noul", noul: 0.8 },
    event_type: choice(EVENT_TYPES, "product"),
    magnitude: { type: "noul", noul: 0.7 },
    surprise: { type: "noul", noul: 0.6 },
    takeaway: choice(TAKEAWAY_KEYS, "product_win"),
  };
}

async function main(): Promise<void> {
  const directory = mkdtempSync(path.join(os.tmpdir(), "sentiment-desk-retry-browser-"));
  const dbPath = path.join(directory, "fixture.db");
  const db = new Desk(dbPath);
  const hub = new Hub();
  const health = new HealthTracker(false, true, "synthetic-jev-fixture");
  const companies = [company];
  let calls = 0;
  let server: ReturnType<typeof serve> | undefined;

  try {
    db.seedCompanies(companies);
    const now = Date.now();
    const raw: RawMention = {
      companyId: company.id,
      kind: "rss",
      sourceName: "Synthetic retry fixture",
      sourceUrl: "https://example.invalid/retry-browser-fixture",
      tier: "major",
      title: "Synthetic retry fixture reports a product improvement",
      snippet: "Fictional browser workflow data; not market news and not provider output.",
      publishedAt: now,
      retrievedAt: now,
      collector: "google_news_rss",
      sourceItemId: "retry-browser-fixture-item",
      publisherName: "Synthetic retry fixture",
      publisherDomain: "example.invalid",
    };
    const inserted = db.insertObservation(raw);
    if (!inserted.inserted) throw new Error("Synthetic retry fixture was not newly inserted");
    db.markFailed(inserted.observationId, "Synthetic prior timeout; provider outcome is unknown.", true);

    const pipeline = new Pipeline({
      db,
      judge: async (_state: JevState) => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 400));
        return {
          answers: fixtureAnswers(),
          model: "synthetic-jev-fixture",
          inputTokens: 100,
          outputTokens: 20,
          latencyMs: 400,
        };
      },
      hub,
      health,
      engineLabel: "synthetic-jev-fixture",
      inputPricePerMTok: 0,
      concurrency: 1,
    });
    const market = new MarketData({ companies, indices: [], hub, health, db });
    const app = createApp({
      db,
      dbPath,
      pipeline,
      market,
      hub,
      health,
      demo: false,
      version: "retry-browser-fixture",
      webRoot: path.resolve("dist/web"),
      deliverySources: [],
    });

    const mentionResponseDelays = new Map([
      [`/api/companies/${company.id}/mentions`, Number(process.env.RETRY_BROWSER_MENTION_DELAY_MS ?? 15_000)],
      ["/api/tape", Number(process.env.RETRY_BROWSER_TAPE_DELAY_MS ?? 0)],
    ]);
    const delayedSnapshotPaths = new Set<string>();
    const fixtureFetch = async (request: Request): Promise<Response> => {
      const response = await app.fetch(request);
      const requestUrl = new URL(request.url);
      const delayMs = mentionResponseDelays.get(requestUrl.pathname);
      if (delayMs != null && delayMs > 0 && !delayedSnapshotPaths.has(requestUrl.pathname) && request.method === "GET" && response.ok) {
        delayedSnapshotPaths.add(requestUrl.pathname);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      return response;
    };
    server = serve({ fetch: fixtureFetch, hostname: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Retry browser fixture did not bind a TCP port");

    console.log(JSON.stringify({
      result: "READY",
      url: `http://127.0.0.1:${address.port}/`,
      fixture: "one fictional failed item with outcome-unknown usage guard",
      database: "temporary SQLite; no local desk database opened",
      provider: "synthetic in-process judge; no external request or charge",
      race: Object.fromEntries(mentionResponseDelays),
      pid: process.pid,
    }));

    await new Promise<void>((resolve) => {
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        hub.closeAll();
        server?.close(() => resolve());
        server?.closeAllConnections();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    await pipeline.waitForIdle();
    const final = db.mentionsForCompany(company.id, now - 60_000, 5)[0];
    console.log(JSON.stringify({
      result: final?.status === "scored" && calls === 1 ? "PASS" : "FAIL",
      calls,
      finalStatus: final?.status ?? "missing",
      modelLabel: final?.score?.engine ?? null,
      source: "synthetic only",
    }));
    if (final?.status !== "scored" || calls !== 1) process.exitCode = 1;
  } finally {
    if (server?.listening) {
      hub.closeAll();
      server.close();
      server.closeAllConnections();
    }
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ result: "FAIL", error: error instanceof Error ? error.message : "unknown failure" }));
  process.exitCode = 1;
});
