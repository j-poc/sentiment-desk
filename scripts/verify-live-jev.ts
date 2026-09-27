import { mkdtempSync, rmSync } from "node:fs";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import { serve } from "@hono/node-server";
import { config, VERSION, loadCompanies } from "../server/config.js";
import { createApp } from "../server/app.js";
import { Desk } from "../server/db.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import { JevClient } from "../server/jev.js";
import { MarketData } from "../server/market.js";
import { Pipeline } from "../server/pipeline.js";
import { RUBRIC, RUBRIC_SHA } from "../server/rubric.js";
import type { Company } from "../server/types.js";

const fixtureCompany: Company = {
  id: "jev-live-smoke",
  name: "Jev Live Smoke Fixture",
  ticker: "TEST",
  sector: "Software",
  aliases: ["Jev Smoke Fixture"],
  color: "#34d399",
};

async function main(): Promise<void> {
  if (!config.jev.apiKey) {
    throw new Error("TypeSafe API key is unavailable; live smoke was not run");
  }

  const directory = mkdtempSync(path.join(os.tmpdir(), "sentiment-desk-jev-live-"));
  const dbPath = path.join(directory, "smoke.db");
  const db = new Desk(dbPath);
  const hub = new Hub();
  const health = new HealthTracker(false, true, config.jev.model);
  const companies = [fixtureCompany];
  let server: ReturnType<typeof serve> | undefined;

  try {
    db.seedCompanies(companies);
    // The isolated UI needs local price points to avoid any market-data call.
    // They are synthetic and never enter the user's desk database.
    const now = Date.now();
    for (let i = 0; i < 97; i += 1) {
      db.upsertPricePoint(fixtureCompany.ticker, now - (96 - i) * 15 * 60_000, 100);
    }

    const jev = new JevClient({
      apiKey: config.jev.apiKey,
      baseUrl: config.jev.baseUrl,
      model: config.jev.model,
      timeoutMs: config.jev.timeoutMs,
    });
    const pipeline = new Pipeline({
      db,
      judge: (state) => jev.judge(state, RUBRIC),
      hub,
      health,
      engineLabel: config.jev.model,
      inputPricePerMTok: config.jev.inputPricePerMTok,
      concurrency: 1,
    });

    const inserted = pipeline.ingest({
      companyId: fixtureCompany.id,
      kind: "rss",
      sourceName: "Synthetic smoke fixture — not market data",
      sourceUrl: "https://example.invalid/jev-live-smoke",
      tier: "major",
      title: "Synthetic Jev integration fixture; no real company or event",
      snippet: "This temporary test record exists only to verify the live Jev response and local persistence path.",
      publishedAt: now,
      retrievedAt: now,
      collector: "google_news_rss",
      publisherName: "Synthetic smoke fixture",
      publisherDomain: "example.invalid",
      sourceItemId: `jev-live-smoke-${now}`,
    });
    if (!inserted) throw new Error("Synthetic observation was not newly inserted");

    await pipeline.waitForIdle();
    const record = db.mentionsForCompany(fixtureCompany.id, now - 60_000, 5)[0];
    if (!record?.score || !["scored", "off_target"].includes(record.status)) {
      throw new Error("The live provider response did not persist as a valid Jev judgment");
    }
    if (!/^jev-(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(record.score.engine)) {
      throw new Error("The persisted Jev model ID is not a resolved version");
    }
    if (record.score.rubricSha !== RUBRIC_SHA) {
      throw new Error("The persisted judgment used an unexpected rubric hash");
    }

    const market = new MarketData({ companies, indices: [], hub, health, db });
    const app = createApp({
      db,
      dbPath,
      pipeline,
      market,
      hub,
      health,
      demo: false,
      version: VERSION,
      webRoot: path.resolve("dist/web"),
      deliverySources: [],
    });
    const response = await app.fetch(new Request(
      `http://127.0.0.1/api/companies/${fixtureCompany.id}/mentions?hours=24&limit=10`,
    ));
    const apiRows = await response.json() as Array<{ status: string; score: { engine: string } | null }>;
    if (response.status !== 200 || !apiRows.some((row) => row.score?.engine === record.score?.engine)) {
      throw new Error("The local mentions API did not return the persisted resolved-model judgment");
    }

    server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Smoke UI server did not bind a TCP port");

    console.log(JSON.stringify({
      result: "PASS",
      requestCount: 1,
      providerConfigured: true,
      requestedModel: config.jev.model,
      resolvedModel: record.score.engine,
      judgmentStatus: record.status,
      rubricSha: record.score.rubricSha,
      inputTokens: record.score.inputTokens,
      latencyMs: record.score.latencyMs,
      costUsd: record.score.costUsd,
      persistedAndReturnedByApi: true,
      uiUrl: `http://127.0.0.1:${address.port}/`,
      fixture: "synthetic; no real source text or market data sent",
      database: "temporary SQLite, isolated from data/desk.db",
    }));

    await new Promise<void>((resolve) => {
      let stopping = false;
      const stop = () => {
        if (stopping) return;
        stopping = true;
        hub.closeAll();
        server?.close(() => resolve());
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  const status = typeof error === "object" && error !== null && "status" in error
    ? (error as { status?: unknown }).status
    : undefined;
  console.error(JSON.stringify({
    result: "FAIL",
    providerStatus: typeof status === "number" ? status : null,
    errorType: error instanceof Error ? error.name : "unknown failure",
  }));
  process.exitCode = 1;
});
