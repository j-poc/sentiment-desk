import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createApp, type AppDeps } from "../server/app.js";
import { TestDesk as Desk } from "./test-desk.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";

const directories: string[] = [];

function createFixture(options: {
  loopbackBound?: boolean;
  externalRequestsEnabled?: boolean;
  connected?: boolean;
  modelAvailable?: boolean;
  callbackOk?: boolean;
  activate?: boolean;
  localOrigin?: string;
  redirectUri?: string;
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-plan-routes-"));
  directories.push(directory);
  const dbPath = join(directory, "desk.sqlite");
  const db = new Desk(dbPath);
  const beginAuthorization = vi.fn(async () => ({ flowId: "flow-test", authorizationUrl: "https://auth.example/authorize?state=test" }));
  const completeCallback = vi.fn(async () => ({ ok: options.callbackOk ?? true, message: "OAuth callback handled." }));
  const disconnect = vi.fn(async () => ({ revoked: true }));
  const checkModelAccess = vi.fn(async () => ({ modelAvailable: options.modelAvailable ?? true }));
  const activate = vi.fn(async () => options.activate ?? true);
  const deactivate = vi.fn();
  const isConnected = vi.fn(async () => options.connected ?? false);
  const chatgptPlan: NonNullable<AppDeps["chatgptPlan"]> = {
    loopbackBound: options.loopbackBound ?? true,
    localOrigin: options.localOrigin ?? "http://localhost:8794",
    redirectUri: options.redirectUri ?? "http://localhost:8794/auth/callback",
    auth: {
      isConnected,
      beginAuthorization,
      completeCallback,
      disconnect,
    },
    responses: { checkModelAccess },
    enabled: vi.fn(() => false),
    modelAvailable: vi.fn(() => options.modelAvailable ?? null),
    blockedReason: vi.fn(() => "Sign in to ChatGPT to enable GPT-6 Luna."),
    sources: ["google_news_rss", "yahoo_finance_rss"],
    dailyRequestLimit: 3,
    dailyByteLimit: 65_536,
    activate,
    deactivate,
  };
  const app = createApp({
    db, dbPath,
    pipeline: { snapshots: () => [] } as unknown as AppDeps["pipeline"],
    market: {} as AppDeps["market"], hub: new Hub(),
    health: new HealthTracker(false, false, "unconfigured", false, false, false, options.externalRequestsEnabled ?? true),
    version: "test", deliverySources: [], chatgptPlan,
  });
  return { app, db, chatgptPlan, beginAuthorization, completeCallback, disconnect, isConnected, checkModelAccess, activate, deactivate };
}

const localHeaders = { origin: "http://localhost:8794", "content-type": "application/json" };

describe("ChatGPT plan OAuth routes", () => {
  it("denies connect outside loopback configuration and rejects a foreign origin", async () => {
    const remote = createFixture({ loopbackBound: false });
    const foreign = createFixture();
    try {
      const remoteResponse = await remote.app.request("http://localhost:8794/api/chatgpt-plan/connect", { method: "POST", headers: localHeaders, body: "{}" });
      expect(remoteResponse.status).toBe(403);
      expect(await remoteResponse.json()).toEqual({ error: "loopback_only" });

      const foreignResponse = await foreign.app.request("http://localhost:8794/api/chatgpt-plan/connect", {
        method: "POST", headers: { ...localHeaders, origin: "https://attacker.invalid" }, body: "{}",
      });
      expect(foreignResponse.status).toBe(403);
      expect(await foreignResponse.json()).toEqual({ error: "origin_not_allowed" });
      expect(foreign.beginAuthorization).not.toHaveBeenCalled();
    } finally { remote.db.close(); foreign.db.close(); }
  });

  it("does not begin OAuth while external requests are disabled", async () => {
    const fixture = createFixture({ externalRequestsEnabled: false });
    try {
      const response = await fixture.app.request("http://localhost:8794/api/chatgpt-plan/connect", { method: "POST", headers: localHeaders, body: "{}" });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: "external_requests_disabled" });
      expect(fixture.beginAuthorization).not.toHaveBeenCalled();
    } finally { fixture.db.close(); }
  });

  it("reports connection, selected sources, local request and byte limits, and saved plan usage without caching", async () => {
    const fixture = createFixture({ connected: true, modelAvailable: true });
    try {
      const response = await fixture.app.request("http://localhost/api/chatgpt-plan/status");
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({
        configured: true, connected: true, modelAvailable: true, ready: false,
        sources: ["google_news_rss", "yahoo_finance_rss"],
        dailyRequestLimit: 3, dailyByteLimit: 65_536,
        usage: { requests: 0, reservedRequests: 0, requestBytes: 0, unknownOutcomes: 0, classifiedItems: 0 },
      });
    } finally { fixture.db.close(); }
  });

  it("connects after a successful callback but leaves public classification paused until explicit Activate", async () => {
    const fixture = createFixture({ modelAvailable: true });
    try {
      const response = await fixture.app.request("http://localhost:8794/auth/callback?code=opaque&state=opaque", { headers: { host: "localhost:8794" } });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(await response.text()).toContain("Public classification remains paused until you explicitly choose Activate");
      expect(fixture.completeCallback).toHaveBeenCalledOnce();
      expect(fixture.checkModelAccess).not.toHaveBeenCalled();
      expect(fixture.activate).not.toHaveBeenCalled();
      expect(fixture.deactivate).not.toHaveBeenCalled();

      const activation = await fixture.app.request("http://localhost:8794/api/chatgpt-plan/activate", {
        method: "POST", headers: localHeaders, body: "{}",
      });
      expect(activation.status).toBe(200);
      expect(await activation.json()).toMatchObject({ ready: true });
      expect(fixture.activate).toHaveBeenCalledOnce();
    } finally { fixture.db.close(); }
  });

  it("accepts the Vite UI origin while keeping the OAuth callback on the API port", async () => {
    const fixture = createFixture({
      localOrigin: "http://127.0.0.1:5175",
      redirectUri: "http://127.0.0.1:8787/auth/callback",
      modelAvailable: true,
    });
    try {
      const connect = await fixture.app.request("http://127.0.0.1:8787/api/chatgpt-plan/connect", {
        method: "POST",
        headers: { origin: "http://127.0.0.1:5175", "content-type": "application/json" },
        body: "{}",
      });
      expect(connect.status).toBe(200);
      expect(fixture.beginAuthorization).toHaveBeenCalledWith("http://127.0.0.1:8787/auth/callback");

      const wrongHost = await fixture.app.request("http://127.0.0.1:5175/auth/callback?code=opaque&state=opaque", {
        headers: { host: "127.0.0.1:5175" },
      });
      expect(wrongHost.status).toBe(404);
      expect(fixture.completeCallback).not.toHaveBeenCalled();

      const callback = await fixture.app.request("http://127.0.0.1:8787/auth/callback?code=opaque&state=opaque", {
        headers: { host: "127.0.0.1:8787" },
      });
      expect(callback.status).toBe(200);
      expect(fixture.completeCallback).toHaveBeenCalledOnce();
    } finally { fixture.db.close(); }
  });

  it("does not check an old credential or activate when OAuth callback is canceled", async () => {
    const fixture = createFixture({ connected: true, modelAvailable: false, callbackOk: false });
    try {
      const response = await fixture.app.request("http://localhost:8794/auth/callback?code=opaque&state=opaque", { headers: { host: "localhost:8794" } });
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("OAuth callback handled.");
      expect(fixture.completeCallback).toHaveBeenCalledOnce();
      expect(fixture.isConnected).not.toHaveBeenCalled();
      expect(fixture.checkModelAccess).not.toHaveBeenCalled();
      expect(fixture.activate).not.toHaveBeenCalled();
    } finally { fixture.db.close(); }
  });

  it("deactivates before disconnecting, while rejecting a foreign origin without effects", async () => {
    const fixture = createFixture();
    try {
      const denied = await fixture.app.request("http://localhost:8794/api/chatgpt-plan/disconnect", {
        method: "POST", headers: { ...localHeaders, origin: "https://attacker.invalid" }, body: "{}",
      });
      expect(denied.status).toBe(403);
      expect(fixture.deactivate).not.toHaveBeenCalled();
      expect(fixture.disconnect).not.toHaveBeenCalled();

      const response = await fixture.app.request("http://localhost:8794/api/chatgpt-plan/disconnect", { method: "POST", headers: localHeaders, body: "{}" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ revoked: true });
      expect(fixture.deactivate).toHaveBeenCalledWith("ChatGPT plan connection was disconnected.");
      expect(fixture.disconnect).toHaveBeenCalledOnce();
    } finally { fixture.db.close(); }
  });
});

afterAll(() => { while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true }); });
