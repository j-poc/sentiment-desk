import { z } from "zod";

const DAY_MS = 86_400_000;
export const MARKET_CAP_QUALIFICATION_VERSION = "dated-market-cap/1";
/** Proposed research band, not an index definition or an investment-merit rule. */
export const PROPOSED_SMALL_CAP_BAND = Object.freeze({
  currency: "USD", lowerInclusive: "300000000", upperExclusive: "2000000000",
} as const);

const identifier = z.string().min(1).max(256);
const cik = z.string().regex(/^\d{10}$/).refine((value) => /[1-9]/.test(value));
const accession = z.string().regex(/^\d{10}-\d{2}-\d{6}$/);
const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const time = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}).brand<"CalendarDate">();
const timestamp = z.string().datetime({ offset: true }).refine((value) => {
  const date = calendarDate.safeParse(value.slice(0, 10));
  return date.success && Number.isFinite(Date.parse(value));
}).brand<"Timestamp">();
const sourceReference = z.object({
  receiptId: identifier,
  responseSha256: z.string().regex(/^[a-f0-9]{64}$/),
  url: z.string().url().max(2048).refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch { return false; }
  }),
  location: z.string().min(1).max(1024),
  retrievedAt: timestamp,
}).strict();
const form = z.enum(["10-K", "10-Q", "10-K/A", "10-Q/A"]);
const amendment = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("original") }).strict(),
  z.object({ kind: z.literal("amendment"), originalAccession: accession.nullable() }).strict(),
]);
const shareClass = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("single_common_class"), id: identifier }).strict(),
  z.object({ kind: z.literal("ambiguous"), reason: identifier }).strict(),
]);
const identity = { companyId: identifier, cik, ticker: identifier };
const shareFact = z.object({
  id: identifier, companyId: identifier, cik, accession, form, acceptedAt: timestamp,
  taxonomy: identifier, concept: identifier, unit: identifier, value: z.string().max(96),
  measuredOn: calendarDate, shareClassId: identifier, amendment, source: sourceReference,
}).strict();
const dailyPrice = z.object({
  ...identity, id: identifier, shareClassId: identifier, date: calendarDate,
  close: z.string().max(96), currency: identifier,
  basis: z.enum(["raw_as_traded", "adjusted", "unknown"]),
  final: z.boolean(), source: sourceReference,
}).strict();
const actionBasis = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unresolved"), reason: identifier }).strict(),
  z.object({
    kind: z.literal("resolved"), ...identity, shareClassId: identifier,
    coverageFrom: calendarDate, coverageThrough: calendarDate,
    splitDates: z.array(calendarDate).max(1000), source: sourceReference,
  }).strict(),
]);

const qualificationInput = z.object({
  subject: z.object({ ...identity, accession, form, acceptedAt: timestamp,
    filingUrl: z.string().url().max(2048), shareClass }).strict(),
  policy: z.object({
    asOf: timestamp,
    maxMeasurementAgeDays: z.number().int().nonnegative().safe(),
    maxRetrievalAgeMs: z.number().int().nonnegative().safe(),
  }).strict(),
  shareFacts: z.array(shareFact).max(100),
  prices: z.array(dailyPrice).max(1000),
  actionBasis,
}).strict();

export type MarketCapQualificationInput = z.input<typeof qualificationInput>;
type ParsedInput = z.output<typeof qualificationInput>;
export type MarketCapWithheldReason =
  | "invalid_input" | "missing_share_fact" | "ambiguous_share_facts"
  | "issuer_mismatch" | "accession_mismatch" | "filing_metadata_mismatch"
  | "unsupported_share_concept" | "wrong_share_unit" | "invalid_share_value"
  | "amendment_unresolved" | "ambiguous_share_class" | "invalid_sec_source"
  | "source_unavailable_at_cutoff" | "invalid_source_timing" | "stale_source"
  | "future_measurement" | "stale_measurement" | "no_exact_date_price"
  | "ambiguous_prices" | "invalid_price_value" | "unsupported_currency"
  | "adjusted_price" | "unfinished_price" | "action_basis_unresolved"
  | "action_identity_mismatch" | "action_coverage_incomplete" | "split_on_measurement_date";

export type MarketCapQualificationResult = {
  kind: "withheld";
  policyVersion: typeof MARKET_CAP_QUALIFICATION_VERSION;
  reason: MarketCapWithheldReason;
} | {
  kind: "qualified";
  policyVersion: typeof MARKET_CAP_QUALIFICATION_VERSION;
  subject: ParsedInput["subject"];
  freshnessPolicy: ParsedInput["policy"];
  estimate: {
    label: "Dated estimated market capitalization";
    measuredOn: ParsedInput["shareFacts"][number]["measuredOn"];
    amount: string;
    currency: "USD";
    formula: "raw_daily_close_usd_per_share * reported_common_shares";
    rounding: "none; exact base-10 multiplication";
  };
  band: {
    kind: "inside_proposed_small_cap_band" | "below_proposed_band" | "at_or_above_proposed_band";
    definition: typeof PROPOSED_SMALL_CAP_BAND;
  };
  evidence: {
    shares: ParsedInput["shareFacts"][number];
    price: ParsedInput["prices"][number];
    actions: Extract<ParsedInput["actionBasis"], { kind: "resolved" }>;
  };
  interpretation: "Retrospective dated estimate; no current capitalization, historical market-knowledge, or investment-merit inference.";
};

function withheld(reason: MarketCapWithheldReason): MarketCapQualificationResult {
  return { kind: "withheld", policyVersion: MARKET_CAP_QUALIFICATION_VERSION, reason };
}

/** Exact bounded decimal tokens; monetary values never pass through a JS number. */
function positiveDecimal(token: string): { coefficient: bigint; scale: number } | null {
  const match = token.match(/^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
  if (!match) return null;
  const whole = match[1];
  if (whole === undefined) return null;
  const fraction = match[2] ?? "";
  const exponent = Number(match[3] ?? "0");
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 40) return null;
  const rawScale = fraction.length - exponent;
  if (rawScale > 40 || whole.length + fraction.length + Math.max(0, -rawScale) > 80) return null;
  const coefficient = BigInt(`${whole}${fraction}`) * 10n ** BigInt(Math.max(0, -rawScale));
  return coefficient > 0n ? { coefficient, scale: Math.max(0, rawScale) } : null;
}

function exactDecimalText(coefficient: bigint, scale: number): string {
  const digits = coefficient.toString().padStart(scale + 1, "0");
  if (scale === 0) return digits;
  const fraction = digits.slice(-scale).replace(/0+$/, "");
  return fraction ? `${digits.slice(0, -scale)}.${fraction}` : digits.slice(0, -scale);
}

function sourceTimingReason(source: z.output<typeof sourceReference>, policy: ParsedInput["policy"],
  earliest: number): MarketCapWithheldReason | null {
  const retrieved = Date.parse(source.retrievedAt);
  const cutoff = Date.parse(policy.asOf);
  if (retrieved > cutoff) return "source_unavailable_at_cutoff";
  if (retrieved < earliest) return "invalid_source_timing";
  return cutoff - retrieved > policy.maxRetrievalAgeMs ? "stale_source" : null;
}

function exactSecDocumentUrl(url: string, accessionNumber: string, issuerCik: string): boolean {
  const parsed = new URL(url);
  const match = parsed.pathname.match(/^\/Archives\/edgar\/data\/([1-9]\d{0,9})\/(\d{18})\/([^/]+\.(?:htm|html))$/);
  return parsed.protocol === "https:" && parsed.hostname === "www.sec.gov" && !parsed.port
    && !parsed.username && !parsed.password && !parsed.search && !parsed.hash
    && match?.[1] === BigInt(issuerCik).toString()
    && match?.[2] === accessionNumber.replaceAll("-", "") && !/%|\.\./.test(parsed.pathname);
}

/**
 * Qualify a source-selected share fact, not arbitrary CompanyFacts rows. Receipt
 * authenticity, extraction and calendar/session validation belong to ingestion.
 * Original filings only: amendments need a separately reviewed resolution policy.
 * The caller declares freshness and a fixed cutoff; this function has no clock,
 * network, storage, model, or merit-ranking side effects.
 */
export function qualifyMarketCapitalization(input: unknown): MarketCapQualificationResult {
  const parsed = qualificationInput.safeParse(input);
  if (!parsed.success) return withheld("invalid_input");
  const { subject, policy, shareFacts, prices, actionBasis: actions } = parsed.data;
  const [shares, duplicate] = shareFacts;
  if (!shares) return withheld("missing_share_fact");
  if (duplicate) return withheld("ambiguous_share_facts");
  if (shares.companyId !== subject.companyId || shares.cik !== subject.cik) return withheld("issuer_mismatch");
  if (shares.accession !== subject.accession) return withheld("accession_mismatch");
  if (shares.form !== subject.form || Date.parse(shares.acceptedAt) !== Date.parse(subject.acceptedAt)) {
    return withheld("filing_metadata_mismatch");
  }
  if (shares.taxonomy !== "dei" || shares.concept !== "EntityCommonStockSharesOutstanding") {
    return withheld("unsupported_share_concept");
  }
  if (shares.unit !== "shares") return withheld("wrong_share_unit");
  if (shares.amendment.kind !== "original" || shares.form.endsWith("/A")) return withheld("amendment_unresolved");
  if (subject.shareClass.kind !== "single_common_class" || shares.shareClassId !== subject.shareClass.id) {
    return withheld("ambiguous_share_class");
  }
  if (shares.source.url !== subject.filingUrl || !exactSecDocumentUrl(subject.filingUrl, subject.accession, subject.cik)) {
    return withheld("invalid_sec_source");
  }
  const measurementTime = Date.parse(`${shares.measuredOn}T00:00:00.000Z`);
  const cutoff = Date.parse(policy.asOf);
  const cutoffDate = new Date(cutoff).toISOString().slice(0, 10);
  const cutoffDay = Date.parse(`${cutoffDate}T00:00:00.000Z`);
  if (measurementTime > cutoffDay) return withheld("future_measurement");
  if ((cutoffDay - measurementTime) / DAY_MS > policy.maxMeasurementAgeDays) return withheld("stale_measurement");
  if (Date.parse(shares.acceptedAt) > cutoff) return withheld("source_unavailable_at_cutoff");
  if (Date.parse(shares.acceptedAt) < measurementTime) return withheld("invalid_source_timing");
  const sharesTiming = sourceTimingReason(shares.source, policy, Date.parse(shares.acceptedAt));
  if (sharesTiming) return withheld(sharesTiming);
  const shareValue = positiveDecimal(shares.value);
  if (!shareValue || shareValue.coefficient % 10n ** BigInt(shareValue.scale) !== 0n) return withheld("invalid_share_value");
  const shareCount = shareValue.coefficient / 10n ** BigInt(shareValue.scale);

  const matchingPrices = prices.filter((price) => price.date === shares.measuredOn);
  const [price, duplicatePrice] = matchingPrices;
  if (!price) return withheld("no_exact_date_price");
  if (duplicatePrice) return withheld("ambiguous_prices");
  if (price.companyId !== subject.companyId || price.cik !== subject.cik || price.ticker !== subject.ticker) {
    return withheld("issuer_mismatch");
  }
  if (price.shareClassId !== subject.shareClass.id) return withheld("ambiguous_share_class");
  if (price.currency !== "USD") return withheld("unsupported_currency");
  if (price.basis !== "raw_as_traded") return withheld("adjusted_price");
  if (!price.final) return withheld("unfinished_price");
  const priceTiming = sourceTimingReason(price.source, policy, measurementTime);
  if (priceTiming) return withheld(priceTiming);
  const close = positiveDecimal(price.close);
  if (!close) return withheld("invalid_price_value");
  if (actions.kind !== "resolved") return withheld("action_basis_unresolved");
  if (actions.companyId !== subject.companyId || actions.cik !== subject.cik || actions.ticker !== subject.ticker
    || actions.shareClassId !== subject.shareClass.id) return withheld("action_identity_mismatch");
  if (actions.coverageFrom > shares.measuredOn || actions.coverageThrough < shares.measuredOn
    || actions.coverageFrom > actions.coverageThrough || actions.coverageThrough > cutoffDate
    || actions.splitDates.some((date) => date < actions.coverageFrom || date > actions.coverageThrough)) {
    return withheld("action_coverage_incomplete");
  }
  const actionTiming = sourceTimingReason(actions.source, policy, measurementTime);
  if (actionTiming) return withheld(actionTiming);
  if (actions.splitDates.includes(shares.measuredOn)) return withheld("split_on_measurement_date");

  const amountCoefficient = close.coefficient * shareCount;
  const scale = 10n ** BigInt(close.scale);
  const band = amountCoefficient < BigInt(PROPOSED_SMALL_CAP_BAND.lowerInclusive) * scale
    ? "below_proposed_band" : amountCoefficient >= BigInt(PROPOSED_SMALL_CAP_BAND.upperExclusive) * scale
      ? "at_or_above_proposed_band" : "inside_proposed_small_cap_band";
  return {
    kind: "qualified", policyVersion: MARKET_CAP_QUALIFICATION_VERSION,
    subject, freshnessPolicy: policy,
    estimate: {
      label: "Dated estimated market capitalization", measuredOn: shares.measuredOn,
      amount: exactDecimalText(amountCoefficient, close.scale), currency: "USD",
      formula: "raw_daily_close_usd_per_share * reported_common_shares",
      rounding: "none; exact base-10 multiplication",
    },
    band: { kind: band, definition: { ...PROPOSED_SMALL_CAP_BAND } },
    evidence: { shares, price, actions },
    interpretation: "Retrospective dated estimate; no current capitalization, historical market-knowledge, or investment-merit inference.",
  };
}
