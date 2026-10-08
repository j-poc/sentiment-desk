import { describe, expect, it, vi } from "vitest";
import { SecFilingDetailService } from "../server/sec-filing-detail.js";
import { ProviderRateLimitError } from "../server/provider-cooldown.js";
import type { SecFilingInboxRow } from "../shared/sec-filings-inbox.js";
import type { SecFiling, SecFilingEvidence } from "../server/sources/sec.js";

const row: SecFilingInboxRow = {
  accession: "0001091818-26-000108", cik: "0001310488", accessionCik: "0001091818", filingCikPath: "0001310488",
  issuer: "BIOFORCE NANOSCIENCES HOLDINGS, INC.", form: "8-K", filedOn: "2026-08-18", acceptedAt: null,
  feedPublishedAt: null, feedUpdatedAt: null,
  filingUrl: "https://www.sec.gov/Archives/edgar/data/1310488/000109181826000108/0001091818-26-000108-index.htm",
};

const filing = {
  cik: row.cik, ticker: "", accessionNo: row.accession, formType: "8-K", items: ["2.02", "9.01"],
  filedAt: Date.parse("2026-08-18T00:00:00.000Z"), reportDate: "2026-06-30",
  acceptanceAt: Date.parse("2026-08-18T12:30:00.000Z"), metadataRetrievedAt: Date.parse("2026-10-07T10:00:00.000Z"),
  primaryDocUrl: "https://www.sec.gov/Archives/edgar/data/1310488/000109181826000108/form8-k.htm",
};

function evidence(
  overrides: Partial<SecFilingEvidence> = {},
  subject: { row: SecFilingInboxRow; filing: typeof filing } = { row, filing },
): SecFilingEvidence {
  const selectedUrl = subject.filing.primaryDocUrl.replace(/form8-k\.htm$/, "ex99-1.htm");
  const retrievedAt = subject.filing.metadataRetrievedAt! + 5;
  const excerpt = "Item 2.02. The registrant reported its results.";
  const bodySha256 = "a".repeat(64);
  return {
    context: {
      version: "sec-document-context/1", cik: subject.row.cik, accessionNo: subject.row.accession, primaryUrl: subject.filing.primaryDocUrl,
      acceptedAt: subject.filing.acceptanceAt, filedAt: subject.filing.filedAt, classificationInputStatus: "ready",
      selectionReason: "unique_exhibit_selected", item202Link: null, selectedRole: "earnings_exhibit_99_1",
      selectedUrl,
      documents: [{
        role: "earnings_exhibit_99_1", url: selectedUrl,
        startedAt: subject.filing.metadataRetrievedAt!, completedAt: retrievedAt, retrievedAt,
        httpStatus: 200, outcome: "success", bodyBytes: 1200, bodySha256,
        excerpt, errorCode: null,
      }],
    },
    selected: { role: "earnings_exhibit_99_1", url: selectedUrl, excerpt, retrievedAt, bodySha256 },
    result: "success", rateLimit: null, ...overrides,
  };
}

describe("on-demand SEC filing detail", () => {
  it("uses the exact saved issuer/accession and keeps report period distinct from filing and acceptance time", async () => {
    const fetchMetadata = vi.fn(async () => filing);
    const fetchEvidence = vi.fn(async () => evidence());
    const service = new SecFilingDetailService({ enabled: true, userAgent: "Desk contact", fetchMetadata, fetchEvidence });

    const result = await service.inspect(row);

    expect(fetchMetadata).toHaveBeenCalledExactlyOnceWith({ cik: row.cik, archiveCikPath: "0001310488", accessionNo: row.accession, userAgent: "Desk contact" });
    expect(fetchEvidence).toHaveBeenCalledExactlyOnceWith(filing, "Desk contact");
    expect(result).toMatchObject({ state: "ready", cik: row.cik, accession: row.accession, filingDate: "2026-08-18",
      reportDate: "2026-06-30", acceptedAt: "2026-08-18T12:30:00.000Z", metadataRetrievedAt: "2026-10-07T10:00:00.000Z",
      selectedRole: "earnings_exhibit_99_1", items: [{ code: "2.02", label: "Results of Operations" }, { code: "9.01", label: "Financial Statements and Exhibits" }] });
    expect(result.documents[0]?.excerpt).toBe("Item 2.02. The registrant reported its results.");
    expect(result.documents[0]?.bodySha256).toBe("a".repeat(64));
  });

  it("queries the real issuer CIK while keeping accession and archive-path CIKs distinct", async () => {
    const vicorRow: SecFilingInboxRow = {
      accession: "0001193125-26-370420", cik: "0000751978", accessionCik: "0001193125", filingCikPath: "1193125",
      issuer: "VICOR CORP", form: "8-K", filedOn: "2026-08-27", acceptedAt: null,
      feedPublishedAt: null, feedUpdatedAt: null,
      filingUrl: "https://www.sec.gov/Archives/edgar/data/1193125/000119312526370420/0001193125-26-370420-index.htm",
    };
    const vicorFiling = {
      ...filing, cik: vicorRow.cik, accessionNo: vicorRow.accession,
      primaryDocUrl: "https://www.sec.gov/Archives/edgar/data/1193125/000119312526370420/form8-k.htm",
    };
    const fetchMetadata = vi.fn(async (input) => {
      expect(input.cik).toBe("0000751978");
      expect(input.archiveCikPath).toBe("1193125");
      expect(input.accessionNo).toBe("0001193125-26-370420");
      expect(input).not.toHaveProperty("ticker");
      return vicorFiling;
    });
    const service = new SecFilingDetailService({ enabled: true, userAgent: "Desk contact", fetchMetadata,
      fetchEvidence: async () => evidence({}, { row: vicorRow, filing: vicorFiling }) });
    const result = await service.inspect(vicorRow);
    expect(result).toMatchObject({ state: "ready", cik: "0000751978", accession: "0001193125-26-370420" });
    expect(fetchMetadata).toHaveBeenCalledExactlyOnceWith({
      cik: "0000751978", archiveCikPath: "1193125", accessionNo: "0001193125-26-370420", userAgent: "Desk contact",
    });
  });

  it("makes no SEC request when source permission is closed", async () => {
    const fetchMetadata = vi.fn();
    const service = new SecFilingDetailService({ enabled: false, userAgent: "Desk contact", fetchMetadata });
    const result = await service.inspect(row);
    expect(result.state).toBe("paused");
    expect(result.filingUrl).toBe(row.filingUrl);
    expect(fetchMetadata).not.toHaveBeenCalled();
  });

  it("withholds mismatched metadata and does not fetch a document", async () => {
    const fetchEvidence = vi.fn();
    const service = new SecFilingDetailService({ enabled: true, userAgent: "Desk contact",
      fetchMetadata: async () => ({ ...filing, cik: "0000000320" }), fetchEvidence });
    expect((await service.inspect(row)).state).toBe("failed");
    expect(fetchEvidence).not.toHaveBeenCalled();
  });

  it("preserves an explicit partial result for unresolved item 2.02 evidence", async () => {
    const partial = evidence({ result: "partial", selected: null, context: { ...evidence().context,
      classificationInputStatus: "incomplete", selectionReason: "ambiguous_exhibit", selectedRole: null, selectedUrl: null, documents: [] } });
    const service = new SecFilingDetailService({ enabled: true, userAgent: "Desk contact",
      fetchMetadata: async () => filing, fetchEvidence: async () => partial });
    const result = await service.inspect(row);
    expect(result.state).toBe("partial");
    expect(result.selectionReason).toBe("ambiguous_exhibit");
    expect(result.documents).toEqual([]);
    expect(result.message).toMatch(/incomplete or could not be verified/i);
  });

  it("returns a rate-limited retry state without retrying the provider", async () => {
    const fetchMetadata = vi.fn(async () => { throw new ProviderRateLimitError("sec", 60_000); });
    const service = new SecFilingDetailService({ enabled: true, userAgent: "Desk contact", fetchMetadata });
    const result = await service.inspect(row);
    expect(result.state).toBe("rate_limited");
    expect(fetchMetadata).toHaveBeenCalledTimes(1);
  });

  it("coalesces simultaneous requests for the same issuer and accession", async () => {
    let complete!: (value: typeof filing) => void;
    const fetchMetadata = vi.fn(() => new Promise<typeof filing>((resolve) => { complete = resolve; }));
    const fetchEvidence = vi.fn(async () => evidence());
    const service = new SecFilingDetailService({ enabled: true, userAgent: "Desk contact", fetchMetadata, fetchEvidence });
    const first = service.inspect(row);
    const second = service.inspect(row);
    expect(fetchMetadata).toHaveBeenCalledTimes(1);
    complete(filing);
    await expect(Promise.all([first, second])).resolves.toMatchObject([{ state: "ready" }, { state: "ready" }]);
    expect(fetchEvidence).toHaveBeenCalledTimes(1);
  });

  it("does not coalesce a joint filing across distinct issuers sharing one accession", async () => {
    const jointRow: SecFilingInboxRow = { ...row, cik: "0000751978", issuer: "VICOR CORP" };
    const requests: Array<{ cik: string; accessionNo: string }> = [];
    const fetchMetadata = vi.fn(async (input) => {
      requests.push({ cik: input.cik, accessionNo: input.accessionNo });
      return { ...filing, cik: input.cik };
    });
    const fetchEvidence = vi.fn(async (value: SecFiling) => {
      const subjectRow = value.cik === row.cik ? row : jointRow;
      return evidence({}, { row: subjectRow, filing: { ...filing, cik: subjectRow.cik } });
    });
    const service = new SecFilingDetailService({ enabled: true, userAgent: "Desk contact", fetchMetadata, fetchEvidence });
    const [first, second] = await Promise.all([service.inspect(row), service.inspect(jointRow)]);
    expect(requests).toEqual([
      { cik: row.cik, accessionNo: row.accession },
      { cik: jointRow.cik, accessionNo: jointRow.accession },
    ]);
    expect(first.cik).toBe(row.cik);
    expect(second.cik).toBe(jointRow.cik);
    expect(fetchMetadata).toHaveBeenCalledTimes(2);
  });
});
