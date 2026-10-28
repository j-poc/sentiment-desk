// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Mention } from "../web/src/lib/api.js";
import { SourceModelAssessment } from "../web/src/components/SourceModelAssessment.js";

const providerStatus = {
  providers: [
    { provider: "openai", configured: true, model: "gpt-6-luna" },
    { provider: "google_gemini", configured: true, model: "gemini-3.8-flash" },
    { provider: "typesafe_jev", configured: true, model: "jev-latest" },
  ],
};

const makeMention = (id: string): Mention => ({
  id,
  companyId: id,
  source: { name: "Example publisher", url: `https://example.com/${id}`, kind: "rss", tier: "major", collector: "google_news_rss", publisher: "Example publisher", publisherDomain: "example.com" },
  title: `${id} source item`, snippet: `${id} source excerpt`, publishedAt: null, providerObservedAt: null,
  retrievedAt: 1_760_000_000_000, ingestedAt: 1_760_000_000_000, timeBasis: "unknown", collector: "google_news_rss",
  publisherName: "Example publisher", publisherDomain: "example.com", status: "pending", scoreRetryAt: null,
  usageCheckRequired: false, score: null, error: null,
});

const savedState = (mentionId: string, summary: string, provider: "openai" | "google_gemini" = "google_gemini") => ({
  result: {
    attemptId: `attempt-${mentionId}`, provider, modelRequested: provider === "openai" ? "gpt-6-luna" : "gemini-3.8-flash", modelReturned: provider === "openai" ? "gpt-6-luna" : "gemini-3.8-flash",
    sourceTimeAt: null, retrievedAt: 1_760_000_000_000, sentiment: "positive", eventType: "earnings", takeaway: "growth",
    evidenceSufficient: true, summary, supportingExcerpt: `${mentionId} excerpt`, disposition: "classified", createdAt: 1_760_000_000_001,
  },
  attempts: [],
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function setup(fetcher: typeof fetch) {
  vi.stubGlobal("fetch", fetcher);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (mention: Mention) => root.render(createElement(SourceModelAssessment, {
    mention, companyName: mention.companyId, ticker: mention.companyId.toUpperCase(),
  }));
  return { container, root, render };
}

async function unmount(root: Root, container: HTMLElement) {
  await act(async () => root.unmount());
  container.remove();
}

afterEach(() => vi.unstubAllGlobals());

describe("source model assessment state ownership", () => {
  it("hides the prior item's result and source link while the next item loads", async () => {
    const nextItem = deferred<Response>();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/model-providers/status") return jsonResponse(providerStatus);
      if (url.includes("/api/mentions/item-a/")) return jsonResponse(savedState("item-a", "Saved result for item A."));
      if (url.includes("/api/mentions/item-b/")) return nextItem.promise;
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const { container, root, render } = setup(fetcher);

    await act(async () => render(makeMention("item-a")));
    expect(container.textContent).toContain("Saved result for item A.");
    expect(container.querySelector('a[href="https://example.com/item-a"]')).not.toBeNull();

    await act(async () => render(makeMention("item-b")));
    expect(container.textContent).not.toContain("Saved result for item A.");
    expect(container.querySelector('a[href="https://example.com/item-a"]')).toBeNull();
    expect(container.querySelector('a[href="https://example.com/item-b"]')).toBeNull();

    await act(async () => {
      nextItem.resolve(jsonResponse(savedState("item-b", "Saved result for item B.")));
      await nextItem.promise;
    });
    expect(container.textContent).toContain("Saved result for item B.");
    expect(container.querySelector('a[href="https://example.com/item-b"]')).not.toBeNull();
    await unmount(root, container);
  });

  it("ignores a late assessment read after the selected source changes", async () => {
    const firstItem = deferred<Response>();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/model-providers/status") return jsonResponse(providerStatus);
      if (url.includes("/api/mentions/item-a/")) return firstItem.promise;
      if (url.includes("/api/mentions/item-b/")) return jsonResponse(savedState("item-b", "Current result for item B."));
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const { container, root, render } = setup(fetcher);

    await act(async () => render(makeMention("item-a")));
    await act(async () => render(makeMention("item-b")));
    expect(container.textContent).toContain("Current result for item B.");

    await act(async () => {
      firstItem.resolve(jsonResponse(savedState("item-a", "Late result for item A.")));
      await firstItem.promise;
    });
    expect(container.textContent).toContain("Current result for item B.");
    expect(container.textContent).not.toContain("Late result for item A.");
    expect(container.querySelector('a[href="https://example.com/item-b"]')).not.toBeNull();
    await unmount(root, container);
  });

  it("clears the prior provider result immediately when the provider changes", async () => {
    const openAiResult = deferred<Response>();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/api/model-providers/status") return jsonResponse(providerStatus);
      if (url.includes("provider=google_gemini")) return jsonResponse(savedState("item-a", "Gemini result for item A."));
      if (url.includes("provider=openai")) return openAiResult.promise;
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const { container, root, render } = setup(fetcher);

    await act(async () => render(makeMention("item-a")));
    expect(container.textContent).toContain("Gemini result for item A.");
    const providerSelect = container.querySelector("select")!;
    await act(async () => {
      providerSelect.value = "openai";
      providerSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(container.textContent).not.toContain("Gemini result for item A.");
    expect(container.querySelector('a[href="https://example.com/item-a"]')).toBeNull();
    expect(container.textContent).toContain("Loading saved assessment…");

    await act(async () => {
      openAiResult.resolve(jsonResponse(savedState("item-a", "OpenAI result for item A.", "openai")));
      await openAiResult.promise;
    });
    expect(container.textContent).toContain("OpenAI result for item A.");
    expect(container.textContent).toContain("OpenAI · gpt-6-luna");
    await unmount(root, container);
  });

  it("does not refresh the newly selected item after an older source request completes", async () => {
    const post = deferred<Response>();
    let postCalled = false;
    let postBody: Record<string, unknown> | null = null;
    const onClassificationSaved = vi.fn();
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/model-providers/status") return jsonResponse(providerStatus);
      if (url.includes("/api/mentions/item-a/model-classification") && init?.method === "POST") {
        postCalled = true;
        postBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return post.promise;
      }
      if (url.includes("/api/mentions/item-a/")) return jsonResponse({ result: null, attempts: [] });
      if (url.includes("/api/mentions/item-b/")) return jsonResponse(savedState("item-b", "Current result for item B."));
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const { container, root } = setup(fetcher);
    const render = (mention: Mention) => root.render(createElement(SourceModelAssessment, {
      mention, companyName: mention.companyId, ticker: mention.companyId.toUpperCase(), onClassificationSaved,
    }));

    await act(async () => render(makeMention("item-a")));
    const reviewButton = [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Review request"))!;
    await act(async () => reviewButton.click());
    expect(container.textContent).toContain("For API clients made available in the EEA, Switzerland, or UK, Google requires Paid Services through a Cloud project with active billing");
    expect(container.textContent).toContain("a free-tier-only project is not eligible");
    expect(container.textContent).toContain("Gemini 3.8 Flash paid-tier usage is metered");
    expect(container.textContent).toContain("If you require strictly $0 use in those regions, do not send this request");
    expect(container.textContent).toContain("Google's Gemini API terms limit use to professional or business purposes, not consumer use");
    expect(container.textContent).toContain("Sentiment Desk cannot determine whether your personal or retail-investing use meets that requirement");
    expect(container.textContent).not.toContain("may still have free quota available");
    expect(container.textContent).toContain("Send only the public, non-sensitive text shown here");
    expect(container.textContent).toContain("This app cannot verify your region, billing, eligibility, remaining quota, or charges");
    expect(container.textContent).not.toContain("PRIVATE NOTE");
    expect([...container.querySelectorAll("label")].some(label => label.textContent?.includes("the Desk cannot determine whether my personal or retail-investing use qualifies"))).toBe(true);
    const labels = [...container.querySelectorAll("label")];
    const dataConsent = labels.find(label => label.textContent?.includes("I reviewed this public item, confirmed it has no sensitive or confidential information"))!.querySelector("input")!;
    const paidServiceConsent = labels.find(label => label.textContent?.includes("I confirm its project uses Gemini API Paid Services with active Cloud Billing and accept that metered charges may apply"))!.querySelector("input")!;
    const sendButton = [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Send to Google Gemini"))!;
    expect((sendButton as HTMLButtonElement).disabled).toBe(true);
    await act(async () => dataConsent.click());
    expect((sendButton as HTMLButtonElement).disabled).toBe(true);
    expect(postCalled).toBe(false);
    await act(async () => paidServiceConsent.click());
    expect((sendButton as HTMLButtonElement).disabled).toBe(false);
    await act(async () => sendButton.click());
    expect(postCalled).toBe(true);
    expect(postBody).toMatchObject({ provider: "google_gemini", confirmDataSend: true, confirmGeminiPaidService: true });

    await act(async () => render(makeMention("item-b")));
    await act(async () => {
      post.resolve(jsonResponse({ result: savedState("item-a", "Completed result for item A.").result }));
      await post.promise;
    });
    expect(onClassificationSaved).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Current result for item B.");
    expect(container.textContent).not.toContain("Completed result for item A.");
    await unmount(root, container);
  });
});
