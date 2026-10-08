import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createApp, type AppDeps } from "../server/app.js";
import { TestDesk as Desk } from "./test-desk.js";
import { HealthTracker } from "../server/health.js";
import { Hub } from "../server/hub.js";
import { PrivateEvidenceStore } from "../server/private-evidence-store.js";
import { loadCompanies } from "../server/config.js";
import type { PrivateEvidenceAnalysisRecord, PrivateEvidenceItem } from "../shared/private-evidence.js";

const directories: string[] = [];
const configuredPublicCompanies = loadCompanies();
const companyA = configuredPublicCompanies.find((company) => company.ticker === "AAPL")!;
const companyB = configuredPublicCompanies.find((company) => company.ticker === "ADBE")!;

function createFixture(
  loopback = true,
  privateEvidenceCompanyIds = new Set(configuredPublicCompanies.map((company) => company.id)),
  privateEvidenceAnalysis?: AppDeps["privateEvidenceAnalysis"],
) {
  const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-private-api-"));
  directories.push(directory);
  const dbPath = join(directory, "desk.sqlite");
  const db = new Desk(dbPath);
  db.seedCompanies(configuredPublicCompanies);
  const store = new PrivateEvidenceStore(join(directory, "private-evidence", "evidence.sqlite"));
  const app = createApp({
    db, dbPath,
    pipeline: { snapshots: () => [] } as unknown as AppDeps["pipeline"],
    market: {} as AppDeps["market"], hub: new Hub(),
    health: new HealthTracker(false, false, "unconfigured"),
    version: "test", deliverySources: [], privateEvidence: store, privateEvidenceEnabled: loopback,
    privateEvidenceCompanyIds,
    privateEvidenceAnalysis,
  });
  return { app, db, store };
}

function localHeaders(extra: Record<string, string> = {}) {
  return { origin: "http://localhost", "content-type": "application/json", ...extra };
}

function analysisResult(companyId: string, evidence: PrivateEvidenceItem): PrivateEvidenceAnalysisRecord {
  return {
    companyId, evidenceId: evidence.id, evidenceSha256: evidence.sha256, payloadSha256: "a".repeat(64), requestBytes: 900,
    modelRequested: "gpt-6-luna", modelReturned: "gpt-6-luna", serviceTierRequested: "default", serviceTier: "default",
    promptVersion: "private-evidence-luna-analysis/1", promptSha256: "b".repeat(64), schemaVersion: "private-evidence-luna-analysis-json/1",
    schemaSha256: "c".repeat(64), profileVersion: "private-evidence-luna-profile/1", profileSha256: "d".repeat(64),
    responseId: "resp_private_test", responseSha256: "e".repeat(64),
    usage: { inputTokens: 30, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 20, reasoningTokens: 0, totalTokens: 50, estimatedCostUsd: 0.000013 },
    analysis: { sentiment: "positive", summary: "The note says orders improved.", evidence: [{ quote: "Orders improved this month.", explanation: "It describes an operating trend." }], uncertainties: ["The note does not identify the sample or method."], nextQuestion: "Can this trend be corroborated?" },
    latencyMs: 321, httpStatus: 200,
    dataControls: {
      endpoint: "https://api.openai.com/v1/responses", responseObjectStorage: false,
      promptCacheMode: "explicit_no_breakpoints", promptCacheWritesRequested: false, defaultAbuseMonitoringRetentionDays: 30,
      organizationRetentionPolicy: "unverified", disclosure: "OpenAI retention setting is unverified.",
      documentationUrl: "https://developers.openai.com/api/docs/guides/your-data",
      promptCachingDocumentationUrl: "https://developers.openai.com/api/docs/guides/prompt-caching",
    },
  };
}

describe("private evidence API boundary", () => {
  it("stores only against a configured issuer and keeps private text out of public evidence and classifier-facing routes", async () => {
    const { app, db, store } = createFixture();
    const providerCall = vi.spyOn(globalThis, "fetch");
    try {
      const response = await app.request(`/api/companies/${encodeURIComponent(companyA.id)}/private-evidence`, {
        method: "POST", headers: localHeaders(),
        body: JSON.stringify({ title: "Channel note", sourceLabel: "Owner notes", fileName: "checks.md", asOfDate: "2026-10-04", content: "Sensitive private channel note." }),
      });
      expect(response.status).toBe(201);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const created = await response.json() as { id: string; companyId: string; sha256: string };
      expect(created).toMatchObject({ companyId: companyA.id, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });

      const listResponse = await app.request(`/api/companies/${encodeURIComponent(companyA.id)}/private-evidence`);
      expect(listResponse.status).toBe(200);
      expect(await listResponse.json()).toMatchObject({ totalCount: 1, items: [{ id: created.id, sha256: created.sha256 }] });
      expect(JSON.stringify(await (await app.request(`/api/companies/${encodeURIComponent(companyA.id)}/private-evidence`)).json())).not.toContain("Sensitive private channel note");

      const exact = await app.request(`/api/companies/${encodeURIComponent(companyA.id)}/private-evidence/${created.id}`);
      expect(await exact.json()).toMatchObject({ id: created.id, companyId: companyA.id, content: "Sensitive private channel note." });
      const wrongIssuerRead = await app.request(`/api/companies/${encodeURIComponent(companyB.id)}/private-evidence/${created.id}`);
      expect(wrongIssuerRead.status).toBe(404);

      const publicMentions = await app.request(`/api/companies/${encodeURIComponent(companyA.id)}/mentions?hours=168`);
      expect(await publicMentions.json()).toEqual([]);
      expect(db.realObservationCount()).toBe(0);
      expect(store.list(companyB.id)).toMatchObject({ totalCount: 0, items: [] });
      expect(providerCall).not.toHaveBeenCalled();
    } finally { providerCall.mockRestore(); store.close(); db.close(); }
  });

  it("rejects unknown issuers, hostile origins, unsafe deployment binding, invalid UTF-8 and oversize bodies without writes", async () => {
    const { app, db, store } = createFixture();
    try {
      const hostile = await app.request(`/api/companies/${encodeURIComponent(companyA.id)}/private-evidence`, {
        method: "POST", headers: localHeaders({ origin: "https://attacker.invalid" }),
        body: JSON.stringify({ title: "x", sourceLabel: "x", content: "private" }),
      });
      expect(hostile.status).toBe(403);
      const unknown = await app.request("/api/companies/private-company-id/private-evidence", {
        method: "POST", headers: localHeaders(), body: JSON.stringify({ title: "x", sourceLabel: "x", content: "private" }),
      });
      expect(unknown.status).toBe(404);
      const invalidUtf8 = await app.request(`/api/companies/${encodeURIComponent(companyA.id)}/private-evidence`, {
        method: "POST", headers: localHeaders(), body: new Uint8Array([0xff, 0xfe]),
      });
      expect(invalidUtf8.status).toBe(400);
      const oversized = await app.request(`/api/companies/${encodeURIComponent(companyA.id)}/private-evidence`, {
        method: "POST", headers: localHeaders(), body: JSON.stringify({ title: "x", sourceLabel: "x", content: "a".repeat(900_000) }),
      });
      expect(oversized.status).toBe(413);
      const badFileType = await app.request(`/api/companies/${encodeURIComponent(companyA.id)}/private-evidence`, {
        method: "POST", headers: localHeaders(), body: JSON.stringify({ title: "x", sourceLabel: "x", fileName: "private.pdf", content: "not parsed" }),
      });
      expect(badFileType.status).toBe(415);
      expect(store.list(companyA.id)).toMatchObject({ totalCount: 0, items: [] });

      const unavailable = createFixture(false);
      try {
        const blocked = await unavailable.app.request(`/api/companies/${encodeURIComponent(companyA.id)}/private-evidence`);
        expect(blocked.status).toBe(503);
        expect(await blocked.json()).toEqual({ error: "private_evidence_requires_loopback_binding" });
      } finally { unavailable.store.close(); unavailable.db.close(); }
    } finally { store.close(); db.close(); }
  });

  it("requires both a configured issuer row and the curated public-issuer allowlist", async () => {
    const { app, db, store } = createFixture(true, new Set([companyB.id]));
    try {
      const denied = await app.request(`/api/companies/${encodeURIComponent(companyA.id)}/private-evidence`, {
        method: "POST", headers: localHeaders(),
        body: JSON.stringify({ title: "Note", sourceLabel: "Owner", content: "Private text." }),
      });
      expect(denied.status).toBe(404);
      expect(await denied.json()).toEqual({ error: "unknown_configured_public_company" });
      expect(store.list(companyA.id)).toMatchObject({ totalCount: 0, items: [] });
    } finally { store.close(); db.close(); }
  });

  it("sends only the selected note after explicit confirmation and keeps the result private and idempotent", async () => {
    let calls = 0;
    const { app, db, store } = createFixture(true, undefined, {
      enabled: true, blockedReason: null,
      analyze: async (company, evidence, attempt) => {
        calls += 1;
        expect(company.id).toBe(companyA.id);
        expect(evidence.content).toBe("Orders improved this month.");
        expect(attempt.begin({ payloadSha256: "a".repeat(64), evidenceSha256: evidence.sha256, requestBytes: 900 })).toBe(true);
        return analysisResult(company.id, evidence);
      },
    });
    try {
      const savedResponse = await app.request(`/api/companies/${encodeURIComponent(companyA.id)}/private-evidence`, {
        method: "POST", headers: localHeaders(), body: JSON.stringify({ title: "Channel check", sourceLabel: "Owner notes", content: "Orders improved this month." }),
      });
      const saved = await savedResponse.json() as { id: string };
      const path = `/api/companies/${encodeURIComponent(companyA.id)}/private-evidence/${saved.id}/analyze`;
      const noConfirmation = await app.request(path, { method: "POST", headers: localHeaders(), body: JSON.stringify({}) });
      expect(noConfirmation.status).toBe(400);
      expect(calls).toBe(0);
      const analyzed = await app.request(path, {
        method: "POST", headers: localHeaders(), body: JSON.stringify({ confirmExternalProcessing: true }),
      });
      expect(analyzed.status).toBe(201);
      expect(analyzed.headers.get("cache-control")).toBe("no-store");
      expect(await analyzed.json()).toMatchObject({ status: "complete", record: { modelRequested: "gpt-6-luna", companyId: companyA.id, analysis: { sentiment: "positive" } } });
      expect(calls).toBe(1);
      const repeated = await app.request(path, {
        method: "POST", headers: localHeaders(), body: JSON.stringify({ confirmExternalProcessing: true }),
      });
      expect(repeated.status).toBe(200);
      expect(await repeated.json()).toMatchObject({ reusedSavedAnalysis: true, status: "complete" });
      expect(calls).toBe(1);
      const publicMentions = await app.request(`/api/companies/${encodeURIComponent(companyA.id)}/mentions?hours=168`);
      expect(await publicMentions.json()).toEqual([]);
      expect(db.realObservationCount()).toBe(0);
    } finally { store.close(); db.close(); }
  });

  it("persists through store restart and deletes only on explicit same-origin request", async () => {
    const { app, db, store } = createFixture();
    try {
      const saved = await app.request(`/api/companies/${encodeURIComponent(companyA.id)}/private-evidence`, {
        method: "POST", headers: localHeaders(), body: JSON.stringify({ title: "Note", sourceLabel: "Personal", content: "Local text." }),
      });
      const created = await saved.json() as { id: string };
      const noOriginDelete = await app.request(`/api/companies/${encodeURIComponent(companyA.id)}/private-evidence/${created.id}`, { method: "DELETE" });
      expect(noOriginDelete.status).toBe(403);
      const wrongIssuerDelete = await app.request(`/api/companies/${encodeURIComponent(companyB.id)}/private-evidence/${created.id}`, {
        method: "DELETE", headers: localHeaders(),
      });
      expect(wrongIssuerDelete.status).toBe(404);
      const deleted = await app.request(`/api/companies/${encodeURIComponent(companyA.id)}/private-evidence/${created.id}`, {
        method: "DELETE", headers: localHeaders(),
      });
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toEqual({ deleted: true });
      await expect((await app.request(`/api/companies/${encodeURIComponent(companyA.id)}/private-evidence`)).json()).resolves.toMatchObject({ totalCount: 0 });
    } finally { store.close(); db.close(); }
  });
});

afterAll(() => { while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true }); });
