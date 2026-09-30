import { describe, expect, it } from "vitest";
import { quoteSourceAgeLabel } from "../web/src/lib/format.js";

const now = Date.parse("2026-09-28T08:00:00.000Z");

describe("quote source age labels", () => {
  it("leaves recent provider observations unlabeled as aged", () => {
    expect(quoteSourceAgeLabel(now - 15 * 60_000, now)).toBeNull();
  });

  it("labels a delayed source observation independently of retrieval", () => {
    expect(quoteSourceAgeLabel(now - 16 * 60_000, now)).toBe("source 16m ago");
  });

  it("identifies a quote whose provider observation time is unknown", () => {
    expect(quoteSourceAgeLabel(null, now)).toBe("source time unknown");
  });

  it("warns when the provider observation timestamp is ahead of the current time", () => {
    expect(quoteSourceAgeLabel(now + 1, now)).toBe("source time is in the future");
  });
});
