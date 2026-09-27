import { once } from "node:events";
import { serve } from "@hono/node-server";
import { describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../server/app.js";
import { Hub } from "../server/hub.js";

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
      demo: false,
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
});
