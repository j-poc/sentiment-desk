import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { privateEvidenceInputSchema, type PrivateEvidenceAnalysisRecord } from "../shared/private-evidence.js";
import { PrivateEvidenceLimitError, PrivateEvidenceStore } from "../server/private-evidence-store.js";

const directories: string[] = [];

function createStore() {
  const directory = mkdtempSync(join(tmpdir(), "sentiment-desk-private-evidence-"));
  directories.push(directory);
  const storeDirectory = join(directory, "private-evidence");
  const path = join(storeDirectory, "evidence.sqlite");
  return { storeDirectory, path, store: new PrivateEvidenceStore(path, () => Date.parse("2026-10-08T12:00:00.000Z")) };
}

describe("local private issuer evidence store", () => {
  it("persists issuer-bound text with an exact digest and separate user and import clocks", () => {
    const { storeDirectory, path, store } = createStore();
    try {
      const item = store.save("configured-public-issuer", {
        title: "Quarterly channel checks", sourceLabel: "Owner research notes", fileName: "channel-checks.md",
        asOfDate: "2026-10-05", content: "First-party notes; not an independently verified public source.",
      });
      expect(item).toMatchObject({
        companyId: "configured-public-issuer", title: "Quarterly channel checks", sourceLabel: "Owner research notes",
        fileName: "channel-checks.md", asOfDate: "2026-10-05", importedAt: Date.parse("2026-10-08T12:00:00.000Z"),
      });
      expect(item.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(store.get("configured-public-issuer", item.id)).toMatchObject({ ...item, content: "First-party notes; not an independently verified public source." });
      expect(store.list("configured-public-issuer")).toMatchObject({ items: [item], totalCount: 1, totalBytes: item.byteLength, nextCursor: null });
      expect(store.list("another-configured-issuer")).toMatchObject({ items: [], totalCount: 0, totalBytes: 0 });
      expect((statSync(storeDirectory).mode & 0o777)).toBe(0o700);
      expect((statSync(path).mode & 0o777)).toBe(0o600);
    } finally { store.close(); }

    const restarted = new PrivateEvidenceStore(path);
    try {
      expect(restarted.list("configured-public-issuer")).toMatchObject({ totalCount: 1, items: [{ id: expect.any(String), sha256: expect.any(String) }] });
    } finally { restarted.close(); }
  });

  it("keeps duplicate retries idempotent per issuer and prevents cross-issuer read or delete", () => {
    const { store } = createStore();
    try {
      const input = { title: "Same source", sourceLabel: "Saved note", content: "same exact source text" };
      const original = store.save("issuer-a", input);
      const retry = store.save("issuer-a", input);
      const otherIssuer = store.save("issuer-b", input);
      expect(retry.id).toBe(original.id);
      expect(otherIssuer.id).not.toBe(original.id);
      expect(store.get("issuer-b", original.id)).toBeNull();
      expect(store.delete("issuer-b", original.id)).toBe(false);
      expect(store.get("issuer-a", original.id)).not.toBeNull();
      expect(store.delete("issuer-a", original.id)).toBe(true);
      expect(store.get("issuer-a", original.id)).toBeNull();
    } finally { store.close(); }
  });

  it("binds one explicit analysis attempt to the exact note and cascades it on delete", () => {
    const { path, store } = createStore();
    const note = store.save("issuer-a", { title: "Channel check", sourceLabel: "Owner notes", content: "Orders improved this month." });
    const record: PrivateEvidenceAnalysisRecord = {
      companyId: "issuer-a", evidenceId: note.id, evidenceSha256: note.sha256, payloadSha256: "a".repeat(64), requestBytes: 900,
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
    try {
      expect(store.beginAnalysis("issuer-a", note.id, note.sha256, record.payloadSha256, record.requestBytes)).toBe(true);
      expect(store.beginAnalysis("issuer-a", note.id, note.sha256, record.payloadSha256, record.requestBytes)).toBe(false);
      expect(store.getAnalysis("issuer-a", note.id)).toMatchObject({ status: "in_progress", record: null });
      store.completeAnalysis("issuer-a", note.id, record);
      expect(store.getAnalysis("issuer-a", note.id)).toMatchObject({ status: "complete", record });
    } finally { store.close(); }

    const reopened = new PrivateEvidenceStore(path);
    try {
      expect(reopened.getAnalysis("issuer-a", note.id)).toMatchObject({ status: "complete", record });
      expect(reopened.delete("issuer-a", note.id)).toBe(true);
      expect(reopened.getAnalysis("issuer-a", note.id)).toBeNull();
      expect(reopened.get("issuer-a", note.id)).toBeNull();
    } finally { reopened.close(); }
  });

  it("rejects invalid dates, path-like filenames, empty text and byte/code-point overflow", () => {
    const base = { title: "Title", sourceLabel: "Source", content: "Note" };
    expect(privateEvidenceInputSchema.safeParse({ ...base, asOfDate: "2026-02-30" }).success).toBe(false);
    expect(privateEvidenceInputSchema.safeParse({ ...base, fileName: "../secret.txt" }).success).toBe(false);
    expect(privateEvidenceInputSchema.safeParse({ ...base, content: "" }).success).toBe(false);
    expect(privateEvidenceInputSchema.safeParse({ ...base, content: "   \n  " }).success).toBe(false);
    expect(privateEvidenceInputSchema.safeParse({ ...base, content: "\ud800" }).success).toBe(false);
    expect(privateEvidenceInputSchema.safeParse({ ...base, content: "\udc00" }).success).toBe(false);
    expect(privateEvidenceInputSchema.safeParse({ ...base, content: "🧭".repeat(32_769) }).success).toBe(false);
    expect(privateEvidenceInputSchema.safeParse({ ...base, content: "a".repeat(40_001) }).success).toBe(false);
  });

  it("enforces the aggregate byte cap atomically and accepts supported UTF-8 up to the item boundary", () => {
    const { store } = createStore();
    try {
      const content = `${"🧭".repeat(32_765)}A`;
      expect(new TextEncoder().encode(content).length).toBeLessThanOrEqual(128 * 1024);
      let saved = 0;
      let limitError: unknown;
      for (let index = 0; index < 70; index += 1) {
        try {
          store.save("issuer-a", { title: `Note ${index}`, sourceLabel: "Local", content: `${content}${index}` });
          saved += 1;
        } catch (error) { limitError = error; break; }
      }
      expect(saved).toBeGreaterThan(1);
      expect(limitError).toBeInstanceOf(PrivateEvidenceLimitError);
      expect((limitError as PrivateEvidenceLimitError).reason).toBe("byte_limit");
      expect(store.list("issuer-a").totalCount).toBe(saved);
      expect(store.list("issuer-a").totalBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    } finally { store.close(); }
  }, 30_000);
});

afterAll(() => { while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true }); });
