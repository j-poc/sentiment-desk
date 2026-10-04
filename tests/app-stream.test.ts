import { once } from "node:events";
import { serve } from "@hono/node-server";
import { describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../server/app.js";
import { Hub } from "../server/hub.js";
import { TestDesk as Desk } from "./test-desk.js";
import { loadCompanies } from "../server/config.js";

describe("SSE shutdown", () => {
  it("lets the HTTP server close with an active stream and removes its hub client", async () => {
    const hub = new Hub();
    const app = createApp({
      db: {} as AppDeps["db"],
      dbPath: "/nonexistent/desk.db",
      pipeline: {} as AppDeps["pipeline"],
      market: {} as AppDeps["market"],
      hub,
      health: {} as AppDeps["health"],
      version: "test",
      webRoot: "/nonexistent/web",
      deliverySources: [],
    });

    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    try {
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("HTTP server did not bind an ephemeral port");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/stream`);
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      expect(reader).toBeDefined();
      const first = await reader!.read();
      expect(new TextDecoder().decode(first.value)).toContain("event: hello");
      expect(hub.size).toBe(1);

      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      hub.closeAll();
      const endResult = await Promise.race([
        reader!.read().then((value) => value.done),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ]);
      expect(endResult).toBe(true);
      if ("closeAllConnections" in server) server.closeAllConnections();
      const completed = await Promise.race([
        closed.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 1_000)),
      ]);
      expect(completed).toBe(true);
      expect(hub.size).toBe(0);
    } finally {
      if ("closeAllConnections" in server) server.closeAllConnections();
    }
  });

  it("attaches the current analyst disposition to later live source updates without sending the note", async () => {
    const hub = new Hub();
    const db = new Desk(":memory:");
    const company = loadCompanies().find((candidate) => candidate.ticker === "AAPL")!;
    db.seedCompanies([company]);
    const source = db.insertObservation({
      companyId: company.id, kind: "rss", sourceName: "Example Publisher",
      sourceUrl: "https://news.google.com/rss/articles/stream-review", tier: "major",
      title: "Quarterly operating update", snippet: "Isolated stream-test fixture.",
      publishedAt: 1_790_000_000_000, retrievedAt: 1_790_000_000_100,
      collector: "google_news_rss", publisherName: "Example Publisher", publisherDomain: "example.com",
      sourceItemId: "stream-review",
    });
    const review = db.saveAnalystSourceReview({
      observationId: source.observationId,
      companyId: company.id,
      disposition: "dismissed",
      nextQuestion: "Private analyst note must not enter the stream.",
    })!;
    const app = createApp({
      db,
      dbPath: "/nonexistent/desk.db",
      pipeline: {} as AppDeps["pipeline"],
      market: {} as AppDeps["market"],
      hub,
      health: {} as AppDeps["health"],
      version: "test",
      webRoot: "/nonexistent/web",
      deliverySources: [],
    });
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("HTTP server did not bind an ephemeral port");
      const response = await fetch(`http://127.0.0.1:${address.port}/api/stream`);
      reader = response.body?.getReader();
      expect(reader).toBeDefined();
      expect(new TextDecoder().decode((await reader!.read()).value)).toContain("event: hello");

      hub.broadcast("mention", { ...source, id: source.observationId });
      const live = new TextDecoder().decode((await reader!.read()).value);
      expect(live).toContain('event: mention');
      expect(live).toContain('"analystResearchDisposition":"dismissed"');
      expect(live).toContain(`"analystResearchDispositionUpdatedAt":${review.updatedAt}`);
      expect(live).not.toContain("Private analyst note");
    } finally {
      hub.closeAll();
      await reader?.cancel().catch(() => undefined);
      if ("closeAllConnections" in server) server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
    }
  });
});
