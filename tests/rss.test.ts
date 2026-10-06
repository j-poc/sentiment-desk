import { describe, expect, it, afterEach } from "vitest";
import { vi } from "vitest";
import { fetchFeed, googleNewsUrl, parseRss } from "../server/sources/rss.js";

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>Google News</title>
<item>
  <title>NVIDIA beats quarterly estimates - Reuters</title>
  <link>https://news.google.com/rss/articles/abc123</link>
  <guid>https://news.google.com/rss/articles/abc123</guid>
  <pubDate>Wed, 23 Sep 2026 10:00:00 GMT</pubDate>
  <description>&lt;p&gt;Chip giant reports record data-center revenue&lt;/p&gt;</description>
  <source url="https://www.reuters.com">Reuters</source>
</item>
<item>
  <title>Single-item shape without a source node</title>
  <link>https://example.com/one</link>
</item>
</channel></rss>`;

describe("parseRss", () => {
  it("extracts items with provenance", () => {
    const items = parseRss(FIXTURE);
    expect(items.length).toBe(2);

    const first = items[0];
    expect(first?.title).toBe("NVIDIA beats quarterly estimates");
    expect(first?.sourceName).toBe("Reuters");
    expect(first?.publisherDomain).toBe("reuters.com");
    expect(first?.tier).toBe("wire");
    expect(first?.publishedAt).toBeNull();
    expect(first?.aggregatorPublishedAt).toBe(Date.parse("Wed, 23 Sep 2026 10:00:00 GMT"));
    expect(first?.snippet).toContain("record data-center revenue");
    expect(first?.url).toContain("news.google.com");

    const second = items[1];
    expect(second?.sourceName).toBe("example.com");
    expect(second?.tier).toBe("trade");
  });

  it("does not mislabel a Google News redirect host as the publisher domain", () => {
    const [item] = parseRss(`<rss><channel><item>
      <title>Acme article</title><link>https://news.google.com/rss/articles/abc</link>
      <source>Reuters</source>
    </item></channel></rss>`);

    expect(item?.sourceName).toBe("Reuters");
    expect(item?.publisherDomain).toBeNull();
  });

  it("returns empty for junk input", () => {
    expect(parseRss("not xml at all")).toEqual([]);
    expect(parseRss("<rss><channel><title>empty</title></channel></rss>")).toEqual([]);
  });

  it("preserves provider item count and reports rows discarded by normalization", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(`<rss><channel>
      <item><title>Usable news</title><link>https://news.example/story</link></item>
      <item><title>Missing link</title></item>
    </channel></rss>`, { status: 200 })));

    await expect(fetchFeed("https://news.example/feed")).resolves.toMatchObject({
      providerItemCount: 2,
      malformedItemCount: 1,
      items: [{ title: "Usable news", url: "https://news.example/story" }],
    });
  });

  it("rejects an RSS root with no channel rather than reporting an empty feed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<rss><entry/></rss>", { status: 200 })));
    await expect(fetchFeed("https://news.example/feed")).rejects.toThrow("RSS channel is missing or malformed");
  });

  it("rejects a non-empty scalar channel instead of reporting a valid empty feed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<rss><channel>provider error</channel></rss>", { status: 200 })));
    await expect(fetchFeed("https://news.example/feed")).rejects.toThrow("RSS channel is missing or malformed");
  });
});

describe("googleNewsUrl", () => {
  it("builds a bounded query per company", () => {
    const url = googleNewsUrl({ id: "nvidia", name: "NVIDIA", ticker: "NVDA", sector: "", aliases: ["Nvidia"], color: "#000000" });
    expect(url).toContain("news.google.com/rss/search");
    expect(decodeURIComponent(url)).toContain('"NVIDIA" OR "NVDA"');
    expect(decodeURIComponent(url)).toContain("when:2d");
  });
});

describe("fetchFeed", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects a 200 HTML error page instead of reporting a successful empty feed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>blocked</html>", { status: 200 })));
    try {
      await expect(fetchFeed("https://news.example/feed")).rejects.toThrow("not an RSS XML document");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("preserves Retry-After for a feed rate limit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "90" },
    })));

    await expect(fetchFeed("https://news.google.com/rss/search?q=NVDA")).rejects.toMatchObject({
      name: "ProviderRateLimitError",
      provider: "google_news",
      retryAfterMs: 90_000,
    });
  });
});
