import { describe, expect, it } from "vitest";
import type { Mention } from "../web/src/lib/api.js";
import { mentionIsInWindow, mentionPageParams, mentionWindowHours } from "../web/src/lib/mention-window.js";

const now = Date.parse("2026-09-29T12:00:00.000Z");

function mention(times: Pick<Mention, "publishedAt" | "providerObservedAt" | "retrievedAt">): Mention {
  return {
    id: "item", companyId: "acme",
    source: { name: "Publisher", url: "https://example.test/item", kind: "rss", tier: "major", collector: "google_news_rss", publisher: "Publisher", publisherDomain: "example.test" },
    title: "Saved headline", snippet: "Saved text", ...times,
    ingestedAt: now, timeBasis: "publisher_declared", collector: "google_news_rss", publisherName: "Publisher", publisherDomain: "example.test",
    status: "scored", scoreRetryAt: null, usageCheckRequired: false,
    score: null, error: null,
  };
}

describe("selected mention windows", () => {
  it("uses the selected hours for scored and ordinary filters but preserves unscored recovery history", () => {
    expect(mentionWindowHours("all", 24)).toBe(24);
    expect(mentionWindowHours("bull", 72)).toBe(72);
    expect(mentionWindowHours("failed", 6)).toBe(0);
    expect(mentionWindowHours("history", 24)).toBe(0);
    expect(mentionPageParams("bull", 24).get("hours")).toBe("24");
    expect(mentionPageParams("failed", 0).has("hours")).toBe(false);
    expect(mentionPageParams("history", 0).has("hours")).toBe(false);
    expect(mentionPageParams("bull", 72, { orderAt: now - 1, ingestedAt: now, id: "older" }).get("cursor"))
      .toBe(JSON.stringify({ orderAt: now - 1, ingestedAt: now, id: "older" }));
  });

  it("applies server-equivalent time precedence to streamed items", () => {
    const boundary = now - 24 * 60 * 60 * 1000;
    expect(mentionIsInWindow(mention({ publishedAt: boundary, providerObservedAt: null, retrievedAt: now }), 24, now)).toBe(true);
    expect(mentionIsInWindow(mention({ publishedAt: boundary - 1, providerObservedAt: now, retrievedAt: now }), 24, now)).toBe(false);
    expect(mentionIsInWindow(mention({ publishedAt: null, providerObservedAt: boundary, retrievedAt: now }), 24, now)).toBe(true);
    expect(mentionIsInWindow(mention({ publishedAt: null, providerObservedAt: null, retrievedAt: boundary - 1 }), 24, now)).toBe(false);
    expect(mentionIsInWindow(mention({ publishedAt: boundary - 1, providerObservedAt: null, retrievedAt: boundary - 1 }), 0, now)).toBe(true);
  });
});
