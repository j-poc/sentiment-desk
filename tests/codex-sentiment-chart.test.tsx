// @vitest-environment jsdom
import { randomUUID } from "node:crypto";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodexLunaSaved } from "../shared/codex-luna.js";
import type { Mention } from "../web/src/lib/api.js";
import { CodexSentimentChart } from "../web/src/components/CodexSentimentChart.js";

const throughMs = Date.UTC(2026, 9, 18, 12);
const fromMs = throughMs - 6 * 3_600_000;
const status = { configured: true, externalRequestsEnabled: true, experimental: true, unknownOutcome: false,
  usage: { requests: 0 }, limits: { dailyRequests: 20 } };
function item(id: string, sourceTimeAt: number | null, category: "positive" | "negative" | "neutral" | "excluded" | "review_required" = "positive", companyId = "test-issuer") {
  const mention: Mention = { id, companyId, title: `Verifier source ${id}`, snippet: "A saved source excerpt for component verification.",
    source: { name: "Verifier publisher", url: `https://example.test/${id}`, kind: "rss", tier: "major", collector: "google_news_rss",
      publisher: "Verifier publisher", publisherDomain: "example.test" },
    collector: "google_news_rss", publisherName: "Verifier publisher", publisherDomain: "example.test", publishedAt: sourceTimeAt,
    providerObservedAt: null, retrievedAt: throughMs - 60_000, ingestedAt: throughMs - 60_000,
    timeBasis: sourceTimeAt === null ? "unknown" : "publisher_declared", status: "pending", scoreRetryAt: null,
    usageCheckRequired: false, score: null, error: null };
  const classification: CodexLunaSaved = { provider: "codex_luna", attemptId: randomUUID(), observationId: id, companyId,
    sourceSha256: "a".repeat(64), requestSha256: "b".repeat(64), outputSha256: "c".repeat(64),
    promptSha256: "d".repeat(64), schemaSha256: "e".repeat(64),
    modelRequested: "gpt-6-luna", modelConfigured: "gpt-6-luna", modelReturned: null,
    threadId: `thread-${id}`, turnId: `turn-${id}`, cliVersion: "0.162.1",
    tokenUsage: { inputTokens: 5, outputTokens: 5, totalTokens: 10, cachedInputTokens: 0, reasoningOutputTokens: 0 },
    sourceTimeAt, retrievedAt: mention.retrievedAt, createdAt: throughMs - 30_000,
    sentiment: category === "excluded" || category === "review_required" ? null : category,
    disposition: category === "excluded" || category === "review_required" ? category : "classified",
    eventType: "results", takeaway: "revenue_growth", about: true, material: true, investorRelevant: true,
    evidenceSufficient: true, summary: `Saved summary ${id}`, supportingExcerpt: "A saved source excerpt" };
  return { classification, mention };
}
function response(items: ReturnType<typeof item>[] = [], companyId = "test-issuer") {
  return { companyId, hours: 6, fromMs, throughMs, items };
}
function json(value: unknown, code = 200) { return new Response(JSON.stringify(value), { status: code, headers: { "content-type": "application/json" } }); }

describe("Codex saved sentiment chart", () => {
  let container: HTMLDivElement;
  let root: Root;
  const fetchMock = vi.fn<typeof fetch>();
  const onOpenMention = vi.fn();
  const onReviewSourceRecords = vi.fn();
  beforeEach(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset(); onOpenMention.mockReset(); onReviewSourceRecords.mockReset();
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); });
  async function render(companyId = "test-issuer", refreshRevision = 0) {
    await act(async () => root.render(createElement(CodexSentimentChart, { companyId, hours: 6, refreshRevision, onOpenMention, onReviewSourceRecords })));
  }
  function serve(value: unknown, statusCode = 200) {
    fetchMock.mockImplementation(async input => String(input).endsWith("/status") ? json(status) : json(value, statusCode));
  }
  function button(label: string) {
    const result = [...container.querySelectorAll("button")].find(node => node.textContent?.includes(label));
    if (!result) throw new Error(`Missing button: ${label}`);
    return result;
  }

  it("plots discrete source-time counts, retains zero gaps, and opens exactly the selected source records", async () => {
    const first = item("first", fromMs + 5 * 60_000);
    const second = item("second", fromMs + 25 * 60_000, "neutral");
    const negative = item("third", fromMs + 35 * 60_000, "negative");
    serve(response([first, second, negative])); await render();
    const bars = [...container.querySelectorAll<HTMLButtonElement>(".categorical-bar")];
    expect(bars).toHaveLength(12);
    expect(bars[0]?.getAttribute("aria-label")).toContain("positive 1, neutral 1, negative 0, needs review 0, excluded 0. Total 2");
    expect(bars[1]?.getAttribute("aria-label")).toContain("Total 1 source observations");
    expect(bars.filter(bar => bar.classList.contains("is-empty"))).toHaveLength(10);
    expect(container.querySelectorAll(".categorical-segment")).toHaveLength(3);
    await act(async () => bars[0]?.click());
    expect(container.querySelectorAll(".categorical-bucket-evidence article")).toHaveLength(2);
    expect(container.textContent).toContain("2 source observations · exact saved chart records");
    expect(container.textContent).toContain(first.classification.summary);
    expect(container.textContent).toContain(first.classification.supportingExcerpt);
    expect(container.textContent).not.toContain(negative.mention.title);
    await act(async () => button("Open saved source record").click());
    expect(onOpenMention).toHaveBeenCalledWith(first.mention);
    expect(fetchMock.mock.calls.every(([, init]) => init?.method === "GET")).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Luna requested · returned model not exposed");
    expect(container.textContent).toContain("native experimental interface");
  });

  it("shows empty as empty, exposes the saved-source action, and performs no inference", async () => {
    serve(response()); await render();
    expect(container.textContent).toContain("This is an empty result, not a neutral sentiment reading");
    expect(container.querySelectorAll(".categorical-bar")).toHaveLength(0);
    await act(async () => button("Review saved source records").click());
    expect(onReviewSourceRecords).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls.map(([, init]) => init?.method)).toEqual(["GET", "GET"]);
  });

  it("distinguishes a failed read from an empty result and recovers through retry", async () => {
    serve({ error: "unavailable" }, 503); await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("current window is unknown");
    expect(container.textContent).not.toContain("No saved Codex classifications");
    serve(response([item("recovered", fromMs)]));
    await act(async () => button("Retry sentiment").click());
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelectorAll(".categorical-segment")).toHaveLength(1);
  });

  it("never replaces source time with retrieval or classification time for untimed records", async () => {
    const untimed = item("untimed", null, "review_required");
    serve(response([untimed])); await render();
    expect(container.querySelectorAll(".categorical-bar")).toHaveLength(0);
    expect(container.textContent).toContain("0plotted · 1 untimed");
    expect(container.textContent).toContain("no validated source time and is not plotted");
    await act(async () => button("Review untimed sources").click());
    expect(container.querySelectorAll(".categorical-bucket-evidence article")).toHaveLength(1);
    expect(container.textContent).toContain("Source time unknown");
    await act(async () => button("Open saved source record").click());
    expect(onOpenMention).toHaveBeenCalledWith(untimed.mention);
  });

  it("drops a delayed issuer response after switching, even if the HTTP boundary ignores cancellation", async () => {
    let resolveFirst: ((value: Response) => void) | undefined;
    const pending = new Promise<Response>(resolve => { resolveFirst = resolve; });
    fetchMock.mockImplementation(async input => {
      const url = String(input);
      if (url.endsWith("/status")) return json(status);
      if (url.includes("test-issuer/")) return pending;
      return json(response([item("next", fromMs, "negative", "next-issuer")], "next-issuer"));
    });
    await render(); expect(container.textContent).toContain("Loading saved Codex sentiment");
    await render("next-issuer");
    expect(container.querySelector('[aria-label="Source sentiment buckets"]')?.textContent).not.toContain("Loading");
    await act(async () => resolveFirst?.(json(response([item("stale", fromMs)]))));
    const bar = container.querySelector<HTMLButtonElement>(".categorical-bar");
    expect(bar?.getAttribute("aria-label")).toContain("negative 1");
    await act(async () => bar?.click());
    expect(container.textContent).toContain("Verifier source next");
    expect(container.textContent).not.toContain("Verifier source stale");
    const firstSignal = fetchMock.mock.calls[0]?.[1]?.signal;
    expect(firstSignal?.aborted).toBe(true);
  });

  it.each(["issuer", "hours", "observation", "clock", "retrieval", "duplicate", "range", "model"])("withholds a corrupt %s snapshot instead of presenting it as source evidence", async mismatch => {
    const saved = item("bad", fromMs);
    const value = response([saved]);
    if (mismatch === "issuer") value.companyId = "other-issuer";
    if (mismatch === "hours") value.hours = 24;
    if (mismatch === "observation") saved.classification.observationId = "other-source";
    if (mismatch === "clock") saved.mention.timeBasis = "unknown";
    if (mismatch === "retrieval") saved.classification.retrievedAt -= 1;
    if (mismatch === "duplicate") value.items.push(saved);
    if (mismatch === "range") saved.classification.sourceTimeAt = saved.mention.publishedAt = throughMs;
    const payload = mismatch === "model" ? { ...value, items: [{ ...saved, classification: { ...saved.classification, modelReturned: "gpt-6-luna" } }] } : value;
    serve(payload); await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("could not be read or reconciled");
    expect(container.querySelectorAll(".categorical-bar")).toHaveLength(0);
    expect(container.textContent).not.toContain("empty result");
  });

  it("keeps a saved chart readable if the optional readiness endpoint fails", async () => {
    fetchMock.mockImplementation(async input => String(input).endsWith("/status") ? json({ error: "offline" }, 503) : json(response([item("saved", fromMs)])));
    await render(); expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelectorAll(".categorical-segment")).toHaveLength(1);
  });

  it("cancels pending reads when unmounted", async () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    await render();
    const signals = fetchMock.mock.calls.map(([, init]) => init?.signal);
    await act(async () => root.unmount());
    expect(signals).toHaveLength(2);
    expect(signals.every(signal => signal?.aborted)).toBe(true);
    root = createRoot(container);
  });
});
