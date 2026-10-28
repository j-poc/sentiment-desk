/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CloudCompanyUpdates } from "../web/src/components/CloudCompanyUpdates.js";
import type { CloudCompanyFact, CloudCompanyFiling } from "../shared/cloud-company-updates.js";

const cik = "0000320193";
const facts: CloudCompanyFact[] = [
  { id: "current", cik, taxonomy: "us-gaap", concept: "Revenues", unit: "USD", value_text: "120000000", period_start: "2025-10-01", period_end: "2025-12-31", filed_at: "2026-01-30", form: "10-Q", accession: "0000320193-26-000001", reported_decimals: "INF" },
  { id: "prior", cik, taxonomy: "us-gaap", concept: "Revenues", unit: "USD", value_text: "100000000", period_start: "2024-10-01", period_end: "2024-12-31", filed_at: "2026-01-30", form: "10-Q", accession: "0000320193-26-000001", reported_decimals: "INF" },
];
const filings: CloudCompanyFiling[] = [
  { id: "current-filing", cik, accession: "0000320193-26-000001", form: "10-Q", filed_at: "2026-01-30", accepted_at: "2026-01-30T15:00:00.000Z", primary_document: "aapl.htm", source_url: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/aapl.htm" },
];

describe("cloud company updates user surface", () => {
  beforeEach(() => { (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });

  it("shows reported change, source filing links, and retrieval time without sentiment claims", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<CloudCompanyUpdates cik={cik} facts={facts} filings={filings} retrievedAt="2026-01-31T10:00:00.000Z" coverageComplete />));
      expect(container.textContent).toContain("COMPANY UPDATES");
      expect(container.textContent).toContain("Reported increase");
      expect(container.textContent).toContain("+20%");
      expect(container.textContent).toContain("2026-01-31 10:00:00 UTC");
      expect([...container.querySelectorAll("a")].map((link) => link.href)).toEqual([filings[0]!.source_url, filings[0]!.source_url]);
      expect(container.textContent).not.toMatch(/bullish|bearish|materiality/i);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("labels an empty comparison as unknown instead of neutral", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<CloudCompanyUpdates cik={cik} facts={[facts[0]!]} filings={filings} retrievedAt={null} coverageComplete />));
      expect(container.textContent).toContain("no validated same-metric");
      expect(container.textContent).toContain("does not mean the business did not change");
      expect(container.textContent).not.toMatch(/neutral sentiment/i);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("keeps an SEC archive link available when the matching submissions row is outside the displayed snapshot", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<CloudCompanyUpdates cik={cik} facts={facts} filings={[]} retrievedAt={null} coverageComplete />));
      expect([...container.querySelectorAll<HTMLAnchorElement>("a")].map((link) => link.href)).toEqual([
        "https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/index.json",
        "https://www.sec.gov/Archives/edgar/data/320193/000032019326000001/index.json",
      ]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });

  it("discloses when comparison history hit its bound", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => root.render(<CloudCompanyUpdates cik={cik} facts={[facts[0]!]} filings={filings} retrievedAt={null} coverageComplete={false} />));
      expect(container.textContent).toContain("Some older updates may be missing");
      expect(container.textContent).toContain("within the loaded recent records");
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

afterEach(() => { document.body.innerHTML = ""; });
