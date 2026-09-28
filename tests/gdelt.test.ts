import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGdeltArticles } from "../server/sources/gdelt.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GDELT response boundary", () => {
  it("rejects and sanitizes a plain-text HTTP-200 response", async () => {
    const providerText = "Queries considered but response unavailable";
    vi.stubGlobal("fetch", vi.fn(async () => new Response(providerText, {
      status: 200,
      headers: { "content-type": "text/plain" },
    })));

    const message = await fetchGdeltArticles("Apple").then(
      () => "unexpected success",
      (error: unknown) => error instanceof Error ? error.message : String(error),
    );
    expect(message).toBe("GDELT response was not valid JSON");
    expect(message).not.toContain(providerText);
  });

  it("preserves the provider HTTP status before attempting to parse a body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 429 })));

    await expect(fetchGdeltArticles("Apple")).rejects.toThrow("GDELT HTTP 429");
  });

  it("normalizes valid ArticleList JSON with the provider-seen timestamp", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      articles: [{
        url: "https://news.example/article",
        title: "Apple update",
        seendate: "20260928T080000Z",
        domain: "news.example",
      }],
    }), { status: 200, headers: { "content-type": "application/json" } })));

    await expect(fetchGdeltArticles("Apple")).resolves.toEqual([{
      title: "Apple update",
      url: "https://news.example/article",
      domain: "news.example",
      seenAt: Date.parse("2026-09-28T08:00:00.000Z"),
    }]);
  });
});
