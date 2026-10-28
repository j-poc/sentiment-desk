import { describe, expect, it } from "vitest";
import { readBoundedPages } from "../web/src/lib/bounded-pages.js";

describe("bounded page reads", () => {
  it("reads every page and recognizes a complete result exactly at the row limit", async () => {
    const rows = Array.from({ length: 4 }, (_, index) => index);
    const pages: Array<[number, number]> = [];
    const result = await readBoundedPages(async (offset, limit) => {
      pages.push([offset, limit]);
      return { data: rows.slice(offset, offset + limit), error: null };
    }, 2, 4);
    expect(result).toEqual({ rows, complete: true });
    expect(pages).toEqual([[0, 2], [2, 2], [4, 1]]);
  });

  it("marks results incomplete only when a row exists beyond the cap", async () => {
    const result = await readBoundedPages(async (offset, limit) => ({
      data: [0, 1, 2, 3, 4].slice(offset, offset + limit), error: null,
    }), 2, 4);
    expect(result).toEqual({ rows: [0, 1, 2, 3], complete: false });
  });

  it("propagates page errors instead of presenting a partial result as complete", async () => {
    await expect(readBoundedPages(async () => ({ data: null, error: new Error("read failed") }), 2, 4))
      .rejects.toThrow("read failed");
  });
});
