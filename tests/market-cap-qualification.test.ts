import { describe, expect, it } from "vitest";
import {
  PROPOSED_SMALL_CAP_BAND,
  qualifyMarketCapitalization,
  type MarketCapQualificationInput,
  type MarketCapWithheldReason,
} from "../server/market-cap-qualification.js";

type ShareFact = MarketCapQualificationInput["shareFacts"][number];
type Price = MarketCapQualificationInput["prices"][number];

/** Isolated source-shaped fixtures only; these never enter runtime data. */
function fixture(): MarketCapQualificationInput {
  const filingUrl = "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/test-20260930.htm";
  const identity = { companyId: "test-issuer", cik: "0000000001", ticker: "TEST" };
  const filing = { accession: "0000000001-26-000001", form: "10-Q" as const,
    acceptedAt: "2026-10-07T12:00:00.000Z" };
  const source = { receiptId: "test-receipt", responseSha256: "a".repeat(64),
    retrievedAt: "2026-10-09T12:00:00.000Z", location: "test-source-location" };
  return {
    subject: { ...identity, ...filing, filingUrl, shareClass: { kind: "single_common_class", id: "common" } },
    policy: { asOf: "2026-10-09T13:00:00.000Z", maxMeasurementAgeDays: 30,
      maxRetrievalAgeMs: 24 * 60 * 60 * 1000 },
    shareFacts: [{ companyId: identity.companyId, cik: identity.cik, ...filing, id: "share-fact", taxonomy: "dei",
      concept: "EntityCommonStockSharesOutstanding", unit: "shares", value: "40000001",
      measuredOn: "2026-09-30", shareClassId: "common", amendment: { kind: "original" },
      source: { ...source, url: filingUrl } }],
    prices: [{ ...identity, id: "price-point", shareClassId: "common", date: "2026-09-30",
      close: "12.3456789", currency: "USD", basis: "raw_as_traded", final: true,
      source: { ...source, url: "https://prices.example.test/daily/TEST" } }],
    actionBasis: { kind: "resolved", ...identity, shareClassId: "common", coverageFrom: "2026-09-30",
      coverageThrough: "2026-09-30", splitDates: [],
      source: { ...source, url: "https://prices.example.test/splits/TEST" } },
  };
}

function updateShare(input: MarketCapQualificationInput, update: Partial<ShareFact>): void {
  const [share] = input.shareFacts;
  if (!share) throw new Error("Fixture share missing");
  input.shareFacts = [{ ...share, ...update }];
}

function updatePrice(input: MarketCapQualificationInput, update: Partial<Price>): void {
  const [price] = input.prices;
  if (!price) throw new Error("Fixture price missing");
  input.prices = [{ ...price, ...update }];
}

function expectWithheld(input: unknown, reason: MarketCapWithheldReason): void {
  const result = qualifyMarketCapitalization(input);
  expect(result).toEqual({ kind: "withheld", policyVersion: "dated-market-cap/1", reason });
  expect(result).not.toHaveProperty("estimate");
  expect(result).not.toHaveProperty("band");
}

describe("dated market-capitalization qualification", () => {
  it("computes the exact dated estimate and preserves all selected source lineage without mutating input", () => {
    const input = fixture();
    const before = structuredClone(input);
    const result = qualifyMarketCapitalization(input);
    expect(result.kind).toBe("qualified");
    if (result.kind !== "qualified") throw new Error("Expected a qualified fixture");
    expect(result.estimate).toEqual({
      label: "Dated estimated market capitalization", measuredOn: "2026-09-30",
      amount: "493827168.3456789", currency: "USD",
      formula: "raw_daily_close_usd_per_share * reported_common_shares",
      rounding: "none; exact base-10 multiplication",
    });
    expect(result.band).toEqual({ kind: "inside_proposed_small_cap_band", definition: PROPOSED_SMALL_CAP_BAND });
    expect(result.subject).toEqual(input.subject);
    expect(result.evidence.shares).toEqual(input.shareFacts[0]);
    expect(result.evidence.price).toEqual(input.prices[0]);
    expect(result.evidence.actions).toEqual(input.actionBasis);
    expect(result.freshnessPolicy).toEqual(input.policy);
    expect(result.interpretation).toContain("no current capitalization");
    result.evidence.shares.value = "1";
    expect(input).toEqual(before);
  });

  it.each([
    { shares: "9007199254740993", close: "1.01", expected: "9097271247288402.93" },
    { shares: "3e9", close: "0.1", expected: "300000000" },
    { shares: "40000001.000", close: "1.23456789e1", expected: "493827168.3456789" },
  ])("preserves decimal precision beyond binary floating point: $shares × $close", ({ shares, close, expected }) => {
    const input = fixture();
    updateShare(input, { value: shares });
    updatePrice(input, { close });
    const result = qualifyMarketCapitalization(input);
    expect(result.kind === "qualified" && result.estimate.amount).toBe(expected);
  });

  it.each([
    { value: "299999999.99999999", band: "below_proposed_band" },
    { value: "300000000", band: "inside_proposed_small_cap_band" },
    { value: "1999999999.99999999", band: "inside_proposed_small_cap_band" },
    { value: "2000000000", band: "at_or_above_proposed_band" },
  ])("applies the proposed USD band without rounding at $value", ({ value, band }) => {
    const input = fixture();
    updateShare(input, { value: "1" });
    updatePrice(input, { close: value });
    const result = qualifyMarketCapitalization(input);
    expect(result.kind === "qualified" && result.band.kind).toBe(band);
  });

  const invalidCases: Array<{ name: string; reason: MarketCapWithheldReason;
    change: (input: MarketCapQualificationInput) => void }> = [
    { name: "missing shares", reason: "missing_share_fact", change: (input) => { input.shareFacts = []; } },
    { name: "duplicate shares even when identical", reason: "ambiguous_share_facts",
      change: (input) => { input.shareFacts = [...input.shareFacts, ...input.shareFacts]; } },
    { name: "wrong company", reason: "issuer_mismatch", change: (input) => updateShare(input, { companyId: "other" }) },
    { name: "wrong CIK", reason: "issuer_mismatch", change: (input) => updateShare(input, { cik: "0000000002" }) },
    { name: "wrong accession", reason: "accession_mismatch",
      change: (input) => updateShare(input, { accession: "0000000001-26-000002" }) },
    { name: "wrong filing form", reason: "filing_metadata_mismatch", change: (input) => updateShare(input, { form: "10-K" }) },
    { name: "wrong acceptance", reason: "filing_metadata_mismatch",
      change: (input) => updateShare(input, { acceptedAt: "2026-10-07T13:00:00.000Z" }) },
    { name: "weighted-average shares", reason: "unsupported_share_concept",
      change: (input) => updateShare(input, { concept: "WeightedAverageNumberOfSharesOutstandingBasic" }) },
    { name: "diluted shares", reason: "unsupported_share_concept",
      change: (input) => updateShare(input, { concept: "WeightedAverageNumberOfDilutedSharesOutstanding" }) },
    { name: "wrong taxonomy", reason: "unsupported_share_concept", change: (input) => updateShare(input, { taxonomy: "us-gaap" }) },
    { name: "wrong unit", reason: "wrong_share_unit", change: (input) => updateShare(input, { unit: "USD" }) },
    { name: "fractional shares", reason: "invalid_share_value", change: (input) => updateShare(input, { value: "1.5" }) },
    { name: "amendment lineage", reason: "amendment_unresolved",
      change: (input) => updateShare(input, { amendment: { kind: "amendment", originalAccession: "0000000001-26-000000" } }) },
    { name: "amended form mislabeled original", reason: "amendment_unresolved", change: (input) => {
      input.subject.form = "10-Q/A"; updateShare(input, { form: "10-Q/A" });
    } },
    { name: "ambiguous class", reason: "ambiguous_share_class",
      change: (input) => { input.subject.shareClass = { kind: "ambiguous", reason: "multiple classes" }; } },
    { name: "wrong share class", reason: "ambiguous_share_class", change: (input) => updateShare(input, { shareClassId: "other" }) },
    { name: "no price", reason: "no_exact_date_price", change: (input) => { input.prices = []; } },
    { name: "later-only price", reason: "no_exact_date_price", change: (input) => updatePrice(input, { date: "2026-10-01" }) },
    { name: "nearest earlier price", reason: "no_exact_date_price", change: (input) => updatePrice(input, { date: "2026-09-29" }) },
    { name: "duplicate exact-date prices", reason: "ambiguous_prices",
      change: (input) => { input.prices = [...input.prices, ...input.prices]; } },
    { name: "wrong price company", reason: "issuer_mismatch", change: (input) => updatePrice(input, { companyId: "other" }) },
    { name: "wrong price CIK", reason: "issuer_mismatch", change: (input) => updatePrice(input, { cik: "0000000002" }) },
    { name: "wrong price symbol", reason: "issuer_mismatch", change: (input) => updatePrice(input, { ticker: "OTHER" }) },
    { name: "wrong price class", reason: "ambiguous_share_class", change: (input) => updatePrice(input, { shareClassId: "other" }) },
    { name: "wrong currency", reason: "unsupported_currency", change: (input) => updatePrice(input, { currency: "EUR" }) },
    { name: "adjusted price", reason: "adjusted_price", change: (input) => updatePrice(input, { basis: "adjusted" }) },
    { name: "unknown adjustment", reason: "adjusted_price", change: (input) => updatePrice(input, { basis: "unknown" }) },
    { name: "unfinished daily bar", reason: "unfinished_price", change: (input) => updatePrice(input, { final: false }) },
    { name: "stale measurement", reason: "stale_measurement", change: (input) => { input.policy.maxMeasurementAgeDays = 8; } },
    { name: "stale source", reason: "stale_source", change: (input) => { input.policy.maxRetrievalAgeMs = 3_599_999; } },
    { name: "unresolved actions", reason: "action_basis_unresolved",
      change: (input) => { input.actionBasis = { kind: "unresolved", reason: "missing split history" }; } },
    { name: "wrong action issuer", reason: "action_identity_mismatch", change: (input) => {
      if (input.actionBasis.kind === "resolved") input.actionBasis.cik = "0000000002";
    } },
    { name: "uncovered action date", reason: "action_coverage_incomplete", change: (input) => {
      if (input.actionBasis.kind === "resolved") input.actionBasis.coverageFrom = "2026-10-01";
    } },
    { name: "split on measurement date", reason: "split_on_measurement_date", change: (input) => {
      if (input.actionBasis.kind === "resolved") input.actionBasis.splitDates = ["2026-09-30"];
    } },
  ];
  it.each(invalidCases)("withholds $name", ({ change, reason }) => {
    const input = fixture(); change(input); expectWithheld(input, reason);
  });

  it.each(["", "0", "-1", "NaN", "Infinity", "1,000", " 1", "1e1000", "0.00000000000000000000000000000000000000001"])(
    "withholds malformed/nonpositive price %j", (close) => {
      const input = fixture(); updatePrice(input, { close }); expectWithheld(input, "invalid_price_value");
    });
  it.each(["", "0", "-1", "NaN", "Infinity", "1e1000"])("withholds malformed/nonpositive share count %j", (value) => {
    const input = fixture(); updateShare(input, { value }); expectWithheld(input, "invalid_share_value");
  });

  it("does not transform raw same-day price/shares for splits on other dates", () => {
    const input = fixture();
    if (input.actionBasis.kind === "resolved") {
      input.actionBasis.coverageFrom = "2026-09-01";
      input.actionBasis.coverageThrough = "2026-10-01";
      input.actionBasis.splitDates = ["2026-09-15", "2026-10-01"];
    }
    const result = qualifyMarketCapitalization(input);
    expect(result.kind === "qualified" && result.estimate.amount).toBe("493827168.3456789");
  });

  it("allows exact freshness boundaries", () => {
    const input = fixture(); input.policy.maxMeasurementAgeDays = 9; input.policy.maxRetrievalAgeMs = 3_600_000;
    expect(qualifyMarketCapitalization(input).kind).toBe("qualified");
  });

  it.each(["shares", "price", "actions"])("withholds future retrieval on %s evidence", (which) => {
    const input = fixture(); const source = { retrievedAt: "2026-10-09T13:00:00.001Z" };
    if (which === "shares") {
      const [share] = input.shareFacts;
      if (share) updateShare(input, { source: { ...share.source, ...source } });
    } else if (which === "price") {
      const [price] = input.prices;
      if (price) updatePrice(input, { source: { ...price.source, ...source } });
    } else if (input.actionBasis.kind === "resolved") Object.assign(input.actionBasis.source, source);
    expectWithheld(input, "source_unavailable_at_cutoff");
  });

  it("withholds filings unavailable by the selected cutoff", () => {
    const input = fixture(); input.subject.acceptedAt = "2026-10-10T12:00:00.000Z";
    updateShare(input, { acceptedAt: input.subject.acceptedAt }); expectWithheld(input, "source_unavailable_at_cutoff");
  });

  it("withholds a stale price even when the share and action receipts are fresh", () => {
    const input = fixture(); const [price] = input.prices;
    if (price) updatePrice(input, { source: { ...price.source, retrievedAt: "2026-10-08T12:59:59.999Z" } });
    expectWithheld(input, "stale_source");
  });

  it.each(["shares", "price", "actions"])("withholds %s evidence retrieved before its source date", (which) => {
    const input = fixture(); const retrievedAt = "2026-09-29T12:00:00.000Z";
    if (which === "shares") {
      const [share] = input.shareFacts;
      if (share) updateShare(input, { source: { ...share.source, retrievedAt } });
    } else if (which === "price") {
      const [price] = input.prices;
      if (price) updatePrice(input, { source: { ...price.source, retrievedAt } });
    } else if (input.actionBasis.kind === "resolved") input.actionBasis.source.retrievedAt = retrievedAt;
    expectWithheld(input, "invalid_source_timing");
  });

  it("normalizes the cutoff timezone before deciding whether a measurement is future", () => {
    const input = fixture(); input.policy.asOf = "2026-09-30T00:00:00.000+12:00";
    expectWithheld(input, "future_measurement");
  });

  it.each([
    "https://www.sec.gov/Archives/edgar/data/2/000000000126000001/test.htm",
    "https://www.sec.gov/Archives/edgar/data/1/000000000126000002/test.htm",
    "https://www.sec.gov.evil.test/Archives/edgar/data/1/000000000126000001/test.htm",
    "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/test.htm?unrelated=1",
  ])("withholds an SEC document URL that does not bind the selected issuer and accession: %s", (url) => {
    const input = fixture(); input.subject.filingUrl = url;
    const [share] = input.shareFacts;
    if (share) updateShare(input, { source: { ...share.source, url } });
    expectWithheld(input, "invalid_sec_source");
  });

  it("rejects malformed dates, missing evidence, coercion and unrecognized fields at the boundary", () => {
    const input = fixture(); const [share] = input.shareFacts; const [price] = input.prices;
    expectWithheld({ ...input, shareFacts: [{ ...share, measuredOn: "2026-02-30" }] }, "invalid_input");
    expectWithheld({ ...input, prices: [{ ...price, close: 12.34 }] }, "invalid_input");
    expectWithheld({ ...input, prices: [{ ...price, source: { ...price?.source, url: "not-a-url" } }] }, "invalid_input");
    expectWithheld({ ...input, shareFacts: [{ ...share, source: null }] }, "invalid_input");
    expectWithheld({ ...input, currentMarketCap: "300000000" }, "invalid_input");
    expectWithheld({ ...input, policy: { ...input.policy, asOf: "2026-10-09T13:00:00" } }, "invalid_input");
  });
});
