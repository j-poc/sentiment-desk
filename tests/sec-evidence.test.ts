import { afterEach, describe, expect, it, vi } from "vitest";
import { Desk } from "../server/db.js";
import { fetchFilingEvidence, type SecFiling } from "../server/sources/sec.js";

const primaryUrl = "https://www.sec.gov/Archives/edgar/data/2488/000000248826000121/amd.htm";
const exhibitUrl = "https://www.sec.gov/Archives/edgar/data/2488/000000248826000121/release.htm";
const fixtureFiling: SecFiling = { cik: "0000002488", ticker: "AMD", accessionNo: "0000002488-26-000121", formType: "8-K", items: ["2.02"], filedAt: 1_788_000_000_000, acceptanceAt: 1_788_000_100_000, primaryDocUrl: primaryUrl };
const parentWith = (prose: string, description = "Press Release") => `<p>Item 2.02 Results of Operations.</p>${prose}<table><tr><td>99.1</td><td>${description}</td><td><a href="release.htm">Release</a></td></tr></table>`;
const parentHtml = parentWith("<p>The company announced financial results in a press release that is attached hereto as Exhibit 99.1.</p>");
const exhibitHtml = "<html><body><p>Quarterly financial results</p></body></html>";

afterEach(() => vi.unstubAllGlobals());

describe("bounded SEC filing evidence adapter", () => {
  it("selects the explicit results exhibit and preserves request lineage", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input); calls.push(url);
      const body = url === primaryUrl ? parentHtml : exhibitHtml;
      return new Response(body, { status: 200, headers: { "content-type": "text/html", "content-length": String(Buffer.byteLength(body)) } });
    }));
    const result = await fetchFilingEvidence(fixtureFiling, "offline-fixture-test");
    expect(result.context.classificationInputStatus).toBe("ready");
    expect(result.selected?.url).toBe(exhibitUrl);
    expect(result.selected?.excerpt).toContain("Quarterly financial results");
    expect(result.selected?.bodySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.context.item202Link?.kind).toBe("linked");
    if (result.context.item202Link?.kind === "linked") expect(result.context.item202Link.supportingText.length).toBeLessThanOrEqual(1500);
    expect(result.context.documents.map((doc) => doc.role)).toEqual(["8k_primary", "earnings_exhibit_99_1"]);
    expect(result.context.documents[0]?.bodySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.context.documents[0]?.retrievedAt).toBeTypeOf("number");
    expect(calls).toEqual([primaryUrl, exhibitUrl]);
  });

  it("keeps nested hidden Item 2.02 and table markup from authorizing an exhibit request", async () => {
    const parent = `<div hidden><div>prefix</div><p>Item 2.02 Results of Operations. The company announced results in a press release that is attached hereto as Exhibit 99.1.</p><table hidden><tr><td>99.1</td><td>Press Release</td><td><a href="release.htm">Release</a></td></tr></table></div><p>Visible filing text without an Item 2.02 declaration.</p>`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(parent, { status: 200, headers: { "content-type": "text/html" } })));
    const result = await fetchFilingEvidence(fixtureFiling, "offline-fixture-test");
    expect(result.context.classificationInputStatus).toBe("incomplete");
    expect(result.selected).toBeNull();
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it("treats hidden input as a void element and keeps later visible filing content", async () => {
    const parent = `<input hidden>${parentHtml}`;
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input); calls.push(url);
      return new Response(url === primaryUrl ? parent : exhibitHtml, { status: 200, headers: { "content-type": "text/html" } });
    }));
    const result = await fetchFilingEvidence(fixtureFiling, "offline-fixture-test");
    expect(result.context.classificationInputStatus).toBe("ready");
    expect(calls).toEqual([primaryUrl, exhibitUrl]);
  });

  it("excludes concealed nested text from the selected exhibit excerpt", async () => {
    const concealedExhibit = `<div hidden><div>prefix</div><p>CONCEALED_FINANCIAL_TEXT</p></div><p>VISIBLE_RESULTS_TEXT</p>`;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => new Response(String(input) === primaryUrl ? parentHtml : concealedExhibit, { status: 200, headers: { "content-type": "text/html" } })));
    const result = await fetchFilingEvidence(fixtureFiling, "offline-fixture-test");
    expect(result.context.classificationInputStatus).toBe("ready");
    expect(result.selected?.excerpt).toContain("VISIBLE_RESULTS_TEXT");
    expect(result.selected?.excerpt).not.toContain("CONCEALED_FINANCIAL_TEXT");
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(2);
  });

  it("excludes concealed text from non-Item 2.02 evidence operations", async () => {
    const filing = { ...fixtureFiling, items: ["5.02"] };
    const primary = `<div hidden><div>prefix</div><p>CONCEALED_PRIMARY_TEXT</p></div><p>VISIBLE_PRIMARY_TEXT</p>`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(primary, { status: 200, headers: { "content-type": "text/html" } })));
    const result = await fetchFilingEvidence(filing, "offline-fixture-test");
    expect(result.context.classificationInputStatus).toBe("ready");
    expect(result.selected?.excerpt).toContain("VISIBLE_PRIMARY_TEXT");
    expect(result.selected?.excerpt).not.toContain("CONCEALED_PRIMARY_TEXT");
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it("rejects unsafe paths and conflicting candidate targets without fetching them", async () => {
    const filing: SecFiling = { cik: "0000002488", ticker: "AMD", accessionNo: "0000002488-26-000121", formType: "8-K", items: ["2.02"], filedAt: null, acceptanceAt: 1, primaryDocUrl: "https://www.sec.gov/Archives/edgar/data/2488/000000248826000121/amd.htm" };
    const root = "https://www.sec.gov/Archives/edgar/data/2488/000000248826000121/";
    expect((await import("../server/sources/sec.js")).findLinkedEarningsExhibit(`<table><tr><td>99.1</td><td><a href="${root}../escape.htm">release</a></td></tr></table>`, filing)).toEqual({ kind: "invalid" });
    expect((await import("../server/sources/sec.js")).findLinkedEarningsExhibit(`<table><tr><td>99.1</td><td><a href="//www.sec.gov/Archives/edgar/data/2488/000000248826000121/release.htm">release</a></td></tr></table>`, filing)).toEqual({ kind: "invalid" });
    expect((await import("../server/sources/sec.js")).findLinkedEarningsExhibit(`<table><tr><td>99.1</td><td><a href="one.htm">one</a><a href="two.htm">two</a></td></tr></table>`, filing)).toEqual({ kind: "ambiguous" });
  });

  it("selects an anchored exhibit number and anchored description after an empty spacer cell", async () => {
    const parent = `<p>Item 2.02 Results of Operations. The company announced financial results in a press release that is attached hereto as Exhibit 99.1.</p><table><tr><td><a>99.1</a></td><td></td><td><a href="release.htm">Press Release</a></td></tr></table>`;
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input); calls.push(url);
      return new Response(url === primaryUrl ? parent : exhibitHtml, { status: 200, headers: { "content-type": "text/html" } });
    }));
    const result = await fetchFilingEvidence(fixtureFiling, "offline-fixture-test");
    expect(result.context.classificationInputStatus).toBe("ready");
    expect(calls).toEqual([primaryUrl, exhibitUrl]);
  });

  it("does not fetch a 99.1 whose table description conflicts with the linked results release", async () => {
    const parent = parentWith("<p>The company announced financial results in a press release that is attached hereto as Exhibit 99.1.</p>", "Employment Agreement").replace("href=\"release.htm\"", "href=\"agreement.htm\"").replace(">Release</a>", ">Press Release</a>");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(parent, { status: 200, headers: { "content-type": "text/html" } })));
    const result = await fetchFilingEvidence(fixtureFiling, "offline-fixture-test");
    expect(result.context.classificationInputStatus).toBe("incomplete");
    expect(result.selected).toBeNull();
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it("keeps an Item 2.02 filing incomplete when the table has only an unrelated 99.1 and results are explicitly 99.2", async () => {
    const filing: SecFiling = { cik: "0000002488", ticker: "AMD", accessionNo: "0000002488-26-000121", formType: "8-K", items: ["2.02"], filedAt: null, acceptanceAt: 1, primaryDocUrl: "https://www.sec.gov/Archives/edgar/data/2488/000000248826000121/amd.htm" };
    const parent = `<p>Item 2.02 Results of Operations. The press release containing results is Exhibit 99.2.</p><table><tr><td>99.1</td><td>Employment Agreement</td><td><a href="https://www.sec.gov/Archives/edgar/data/2488/000000248826000121/exhibit991.htm">Agreement</a></td></tr><tr><td>99.2</td><td>Press Release</td><td><a href="https://www.sec.gov/Archives/edgar/data/2488/000000248826000121/release.htm">Results</a></td></tr></table>`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(parent, { status: 200, headers: { "content-type": "text/html" } })));
    const result = await fetchFilingEvidence(filing, "offline-fixture-test");
    expect(result.context.classificationInputStatus).toBe("incomplete");
    expect(result.selected).toBeNull();
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it("does not bind a later unrelated press-release attachment to an earlier results sentence", async () => {
    const filing: SecFiling = { cik: "0000002488", ticker: "AMD", accessionNo: "0000002488-26-000121", formType: "8-K", items: ["2.02"], filedAt: null, acceptanceAt: 1, primaryDocUrl: "https://www.sec.gov/Archives/edgar/data/2488/000000248826000121/amd.htm" };
    const parent = `<p>Item 2.02 Results of Operations. The company announced financial results for the quarter. It issued a press release about a chief executive change. This press release is attached as Exhibit 99.1.</p><table><tr><td>99.1</td><td>Press Release</td><td><a href="release.htm">Release</a></td></tr></table>`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(parent, { status: 200, headers: { "content-type": "text/html" } })));
    const result = await fetchFilingEvidence(filing, "offline-fixture-test");
    expect(result.context.classificationInputStatus).toBe("incomplete");
    expect(result.selected).toBeNull();
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it("does not bind a separately introduced CEO-change release to the results release", async () => {
    const parent = `<p>Item 2.02 Results of Operations. The company issued a press release announcing financial results for the quarter. A separate press release about the chief executive change is attached as Exhibit 99.1.</p><table><tr><td>99.1</td><td>Press Release</td><td><a href="ceo.htm">Press Release</a></td></tr></table>`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(parent, { status: 200, headers: { "content-type": "text/html" } })));
    const result = await fetchFilingEvidence(fixtureFiling, "offline-fixture-test");
    expect(result.context.classificationInputStatus).toBe("incomplete");
    expect(result.selected).toBeNull();
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["release to update", "The company issued a press release announcing financial results for the quarter. The full text of the update is attached as Exhibit 99.1."],
    ["results assigned to 99.2", "The company issued a press release announcing financial results for the quarter in Exhibit 99.2. The press release is also attached as Exhibit 99.1."],
    ["same-sentence second release", "The company announced results in a press release about financial results, and a separate press release about the CEO change is attached as Exhibit 99.1."],
    ["qualified definite subject", "The company issued a press release announcing financial results for the quarter. The press release announcing the appointment of a new CEO is attached as Exhibit 99.1."],
  ])("fails closed on %s rather than switching artifact identity", async (_name, prose) => {
    const parent = parentWith(`<p>${prose}</p>`);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(parent, { status: 200, headers: { "content-type": "text/html" } })));
    const result = await fetchFilingEvidence(fixtureFiling, "offline-fixture-test");
    expect(result.context.classificationInputStatus).toBe("incomplete");
    expect(result.selected).toBeNull();
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it("does not bridge nonterminal boilerplate in a separate visible paragraph", async () => {
    const parent = `<p>Item 2.02 Results of Operations.</p><p>The company announced financial results for the quarter</p><p>It issued a press release about a chief executive change</p><p>This press release is attached as Exhibit 99.1.</p><table><tr><td>99.1</td><td>Press Release</td><td><a href="release.htm">Release</a></td></tr></table>`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(parent, { status: 200, headers: { "content-type": "text/html" } })));
    const result = await fetchFilingEvidence(fixtureFiling, "offline-fixture-test");
    expect(result.context.classificationInputStatus).toBe("incomplete");
    expect(result.selected).toBeNull();
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it("does not treat a table-of-contents Item 2.02 link as the body event relationship", async () => {
    const filing = fixtureFiling;
    const parent = `<table><tr><td>Item 2.02 Results of Operations</td><td>The press release is attached as Exhibit 99.1</td><td><a href="release.htm">Release</a></td></tr></table><p>Item 2.02 Results of Operations.</p><p>The company announced financial results for the quarter. The information in this report is furnished.</p><table><tr><td>99.1</td><td>Press Release</td><td><a href="release.htm">Release</a></td></tr></table>`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(parent, { status: 200, headers: { "content-type": "text/html" } })));
    const result = await fetchFilingEvidence(filing, "offline-fixture-test");
    expect(result.context.classificationInputStatus).toBe("incomplete");
    expect(result.selected).toBeNull();
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["shareholder letter", "<p>The company announced financial results for the quarter.</p><p>The Letter to Shareholders, which is attached hereto as Exhibit 99.1 and is incorporated herein by reference, includes reference to the non-GAAP financial information.</p><p>A reconciliation to the GAAP equivalent is contained in Exhibit 99.1.</p>", "Letter to Shareholders"],
    ["results update", "<p>The company released financial results by posting its Second Quarter Update.</p><p>The full text of the update is attached hereto as Exhibit 99.1.</p>", "Second Quarter Update"],
    ["supplementary 99.2", "<p>The company announced financial results in a press release that is attached hereto as Exhibit 99.1. Additional non-GAAP information is in Exhibit 99.2.</p>", "Press Release"],
    ["named results release", "<p>The company issued a press release announcing financial results.</p><p>A copy of this press release is furnished and attached hereto as Exhibit 99.1.</p>", "Press Release"],
    ["Alphabet conference-call declaration", "<p>Alphabet Inc. is issuing a press release and holding a conference call regarding its financial results.</p><p>A copy of the press release is furnished as Exhibit 99.1.</p>", "Press Release"],
  ])("supports the bounded %s relationship", async (_name, prose, description) => {
    const parent = parentWith(prose, description);
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = String(input); calls.push(url);
      return new Response(url === primaryUrl ? parent : exhibitHtml, { status: 200, headers: { "content-type": "text/html" } });
    }));
    const result = await fetchFilingEvidence(fixtureFiling, "offline-fixture-test");
    expect(result.context.classificationInputStatus).toBe("ready");
    expect(result.selected?.url).toBe(exhibitUrl);
    expect(calls).toEqual([primaryUrl, exhibitUrl]);
  });

  it.each([
    ["generic furnished boilerplate", `<p>Item 2.02 Results of Operations. The company announced financial results for the quarter.</p><p>The information in this report, including Exhibit 99.1, is furnished and not deemed filed.</p>`],
    ["comment-only attachment statement", `<p>Item 2.02 Results of Operations. The company announced financial results for the quarter.</p><!-- The press release is attached as Exhibit 99.1. --><p>The information is furnished.</p>`],
    ["hidden attachment statement", `<p>Item 2.02 Results of Operations. The company announced financial results for the quarter.</p><div hidden><p>The press release is attached as Exhibit 99.1.</p></div>`],
    ["Item 5.02-only relationship", `<p>Item 2.02 Results of Operations. The company announced financial results for the quarter.</p><p>Item 5.02 Changes in Officers. The press release is attached as Exhibit 99.1.</p>`],
  ])("does not authorize an exhibit fetch from %s", async (_name, section) => {
    const filing: SecFiling = { cik: "0000002488", ticker: "AMD", accessionNo: "0000002488-26-000121", formType: "8-K", items: ["2.02"], filedAt: null, acceptanceAt: 1, primaryDocUrl: "https://www.sec.gov/Archives/edgar/data/2488/000000248826000121/amd.htm" };
    const parent = `${section}<table><tr><td>99.1</td><td>Press Release</td><td><a href="release.htm">Release</a></td></tr></table>`;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(parent, { status: 200, headers: { "content-type": "text/html" } })));
    const result = await fetchFilingEvidence(filing, "offline-fixture-test");
    expect(result.selected).toBeNull();
    expect(result.context.selectionReason).toBe("unverified_event_link");
    expect(vi.mocked(globalThis.fetch)).toHaveBeenCalledTimes(1);
  });

  it("records a primary 429 as an attempted operation with durable-retry metadata", async () => {
    const filing: SecFiling = { cik: "0000002488", ticker: "AMD", accessionNo: "0000002488-26-000121", formType: "8-K", items: ["2.02"], filedAt: null, acceptanceAt: 1, primaryDocUrl: "https://www.sec.gov/Archives/edgar/data/2488/000000248826000121/amd.htm" };
    vi.stubGlobal("fetch", vi.fn(async () => new Response("rate limited", { status: 429, headers: { "retry-after": "120" } })));
    const result = await fetchFilingEvidence(filing, "offline-fixture-test");
    expect(result.result).toBe("rate_limited");
    expect(result.rateLimit).toEqual({ retryAfterMs: 120_000, phase: "8k_primary" });
    expect(result.context.documents).toMatchObject([{ outcome: "rate_limited", httpStatus: 429, retrievedAt: null, bodySha256: null }]);
  });

  it("records an exhibit 429 after the parent attempt and selects no input", async () => {
    const filing: SecFiling = { cik: "0000002488", ticker: "AMD", accessionNo: "0000002488-26-000121", formType: "8-K", items: ["2.02"], filedAt: null, acceptanceAt: 1, primaryDocUrl: "https://www.sec.gov/Archives/edgar/data/2488/000000248826000121/amd-20260804.htm" };
    const parent = parentHtml;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => String(input) === filing.primaryDocUrl
      ? new Response(parent, { status: 200, headers: { "content-type": "text/html" } })
      : new Response("rate limited", { status: 429, headers: { "retry-after": "60" } })));
    const result = await fetchFilingEvidence(filing, "offline-fixture-test");
    expect(result.result).toBe("rate_limited");
    expect(result.rateLimit).toEqual({ retryAfterMs: 60_000, phase: "earnings_exhibit_99_1" });
    expect(result.context.documents).toHaveLength(2);
    expect(result.context.documents[0]?.bodySha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.context.documents[1]).toMatchObject({ outcome: "rate_limited", httpStatus: 429, retrievedAt: null, bodySha256: null });
    expect(result.selected).toBeNull();
  });

  it.each([
    ["redirect", () => new Response(null, { status: 302, headers: { location: "https://example.com/redirect.html" } }), "redirect_rejected"],
    ["non-HTML exhibit", () => new Response("not html", { status: 200, headers: { "content-type": "text/plain" } }), "content_type"],
    ["advertised oversize body", () => new Response("small", { status: 200, headers: { "content-type": "text/html", "content-length": "2097153" } }), "body_too_large"],
  ])("rejects an exhibit %s without a body digest", async (_name, response, errorCode) => {
    const filing: SecFiling = { cik: "0000002488", ticker: "AMD", accessionNo: "0000002488-26-000121", formType: "8-K", items: ["2.02"], filedAt: null, acceptanceAt: 1, primaryDocUrl: "https://www.sec.gov/Archives/edgar/data/2488/000000248826000121/amd-20260804.htm" };
    const parent = parentHtml;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => String(input) === filing.primaryDocUrl
      ? new Response(parent, { status: 200, headers: { "content-type": "text/html" } }) : response()));
    const result = await fetchFilingEvidence(filing, "offline-fixture-test");
    expect(result.selected).toBeNull();
    expect(result.context.documents[1]).toMatchObject({ outcome: "invalid", errorCode, bodySha256: null, retrievedAt: null });
  });

  it("cancels an exhibit stream when actual received bytes exceed the limit", async () => {
    const filing: SecFiling = { cik: "0000002488", ticker: "AMD", accessionNo: "0000002488-26-000121", formType: "8-K", items: ["2.02"], filedAt: null, acceptanceAt: 1, primaryDocUrl: "https://www.sec.gov/Archives/edgar/data/2488/000000248826000121/amd-20260804.htm" };
    const parent = parentHtml;
    let cancelled = false;
    let sent = false;
    let sentOverflow = false;
    const oversized = new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) { sent = true; controller.enqueue(new Uint8Array(1_500_000)); }
        else if (!sentOverflow) { sentOverflow = true; controller.enqueue(new Uint8Array(600_000)); }
      },
      cancel() { cancelled = true; },
    }), { status: 200, headers: { "content-type": "text/html" } });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => String(input) === filing.primaryDocUrl
      ? new Response(parent, { status: 200, headers: { "content-type": "text/html" } }) : oversized));
    const result = await fetchFilingEvidence(filing, "offline-fixture-test");
    expect(result.selected).toBeNull();
    expect(result.context.documents[1]).toMatchObject({ outcome: "invalid", errorCode: "body_too_large", bodySha256: null, retrievedAt: null });
    expect(result.context.documents[1]?.bodyBytes).toBeGreaterThan(2_097_152);
    expect(cancelled).toBe(true);
  });

  it.each([
    ["redirect", 302, { location: "https://example.com/elsewhere.html" }, "text/html"],
    ["HTTP failure", 404, {}, "text/html"],
    ["wrong content type", 200, {}, "text/plain"],
    ["advertised oversized body", 200, { "content-length": "2097153" }, "text/html"],
  ])("cancels unread response body for %s", async (_name, status, extraHeaders, contentType) => {
    const filing = { ...fixtureFiling, primaryDocUrl: primaryUrl };
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); },
      cancel() { cancelled = true; },
    });
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => String(input) === primaryUrl
      ? new Response(body, { status, headers: { "content-type": contentType, ...extraHeaders } })
      : new Response(exhibitHtml, { status: 200, headers: { "content-type": "text/html" } })));
    const result = await fetchFilingEvidence(filing, "offline-fixture-test");
    expect(result.selected).toBeNull();
    expect(cancelled).toBe(true);
  });

  it("preserves received HTTP status if a body stream fails before completion", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.error(new Error("truncated")); },
    }), { status: 200, headers: { "content-type": "text/html" } })));
    const result = await fetchFilingEvidence(fixtureFiling, "offline-fixture-test");
    expect(result.context.documents[0]).toMatchObject({ outcome: "failed", httpStatus: 200, retrievedAt: null, bodySha256: null });
  });

  it("persists SEC-only context and projects it with the selected immutable observation", async () => {
    const cik = "0000002488", accessionNo = "0000002488-26-000121";
    const directory = "https://www.sec.gov/Archives/edgar/data/2488/000000248826000121/";
    const filing: SecFiling = { cik, ticker: "AMD", accessionNo, formType: "8-K", items: ["2.02", "9.01"], filedAt: 1_788_000_000_000, acceptanceAt: 1_788_000_100_000, primaryDocUrl: `${directory}amd-20260804.htm` };
    const parent = parentHtml;
    const exhibit = exhibitHtml;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const body = String(input) === filing.primaryDocUrl ? parent : exhibit;
      return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
    }));
    const evidence = await fetchFilingEvidence(filing, "offline-fixture-test");
    expect(evidence.selected).not.toBeNull();
    const db = new Desk(":memory:");
    db.seedCompanies([{ id: "amd", name: "AMD", ticker: "AMD", sector: "Semiconductors", aliases: ["AMD"], color: "#123456" }]);
    try {
      const deliveryId = db.recordDelivery({ collector: "sec_edgar", companyId: "amd", requestKey: `sec:${cik}:8-k-evidence:${accessionNo}`, startedAt: 1_800_000_000_000, completedAt: 1_800_000_000_100, result: "success", parsedItemCount: 1, responseDigest: "operation-digest", adapterVersion: "sec-filing-evidence/1", processingRequired: true, secDocumentContext: evidence.context });
      expect(db.secDeliveryContext(deliveryId)).toEqual(evidence.context);
      const selected = evidence.selected!;
      db.insertObservation({ companyId: "amd", kind: "sec", scoped: true, sourceName: "SEC EDGAR", sourceUrl: selected.url, tier: "filing", title: "8-K Item 2.02", snippet: selected.excerpt, publishedAt: filing.acceptanceAt, filedAt: filing.filedAt!, retrievedAt: selected.retrievedAt, collector: "sec_edgar", sourceItemId: accessionNo, deliveryId, publisherName: "SEC EDGAR", publisherDomain: "sec.gov", adapterVersion: "sec-filing-evidence/1", responseDigest: selected.bodySha256 });
      const dto = db.mentionsForCompany("amd", 0, 10)[0]!;
      expect(dto.source.url).toBe(selected.url);
      expect(dto.secDocumentContext?.documents).toHaveLength(2);
      expect(dto.secDocumentContext?.documents[0]?.bodySha256).toBeTruthy();
      expect(dto.secDocumentContext?.documents[1]?.url).toBe(selected.url);
      expect(() => db.insertObservation({ companyId: "amd", kind: "sec", scoped: true, sourceName: "SEC EDGAR", sourceUrl: selected.url, tier: "filing", title: "8-K Item 2.02", snippet: "forged mismatch", publishedAt: filing.acceptanceAt, filedAt: filing.filedAt!, retrievedAt: selected.retrievedAt, collector: "sec_edgar", sourceItemId: accessionNo, deliveryId, publisherName: "SEC EDGAR", publisherDomain: "sec.gov", adapterVersion: "sec-filing-evidence/1" })).toThrow("does not match its selected filing document evidence");
      for (const changed of [
        { responseDigest: undefined },
        { responseDigest: "different-digest" },
        { publishedAt: filing.acceptanceAt + 1, responseDigest: selected.bodySha256 },
        { filedAt: filing.filedAt! + 1, responseDigest: selected.bodySha256 },
      ]) expect(() => db.insertObservation({ companyId: "amd", kind: "sec", scoped: true, sourceName: "SEC EDGAR", sourceUrl: selected.url, tier: "filing", title: "8-K Item 2.02", snippet: selected.excerpt, publishedAt: changed.publishedAt ?? filing.acceptanceAt, filedAt: changed.filedAt ?? filing.filedAt!, retrievedAt: selected.retrievedAt, collector: "sec_edgar", sourceItemId: accessionNo, deliveryId, publisherName: "SEC EDGAR", publisherDomain: "sec.gov", adapterVersion: "sec-filing-evidence/1", responseDigest: changed.responseDigest })).toThrow("does not match its selected filing document evidence");
    } finally { db.close(); }
  });
});
