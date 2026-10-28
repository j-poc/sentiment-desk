import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TestDesk } from "./test-desk.js";
import { CodexLunaService } from "../server/codex-luna-service.js";
import { CodexLunaError, type CodexLunaResult } from "../server/codex-luna-runner.js";
import { createApp, type AppDeps } from "../server/app.js";
import { Hub } from "../server/hub.js";
import { HealthTracker } from "../server/health.js";

// Isolated software guardrails. These records never enter the product database.
const directories: string[] = [];
const desks = new Set<TestDesk>();
afterEach(() => { for (const db of desks) db.close(); desks.clear(); for (const path of directories.splice(0)) rmSync(path,{ recursive: true,force: true }); });

function fixture(options: { untimed?: boolean; receipt?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(),"codex-luna-fixture-")); directories.push(directory);
  const path = join(directory,"desk.db"); const db = new TestDesk(path); desks.add(db);
  db.seedCompanies([{ id: "acme",name: "Acme Incorporated",ticker: "ACME",sector: "Technology",aliases: ["Acme"],color: "#123456" },
    { id: "other",name: "Other Incorporated",ticker: "OTHER",sector: "Technology",aliases: ["Other"],color: "#123456" }]);
  const now = Date.now();
  const deliveryId = db.recordDelivery({ collector: "google_news_rss",companyId: "acme",requestKey: "fixture",
    startedAt: now-4000,completedAt: now-3000,result: "success",parsedItemCount: 1,adapterVersion: "fixture/1",processingRequired: true });
  db.startDeliveryIngestion(deliveryId,1,now-3000);
  const id = db.insertObservation({ companyId: "acme",kind: "rss",sourceName: "Fixture Publisher",
    sourceUrl: "https://source.example/fixture-acme",tier: "wire",title: "Acme wins an industrial contract",
    snippet: "Acme said the contract adds production capacity.",publishedAt: null,aggregatorPublishedAt: options.untimed ? null : now-5000,
    retrievedAt: now-2000,collector: "google_news_rss",sourceItemId: "fixture-source",publisherName: "Fixture Publisher",
    publisherDomain: "source.example",adapterVersion: "fixture/1",...(options.receipt===false ? {} : { deliveryId }) }).observationId;
  db.finishDeliveryIngestion(deliveryId,{ status: "success",processedCount: 1,insertedCount: 1,completedAt: now-1000 });
  let enabled = true;
  const run = vi.fn(async (_input, dispatch: () => void): Promise<CodexLunaResult> => {
    dispatch();
    return { modelRequested: "gpt-6-luna",modelConfigured: "gpt-6-luna",modelReturned: null,
      threadId: "fixture-thread",turnId: "fixture-turn",cliVersion: "0.162.1",outputSha256: "a".repeat(64),
      tokenUsage: { inputTokens: 100,outputTokens: 25,totalTokens: 125,cachedInputTokens: 0,reasoningOutputTokens: 0 },
      classification: { sentiment: "positive",eventType: "corporate_action",takeaway: "product_win",about: true,material: true,
        investorRelevant: true,evidenceSufficient: true,summary: "Acme won a contract.",supportingExcerpt: "Acme wins an industrial contract" },classifiedAt: Date.now() };
  });
  const createService = (database: TestDesk) => new CodexLunaService({ db: database,externalRequestsEnabled: () => enabled,
    allowedCollectors: new Set(["google_news_rss"]),run,sessionStatus: async () => ({ configured: true }) });
  const service = createService(db);
  const app = createApp({ db,dbPath: path,pipeline: {} as AppDeps["pipeline"],market: {} as AppDeps["market"],hub: new Hub(),
    health: new HealthTracker(false,false,"fixture",false,false,false,false),version: "fixture",deliverySources: [],codexLuna: service });
  const request = (method: string,route: string,body?: unknown,origin = "http://127.0.0.1:8798") => app.request(`http://127.0.0.1:8798${route}`,{
    method,headers: { origin,"content-type": "application/json" },...(body===undefined ? {} : { body: JSON.stringify(body) }) });
  return { db,path,id,service,run,request,createService,pause: () => { enabled = false; } };
}
const consent = { confirmDataSend: true,confirmProviderUsageReview: false };

describe("Codex one-source analysis and persisted sentiment", () => {
  it("rejects missing consent and cross-origin calls, and never infers on reads", async () => {
    const f = fixture(); const path = `/api/mentions/${encodeURIComponent(f.id)}/codex-luna-classification`;
    expect((await f.request("POST",path,{})).status).toBe(400);
    expect((await f.request("POST",path,consent,"https://foreign.example")).status).toBe(403);
    expect((await f.request("GET","/api/codex-luna/status")).status).toBe(200);
    expect((await f.request("GET","/api/companies/acme/codex-luna-series?hours=24")).status).toBe(200);
    expect((await f.request("GET",`/api/mentions/${encodeURIComponent(f.id)}/model-classification?provider=codex_luna`)).status).toBe(200);
    expect(f.run).not.toHaveBeenCalled(); expect(f.db.codexLunaAttempts()).toEqual([]);
  });

  it("saves one honest receipt, returns the exact chart source, and survives reopening without replay", async () => {
    const f = fixture();
    const response = await f.request("POST",`/api/mentions/${encodeURIComponent(f.id)}/codex-luna-classification`,consent);
    expect(response.status).toBe(200); const result = (await response.json()).result;
    expect(result.modelReturned).toBeNull(); expect(result.turnId).toBe("fixture-turn"); expect(result.responseId).toBeUndefined();
    expect(f.service.series("acme",24).items).toHaveLength(1);
    expect(f.service.series("acme",24).items[0]?.mention.id).toBe(f.id);
    expect(f.service.series("other",24).items).toEqual([]);
    expect(await f.service.classify(f.id,consent)).toEqual(result); expect(f.run).toHaveBeenCalledTimes(1);
    f.db.close(); desks.delete(f.db); const reopened = new TestDesk(f.path); desks.add(reopened);
    const service = f.createService(reopened);
    expect(service.series("acme",24).items[0]?.classification).toEqual(result);
    expect(await service.classify(f.id,consent)).toEqual(result); expect(f.run).toHaveBeenCalledTimes(1);
  });

  it("vetoes a request paused during native setup before dispatch and preserves the daily allowance", async () => {
    const f = fixture();
    f.run.mockImplementationOnce(async (_input,dispatch) => { f.pause(); dispatch(); throw new Error("unreachable"); });
    await expect(f.service.classify(f.id,consent)).rejects.toMatchObject({ code: "external_requests_disabled" });
    expect(f.db.codexLunaAttempts()[0]?.status).toBe("not_sent");
    expect((await f.service.status()).usage.requests).toBe(0);
  });

  it("withholds sources without a successful ingestion receipt", async () => {
    const f = fixture({ receipt: false });
    await expect(f.service.classify(f.id,consent)).rejects.toMatchObject({ code: "source_not_suitable_for_investor_classification" });
    expect(f.run).not.toHaveBeenCalled();
  });

  it("records uncertain delivery, requires a usage review, and cannot retry itself", async () => {
    const f = fixture();
    f.run.mockImplementationOnce(async (_input,dispatch) => { dispatch(); throw new CodexLunaError("codex_auth_expired",true); });
    await expect(f.service.classify(f.id,consent)).rejects.toMatchObject({ code: "codex_auth_expired" });
    expect(f.db.codexLunaAttempts()[0]?.status).toBe("unknown");
    await expect(f.service.classify(f.id,consent)).rejects.toMatchObject({ code: "provider_usage_review_required" });
    expect(f.service.series("acme",24).items).toEqual([]); expect(f.run).toHaveBeenCalledTimes(1);
  });

  it("preserves unknown source time without putting retrieval time on the timeline", async () => {
    const f = fixture({ untimed: true });
    const saved = await f.service.classify(f.id,consent);
    expect(saved.sourceTimeAt).toBeNull(); expect(f.service.series("acme",24).items[0]?.classification.sourceTimeAt).toBeNull();
  });

  it("recovers dispatched interruption on restart and serializes the native request budget", async () => {
    const f = fixture(); const a = { id: randomUUID(),observationId: f.id,companyId: "acme",sourceSha256: "a".repeat(64),requestBytes: 100,reservedAt: Date.now() };
    expect(f.db.reserveCodexLunaAttempt(a)).toBeNull();
    expect(f.db.reserveCodexLunaAttempt({ ...a,id: randomUUID() })).toBe("codex_request_in_progress");
    expect(f.db.dispatchCodexLunaAttempt(a.id)).toBe(true);
    f.db.close(); desks.delete(f.db); const reopened = new TestDesk(f.path); desks.add(reopened);
    expect(reopened.codexLunaAttempts()[0]?.status).toBe("unknown");
    await expect(f.createService(reopened).classify(f.id,consent)).rejects.toMatchObject({ code: "provider_usage_review_required" });
    expect(f.run).not.toHaveBeenCalled();
  });
});
