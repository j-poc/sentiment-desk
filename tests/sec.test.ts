import { describe, expect, it } from "vitest";
import {
  eventForItems,
  parseRecent8Ks,
  titleForItems,
} from "../server/sources/sec.js";

const CIK = "0001045810";
const SINCE = Date.parse("2026-09-01T00:00:00Z");

function submissionsFixture(): object {
  return {
    filings: {
      recent: {
        form: ["8-K", "10-Q", "8-K", "S-8"],
        filingDate: ["2026-09-21", "2026-09-20", "2026-09-02", "2026-09-19"],
        acceptanceDateTime: [
          "2026-09-21T16:31:02.000Z",
          "2026-09-20T21:15:00.000Z",
          "2026-08-25T14:00:00.000Z",
          "2026-09-19T10:00:00.000Z",
        ],
        accessionNumber: ["0001045810-26-000101", "0001045810-26-000099", "0001045810-26-000042", "0001045810-26-000090"],
        primaryDocument: ["nvda-8k.htm", "nvda-10q.htm", "old-8k.htm", "s8.htm"],
        items: ["2.02,9.01", null, "5.02", null],
      },
    },
  };
}

describe("parseRecent8Ks", () => {
  it("extracts only recent 8-Ks with acceptance timestamps and typed items", () => {
    const filings = parseRecent8Ks(submissionsFixture() as never, CIK, "NVDA", SINCE);
    expect(filings.length).toBe(1); // the August 8-K is outside the window; 10-Q and S-8 filtered
    const f = filings[0];
    expect(f?.formType).toBe("8-K");
    expect(f?.items).toEqual(["2.02", "9.01"]);
    expect(f?.acceptanceAt).toBe(Date.parse("2026-09-21T16:31:02.000Z"));
    expect(f?.primaryDocUrl).toContain("/Archives/edgar/data/1045810/000104581026000101/nvda-8k.htm");
  });

  it("rejects misaligned recent-filing arrays instead of reporting no filings", () => {
    const body = submissionsFixture() as { filings: { recent: { accessionNumber: string[] } } };
    body.filings.recent.accessionNumber.pop();
    expect(() => parseRecent8Ks(body as never, CIK, "NVDA", SINCE))
      .toThrow("inconsistent lengths");
  });

  it("rejects a recent 8-K missing its acceptance timestamp", () => {
    const body = submissionsFixture() as {
      filings: { recent: { acceptanceDateTime: string[] } };
    };
    body.filings.recent.acceptanceDateTime[0] = "";
    expect(() => parseRecent8Ks(body as never, CIK, "NVDA", SINCE))
      .toThrow("missing its accession number or acceptance timestamp");
  });
});

describe("eventForItems", () => {
  it("maps item codes onto the event taxonomy, ignoring exhibit-only items", () => {
    expect(eventForItems(["2.02", "9.01"])).toBe("results");
    expect(eventForItems(["5.02"])).toBe("leadership");
    expect(eventForItems(["1.03"])).toBe("legal_regulatory");
    expect(eventForItems(["9.01"])).toBe("other");
    expect(eventForItems([])).toBe("other");
  });
});

describe("titleForItems", () => {
  it("renders a labeled title with extra-item count", () => {
    expect(titleForItems("8-K", ["2.02", "9.01"])).toBe(
      "8-K 2.02 — Results of Operations (+1 more)",
    );
    expect(titleForItems("8-K", [])).toBe("8-K filed");
  });
});
