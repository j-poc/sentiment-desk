import { describe, expect, it } from "vitest";
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
    expect(first?.tier).toBe("wire");
    expect(first?.publishedAt).toBe(Date.parse("Wed, 23 Sep 2026 10:00:00 GMT"));
    expect(first?.snippet).toContain("record data-center revenue");
    expect(first?.url).toContain("news.google.com");

    const second = items[1];
    expect(second?.sourceName).toBe("example.com");
    expect(second?.tier).toBe("trade");
  });

  it("returns empty for junk input", () => {
    expect(parseRss("not xml at all")).toEqual([]);
    expect(parseRss("<rss><channel><title>empty</title></channel></rss>")).toEqual([]);
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
  it("rejects a 200 HTML error page instead of reporting a successful empty feed", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>blocked</html>", { status: 200 })));
    try {
      await expect(fetchFeed("https://news.example/feed")).rejects.toThrow("not an RSS XML document");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
