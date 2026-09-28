import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchGdeltArticles, GdeltHttpError } from "../server/sources/gdelt.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

    await expect(fetchGdeltArticles("Apple")).rejects.toMatchObject({
      name: "GdeltHttpError",
      message: "GDELT HTTP 429",
      status: 429,
    });
  });

  it("retains Retry-After seconds and HTTP dates on a 429", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-28T12:00:00.000Z"));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "120" },
    })));

    const error = await fetchGdeltArticles("Apple").catch((value: unknown) => value);
    expect(error).toBeInstanceOf(GdeltHttpError);
    expect(error).toMatchObject({ status: 429, retryAfterMs: 120_000 });

    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "Mon, 28 Sep 2026 12:03:00 GMT" },
    })));
    const datedError = await fetchGdeltArticles("Apple").catch((value: unknown) => value);
    expect(datedError).toMatchObject({ status: 429, retryAfterMs: 180_000 });
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
