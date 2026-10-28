import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TestDesk } from "./test-desk.js";
import type { Company } from "../server/types.js";
import { ModelProviderCredentialVault, type KeyringSecret } from "../server/model-provider-credential-vault.js";
import { TypeSafeJevByokService } from "../server/typesafe-jev-byok.js";
import { ExternalRequestPausedError } from "../server/external-request-gate.js";
import { EVENT_TYPES, RUBRIC, RUBRIC_SHA, TAKEAWAY_KEYS } from "../server/rubric.js";

const directories: string[] = [];
const databases: TestDesk[] = [];
const company: Company = { id: "acme", name: "Acme Corporation", ticker: "ACME", sector: "Technology", aliases: ["Acme"], color: "#123456" };

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture(fetchImpl: typeof fetch, externalRequestsEnabled = true) {
  const directory = mkdtempSync(join(tmpdir(), "typesafe-jev-byok-"));
  directories.push(directory);
  const db = new TestDesk(join(directory, "desk.db"));
  db.seedCompanies([company]);
  databases.push(db);
  const savedKey = new Map<string, Uint8Array>();
  const keyring: KeyringSecret = { getSecret: async () => savedKey.get("vault"), setSecret: async value => { savedKey.set("vault", Uint8Array.from(value)); } };
  const vault = new ModelProviderCredentialVault(join(directory, "credentials"), keyring);
  const service = new TypeSafeJevByokService({ loopbackBound: true, externalRequestsEnabled, db, vault, storageAllowsProviderRequests: () => true,
    allowedCollectors: new Set(["google_news_rss"]), fetchImpl });
  return { db, vault, service, databasePath: join(directory, "desk.db") };
}

function insertSource(db: TestDesk, id: string) {
  return db.insertObservation({ companyId: company.id, kind: "rss", sourceName: "Reuters", sourceUrl: `https://example.com/${id}`,
    tier: "major", title: "Acme wins a major manufacturing contract", snippet: "Acme Corporation said the new contract will add production capacity.",
    publishedAt: Date.now(), retrievedAt: Date.now(), collector: "google_news_rss", sourceItemId: id }).observationId;
}

function answers(sentiment: "positive" | "neutral" | "negative" = "positive") {
  const choice = (choiceValue: string, keys: readonly string[]) => ({ type: "choice", choice: choiceValue,
    probabilities: Object.fromEntries(keys.map(key => [key, key === choiceValue ? 1 : 0])), confidence: 0.86 });
  const noul = (noulValue: number) => ({ type: "noul", noul: noulValue });
  return {
    sentiment: choice(sentiment, ["negative", "neutral", "positive"]),
    about: noul(0.95), investor_relevant: noul(0.9), material: noul(0.8), novel: noul(0.75), credible: noul(0.85),
    event_type: choice("corporate_action", EVENT_TYPES), magnitude: noul(0.65), surprise: noul(0.6),
    takeaway: choice("product_win", TAKEAWAY_KEYS),
  };
}

describe("local TypeSafe Jev BYOK assessment", () => {
  it("uses no verification or assessment allowance while external requests are disabled", async () => {
    let calls = 0;
    const { db, vault, service } = fixture(async () => { calls++; return Response.json({}); }, false);
    await vault.save("typesafe_jev", "test-typesafe-key");
    const observationId = insertSource(db, "typesafe-global-pause");
    for (let index = 0; index < 6; index++) {
      await expect(service.verify()).rejects.toMatchObject({ code: "external_requests_disabled", status: 503 });
    }
    await expect(service.assess({ observationId, confirmDataSend: true, confirmProviderUsageReview: false }))
      .rejects.toMatchObject({ code: "external_requests_disabled", status: 503 });
    expect(calls).toBe(0);
    expect(db.typeSafeJevByokVerificationUsage(new Date().toISOString().slice(0, 10))).toBe(0);
    expect(db.typeSafeJevByokAttemptHistory(observationId)).toEqual([]);
  });

  it("verifies the configured model using the exact authenticated catalog endpoint", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ models: [{ name: "jev-latest" }] }), { status: 200 });
    }) as typeof fetch;
    const { vault, service } = fixture(fetchImpl);
    await vault.save("typesafe_jev", "test-typesafe-key");

    await expect(service.verify()).resolves.toEqual({ model: "jev-latest", available: true });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.typesafe.ai/v1/models");
    expect(requests[0]?.init?.method).toBe("GET");
    expect(requests[0]?.init?.headers).toMatchObject({ authorization: "Bearer test-typesafe-key" });
  });

  it("saves one source-bound Jev result separately from legacy scores and provider classifications", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      requests.push({ url: String(input), body });
      return new Response(JSON.stringify({ model: "jev-1.13.0", answers: answers(), usage: { input_tokens: 123, output_tokens: 0 } }), { status: 200 });
    }) as typeof fetch;
    const { db, vault, service } = fixture(fetchImpl);
    await vault.save("typesafe_jev", "test-typesafe-key");
    const observationId = insertSource(db, "typesafe-byok-success");

    const result = await service.assess({ observationId, confirmDataSend: true, confirmProviderUsageReview: false });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(requests[0]?.body.model).toBe("jev-latest");
    expect(JSON.stringify(requests[0]?.body)).not.toContain("test-typesafe-key");
    const mentionState = (requests[0]?.body.state as { mention: { sourceTime: { at: string | null; basis: string } } }).mention;
    const source = db.mentionRow(observationId)!;
    expect(mentionState.sourceTime).toEqual({ at: new Date(source.aggregator_published_at!).toISOString(), basis: "aggregator_declared" });
    expect(result.sourceTimeAt).toBe(source.aggregator_published_at);
    expect(result).toMatchObject({ modelRequested: "jev-latest", modelReturned: "jev-1.13.0", sentiment: "positive", takeaway: "product_win", excluded: false });
    expect(db.mentionRow(observationId)).toMatchObject({ status: "pending", scored_at: null, engine: null });
    expect(db.latestModelProviderClassification(observationId, "google_gemini")).toBeNull();
    expect(db.typeSafeJevByokFeed(company.id, Date.now() - 60_000)).toHaveLength(1);
    expect(db.typeSafeJevByokUsage(new Date().toISOString().slice(0, 10)).requests).toBe(1);
    expect(RUBRIC.sentiment?.type).toBe("choice");
  });

  it("does not retry a request with an unknown outcome", async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls += 1; throw new TypeError("connection lost"); }) as typeof fetch;
    const { db, vault, service } = fixture(fetchImpl);
    await vault.save("typesafe_jev", "test-typesafe-key");
    const observationId = insertSource(db, "typesafe-byok-unknown");

    await expect(service.assess({ observationId, confirmDataSend: true, confirmProviderUsageReview: false })).rejects.toMatchObject({ code: "provider_outcome_unknown" });
    expect(calls).toBe(1);
    expect(db.typeSafeJevByokResult(observationId)).toBeNull();
    expect(db.typeSafeJevByokAttemptHistory(observationId)[0]?.status).toBe("unknown");
    await expect(service.assess({ observationId, confirmDataSend: true, confirmProviderUsageReview: false })).rejects.toMatchObject({ code: "provider_usage_review_required" });
    expect(calls).toBe(1);
  });

  it("does not send an item until the user confirms and the provider key exists", async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls += 1; return new Response("{}", { status: 200 }); }) as typeof fetch;
    const { db, service } = fixture(fetchImpl);
    const observationId = insertSource(db, "typesafe-byok-no-key");
    await expect(service.assess({ observationId, confirmDataSend: false as true, confirmProviderUsageReview: false })).rejects.toMatchObject({ code: "assessment_confirmation_required" });
    await expect(service.assess({ observationId, confirmDataSend: true, confirmProviderUsageReview: false })).rejects.toMatchObject({ code: "provider_credential_missing" });
    expect(calls).toBe(0);
    expect(db.typeSafeJevByokAttemptHistory(observationId)).toHaveLength(0);
  });

  it("closes a dispatched receipt as not sent when the final network gate pauses", async () => {
    const fetchImpl = (async () => { throw new ExternalRequestPausedError(); }) as typeof fetch;
    const { db, vault, service } = fixture(fetchImpl);
    await vault.save("typesafe_jev", "test-typesafe-key");
    const observationId = insertSource(db, "typesafe-byok-paused-before-send");

    await expect(service.assess({ observationId, confirmDataSend: true, confirmProviderUsageReview: false }))
      .rejects.toMatchObject({ code: "provider_request_not_sent", status: 503 });
    expect(db.typeSafeJevByokAttemptHistory(observationId)[0])
      .toMatchObject({ status: "not_sent", errorCategory: "provider_request_not_sent" });
    expect(db.typeSafeJevByokResult(observationId)).toBeNull();
  });

  it("recovers reserved and dispatched attempts after reopening and requires usage review before another call", async () => {
    let calls = 0;
    const fetchImpl = (async () => { calls += 1; return new Response(JSON.stringify({ model: "jev-1.13.0", answers: answers(), usage: { input_tokens: 12, output_tokens: 0 } }), { status: 200 }); }) as typeof fetch;
    const { db, vault, databasePath } = fixture(fetchImpl);
    await vault.save("typesafe_jev", "test-typesafe-key");
    const observationId = insertSource(db, "typesafe-byok-crash-recovery");
    const reserveAttempt = (status: "reserved" | "dispatched") => {
      const id = randomUUID();
      const reservedAt = Date.now();
      expect(db.reserveTypeSafeJevByokAttempt({ id, observationId, modelRequested: "jev-latest",
        sourceSha256: "a".repeat(64), requestSha256: "b".repeat(64), requestBytes: 100, rubricSha256: RUBRIC_SHA,
        utcDay: new Date(reservedAt).toISOString().slice(0, 10), reservedAt, costReservationMicros: 10_000,
        maxDailyRequests: 10, maxDailyBytes: 100_000, maxDailyCostMicros: 1_000_000 })).toBe("reserved");
      if (status === "dispatched") expect(db.markTypeSafeJevByokDispatched(id, reservedAt + 1)).toBe(true);
      return id;
    };
    const reservedId = reserveAttempt("reserved");
    const dispatchedId = reserveAttempt("dispatched");

    db.close();
    databases.splice(databases.indexOf(db), 1);
    const reopened = new TestDesk(databasePath);
    databases.push(reopened);
    const history = reopened.typeSafeJevByokAttemptHistory(observationId);
    expect(history.find(attempt => attempt.id === reservedId)).toMatchObject({ status: "not_sent", errorCategory: "interrupted_before_dispatch" });
    expect(history.find(attempt => attempt.id === dispatchedId)).toMatchObject({ status: "unknown", errorCategory: "interrupted_after_dispatch" });

    const service = new TypeSafeJevByokService({ loopbackBound: true, externalRequestsEnabled: true, db: reopened, vault, storageAllowsProviderRequests: () => true,
      allowedCollectors: new Set(["google_news_rss"]), fetchImpl });
    await expect(service.assess({ observationId, confirmDataSend: true, confirmProviderUsageReview: false }))
      .rejects.toMatchObject({ code: "provider_usage_review_required" });
    expect(calls).toBe(0);
  });

  it("rejects and records an unknown result if transmitted company details change in flight", async () => {
    let releaseResponse!: (response: Response) => void;
    let markStarted!: () => void;
    const responsePending = new Promise<Response>(resolve => { releaseResponse = resolve; });
    const requestStarted = new Promise<void>(resolve => { markStarted = resolve; });
    const fetchImpl = (async () => { markStarted(); return responsePending; }) as typeof fetch;
    const { db, vault, service } = fixture(fetchImpl);
    await vault.save("typesafe_jev", "test-typesafe-key");
    const observationId = insertSource(db, "typesafe-byok-changed-identity");
    const pending = service.assess({ observationId, confirmDataSend: true, confirmProviderUsageReview: false });
    await requestStarted;
    db.testDb.prepare("UPDATE companies SET sector=? WHERE id=?").run("Aerospace", company.id);
    releaseResponse(new Response(JSON.stringify({ model: "jev-1.13.0", answers: answers(), usage: { input_tokens: 12, output_tokens: 0 } }), { status: 200 }));

    await expect(pending).rejects.toMatchObject({ code: "source_identity_changed_after_dispatch" });
    expect(db.typeSafeJevByokResult(observationId)).toBeNull();
    expect(db.typeSafeJevByokAttemptHistory(observationId)[0]?.status).toBe("unknown");
  });
});
