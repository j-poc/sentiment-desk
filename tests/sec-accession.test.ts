import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchFilingByAccession } from "../server/sources/sec.js";
import { ProviderRateLimitError } from "../server/provider-cooldown.js";

const CIK = "0001310488";
const ACCESSION = "0001091818-26-000123";

afterEach(() => vi.unstubAllGlobals());

function submissions(overrides: Record<string, unknown> = {}): object {
  const recent = {
    form: ["10-Q", "8-K"],
    filingDate: ["2026-10-06", "2026-10-07"],
    reportDate: ["2026-09-30", "2026-10-07"],
    acceptanceDateTime: ["2026-10-06T13:10:00.000Z", "2026-10-07T15:01:02.000Z"],
    accessionNumber: ["0001310488-26-000111", ACCESSION],
    primaryDocument: ["bf-10q.htm", "bf-8k.htm"],
    items: [null, "2.02, 9.01"],
  };
  return {
    cik: 1310488,
    filings: { recent: { ...recent, ...overrides } },
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
}

const opts = { cik: CIK, accessionNo: ACCESSION, userAgent: "test-contact@example.com" };

describe("fetchFilingByAccession", () => {
  it("returns exact 8-K metadata from one issuer submissions request", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(submissions()));
    vi.stubGlobal("fetch", fetchMock);

    const filing = await fetchFilingByAccession(opts);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://data.sec.gov/submissions/CIK0001310488.json");
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ method: "GET", redirect: "manual" }));
    expect(filing).toEqual(expect.objectContaining({
      cik: CIK,
      ticker: "",
      accessionNo: ACCESSION,
      formType: "8-K",
      items: ["2.02", "9.01"],
      filedAt: Date.parse("2026-10-07T00:00:00.000Z"),
      reportDate: "2026-10-07",
      acceptanceAt: Date.parse("2026-10-07T15:01:02.000Z"),
      primaryDocUrl: "https://www.sec.gov/Archives/edgar/data/1310488/000109181826000123/bf-8k.htm",
    }));
    expect(filing?.metadataRetrievedAt).toEqual(expect.any(Number));
    expect(filing?.metadataRetrievedAt).toBeGreaterThan(0);
  });

  it("uses the filing index archive CIK independently from issuer and accession CIK", async () => {
    const accession = "0001193125-26-370420";
    const root = submissions({
      form: ["8-K"], filingDate: ["2026-08-27"], reportDate: ["2026-08-27"],
      acceptanceDateTime: ["2026-08-27T14:31:20.000Z"], accessionNumber: [accession],
      primaryDocument: ["d123.htm"], items: ["8.01"],
    }) as Record<string, unknown>;
    const payload = { ...root, cik: 751978 };
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(payload)));

    const filing = await fetchFilingByAccession({ cik: "0000751978", archiveCikPath: "1193125", accessionNo: accession,
      userAgent: "test-contact@example.com" });

    expect(filing).toMatchObject({ cik: "0000751978", accessionNo: accession,
      primaryDocUrl: "https://www.sec.gov/Archives/edgar/data/1193125/000119312526370420/d123.htm" });
  });

  it("rejects an 8-K/A accession as a non-match", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(submissions({ form: ["10-Q", "8-K/A"] }))));
    await expect(fetchFilingByAccession(opts)).resolves.toBeNull();
  });

  it("rejects a submissions payload for a different issuer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ ...submissions(), cik: 320193 })));
    await expect(fetchFilingByAccession(opts)).rejects.toThrow("issuer CIK did not match");
  });

  it("rejects inconsistent parallel arrays", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(submissions({ accessionNumber: ["0001310488-26-000111"] }))));
    await expect(fetchFilingByAccession(opts)).rejects.toThrow("inconsistent lengths");
  });

  it("rejects an acceptance value without an explicit timezone", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(submissions({ acceptanceDateTime: ["2026-10-06T13:10:00.000Z", "2026-10-07"] }))));
    await expect(fetchFilingByAccession(opts)).rejects.toThrow("timezone-qualified acceptance timestamp");
  });

  it("rejects a primary document path outside the exact issuer and accession directory", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(submissions({ primaryDocument: ["bf-10q.htm", "../other.htm"] }))));
    await expect(fetchFilingByAccession(opts)).rejects.toThrow("invalid primary document path");
  });

  it("returns null when the exact accession is absent", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(submissions())));
    await expect(fetchFilingByAccession({ ...opts, accessionNo: "0001310488-26-000999" })).resolves.toBeNull();
  });

  it("rejects duplicate exact accession rows", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(submissions({
      form: ["8-K", "8-K"],
      filingDate: ["2026-10-07", "2026-10-07"],
      reportDate: ["2026-10-07", "2026-10-07"],
      acceptanceDateTime: ["2026-10-07T15:01:02.000Z", "2026-10-07T15:02:02.000Z"],
      accessionNumber: [ACCESSION, ACCESSION],
      primaryDocument: ["bf-a.htm", "bf-b.htm"],
      items: ["2.02", "2.02"],
    }))));
    await expect(fetchFilingByAccession(opts)).rejects.toThrow("duplicate rows");
  });

  it("propagates network errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    await expect(fetchFilingByAccession(opts)).rejects.toThrow("network down");
  });

  it("preserves Retry-After in the typed SEC rate-limit error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", {
      status: 429,
      headers: { "retry-after": "90" },
    })));
    await expect(fetchFilingByAccession(opts)).rejects.toMatchObject({
      provider: "sec",
      retryAfterMs: 90_000,
      name: "ProviderRateLimitError",
      message: `SEC submissions HTTP 429 for CIK ${CIK}`,
    } satisfies Partial<ProviderRateLimitError>);
  });

  it("rejects redirects without following them", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 302, headers: { location: "https://example.com" } }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchFilingByAccession(opts)).rejects.toThrow("redirect rejected");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ redirect: "manual" }));
  });

  it("rejects a submissions response above the byte limit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", {
      headers: { "content-type": "application/json", "content-length": String(8 * 1024 * 1024 + 1) },
    })));
    await expect(fetchFilingByAccession(opts)).rejects.toThrow("exceeded its byte limit");
  });

  it("rejects streamed responses above the byte limit when the length header is absent", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(8 * 1024 * 1024));
        controller.enqueue(new Uint8Array(1));
        controller.close();
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(stream, { headers: { "content-type": "application/json" } })));
    await expect(fetchFilingByAccession(opts)).rejects.toThrow("exceeded its byte limit");
  });

  it("rejects an excessive number of recent filing rows", async () => {
    const rowCount = 10_001;
    const padded = (value: string) => [value, ...Array(rowCount - 1).fill(value)];
    const oversized = submissions({
      form: Array(rowCount).fill("10-Q"),
      filingDate: padded("2026-10-07"),
      reportDate: padded("2026-10-07"),
      acceptanceDateTime: padded("2026-10-07T15:01:02.000Z"),
      accessionNumber: padded("0001310488-26-000111"),
      primaryDocument: padded("bf-10q.htm"),
      items: Array(rowCount).fill(null),
    });
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(oversized)));
    await expect(fetchFilingByAccession(opts)).rejects.toThrow("row limit");
  });
});
