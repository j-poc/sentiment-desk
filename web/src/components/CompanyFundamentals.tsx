import "./company-fundamentals.css";
import { useEffect, useRef, useState } from "react";
import { getCompanyEvidenceAssessment, requestCompanyEvidenceAssessment } from "../lib/api.js";
import { GEMINI_PURPOSE_DISCLOSURE } from "../lib/gemini-purpose-disclosure.js";
import type { CompanyAssessmentReadback, CompanyAssessmentResult } from "../../../shared/company-evidence-assessment.js";
import type {
  FundamentalComparison,
  FundamentalMetricKey,
  FundamentalsState,
  PersistedFundamentalFact,
  PersistedFundamentalPoint,
} from "../../../shared/company-fundamentals.js";
type FundamentalDisplayFact = Omit<PersistedFundamentalFact,
  "companyId" | "companyFactsDeliveryId" | "submissionsDeliveryId">;
export type { FundamentalComparison, FundamentalMetricKey, FundamentalsState, PersistedFundamentalFact, PersistedFundamentalPoint } from "../../../shared/company-fundamentals.js";

export interface CompanyFundamentalsProps {
  companyId?: string;
  snapshotId?: string | null;
  companyName: string;
  ticker: string;
  state: FundamentalsState;
  facts: readonly FundamentalDisplayFact[];
  comparisons: readonly FundamentalComparison[];
  points: readonly PersistedFundamentalPoint[];
  coverage: readonly string[];
  refreshAllowed: boolean;
  refreshBlockedReason?: string | null;
  lastRefreshError?: string | null;
  staleReason?: string | null;
  onRefresh: () => void;
}

const METRICS: readonly FundamentalMetricKey[] = ["revenue", "operating_income", "net_income", "operating_cash_flow"];
const METRIC_LABELS: Record<FundamentalMetricKey, string> = {
  revenue: "Revenue",
  operating_income: "Operating income",
  net_income: "Net income",
  operating_cash_flow: "Operating cash flow",
};
const DATE = new Intl.DateTimeFormat("en", { year: "numeric", month: "short", day: "2-digit", timeZone: "UTC" });
const CLOCK = new Intl.DateTimeFormat("en", { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short" });

function dateLabel(value: string | null): string {
  if (!value) return "Not reported";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unparseable date" : DATE.format(date);
}

function clockLabelMs(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Not reported";
  return CLOCK.format(value);
}

function filedDateLabel(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "Not reported";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? "Unparseable date" : dateLabel(date.toISOString().slice(0, 10));
}

function periodRange(fact: FundamentalDisplayFact): string {
  return fact.startDate ? `${dateLabel(fact.startDate)} – ${dateLabel(fact.endDate)}` : `as of ${dateLabel(fact.endDate)}`;
}

function periodLengthDays(fact: FundamentalDisplayFact): number | null {
  if (!fact.startDate) return null;
  const start = Date.parse(`${fact.startDate}T00:00:00.000Z`);
  const end = Date.parse(`${fact.endDate}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return (end - start) / 86_400_000 + 1;
}

function comparisonPeriodContext(
  alignment: FundamentalComparison["periodAlignment"],
  current: FundamentalDisplayFact,
  prior: FundamentalDisplayFact,
): string | null {
  if (alignment == null) return null;
  const currentDays = periodLengthDays(current);
  const priorDays = periodLengthDays(prior);
  const alignmentLabel = alignment === "calendar_anniversary" ? "Calendar-anniversary match"
    : alignment === "same_filing_52_week" ? "Same-filing period boundaries 52 weeks apart"
      : "Same-filing period boundaries 53 weeks apart";
  const durations = currentDays === priorDays && currentDays !== null ? ` Both periods span ${currentDays} days.` : "";
  return `${alignmentLabel}. Current period: ${periodRange(current)}. Prior period: ${periodRange(prior)}.${durations}`;
}

function formatValue(value: string, unit: string): string {
  const match = value.match(/^(-?)(?:0|[1-9]\d*)(?:\.\d+)?$/);
  if (!match || value.length > 80) return "Unavailable";
  const negative = match[1] === "-";
  const unsigned = negative ? value.slice(1) : value;
  const [wholeRaw, fractionRaw = ""] = unsigned.split(".");
  const whole = wholeRaw!;
  const fraction = fractionRaw.replace(/0+$/, "");
  const integer = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const formatted = fraction ? `${integer}.${fraction}` : integer;
  const signed = negative && !/^0(?:\.0*)?$/.test(formatted) ? `-${formatted}` : formatted;
  return unit ? `${signed} ${unit}` : signed;
}

function compactAxisValue(value: string, unit: string): string {
  const match = value.match(/^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/);
  if (!match || value.length > 80) return "Unavailable";
  const negative = match[1] === "-";
  const fraction = match[3] ?? "";
  const digits = BigInt(`${match[2]}${fraction}`);
  const magnitude = digits < 0n ? -digits : digits;
  const decimalScale = 10n ** BigInt(fraction.length);
  const tiers = [
    { factor: 1_000_000_000_000n, suffix: "T" },
    { factor: 1_000_000_000n, suffix: "B" },
    { factor: 1_000_000n, suffix: "M" },
    { factor: 1_000n, suffix: "K" },
  ];
  let tierIndex = tiers.findIndex(({ factor }) => magnitude >= factor * decimalScale);
  if (tierIndex < 0) return unit.toUpperCase() === "USD" ? `$${formatValue(value, "")}` : formatValue(value, unit);
  let tier = tiers[tierIndex]!;
  let tenths = (magnitude * 10n + (tier.factor * decimalScale) / 2n) / (tier.factor * decimalScale);
  if (tenths >= 10_000n && tierIndex > 0) {
    tier = tiers[--tierIndex]!;
    tenths = (magnitude * 10n + (tier.factor * decimalScale) / 2n) / (tier.factor * decimalScale);
  }
  const number = `${negative && magnitude !== 0n ? "−" : ""}${tenths / 10n}${tenths % 10n ? `.${tenths % 10n}` : ""}${tier.suffix}`;
  return unit.toUpperCase() === "USD" ? `$${number}` : `${number} ${unit}`;
}

function reportedPrecisionLabel(status: FundamentalDisplayFact["reportedPrecisionStatus"], decimals: string | null, unit: string): string {
  if (status === "missing" && decimals === null) return "SEC precision metadata is unavailable in this saved fact.";
  if (status !== "declared" || decimals === null) return "SEC precision metadata is invalid or unsupported; comparisons are withheld.";
  if (decimals === "INF") return "SEC decimals=INF (declared exact in XBRL).";
  const exponent = Number(decimals);
  if (!/^-?(?:0|[1-9]\d?)$/.test(decimals) || !Number.isInteger(exponent) || exponent < -18 || exponent > 18) {
    return "SEC precision metadata is malformed or unsupported; comparisons are withheld.";
  }
  const increment = exponent < 0 ? `1${"0".repeat(-exponent)}`
    : exponent === 0 ? "1" : `0.${"0".repeat(exponent - 1)}1`;
  return `SEC precision scale ${compactAxisValue(increment, unit)} (decimals ${decimals.replace("-", "−")}).`;
}

function comparisonLabel(interpretation: FundamentalComparison["changeInterpretation"], delta: string): string {
  if (interpretation === "within_reported_precision") return "Reported-value difference within the combined precision bound";
  if (interpretation === "change_exceeds_precision") return "Reported-value difference exceeds the combined precision bound";
  if (interpretation === "no_reported_difference") return "No difference between values declared exact in XBRL";
  if (interpretation === "reported_values_only" && delta === "0") return "No difference between returned values; source precision unavailable";
  return "Difference between reported values";
}

function safeFilingUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "www.sec.gov" || url.hostname === "sec.gov") ? url.href : null;
  } catch { return null; }
}

function renderChart(points: readonly PersistedFundamentalPoint[]) {
  if (points.length < 2) return null;
  const ordered = [...points].sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));
  const epochs = ordered.map((point) => Date.parse(`${point.periodEnd}T00:00:00Z`));
  if (epochs.some((value) => !Number.isFinite(value))) return null;
  const parts: Array<{ units: bigint; scale: number } | null> = [];
  for (const point of ordered) {
    if (point.value === null) { parts.push(null); continue; }
    const match = point.value.match(/^(-?)(0|[1-9]\d*)(?:\.(\d+))?$/);
    if (!match || point.value.length > 80) return null;
    const fraction = match[3] ?? "";
    parts.push({ units: BigInt(`${match[2]}${fraction}`) * (match[1] === "-" ? -1n : 1n), scale: fraction.length });
  }
  const scale = Math.max(0, ...parts.flatMap((value) => value === null ? [] : [value.scale]));
  const parsed = parts.map((value) => value === null ? null : value.units * 10n ** BigInt(scale - value.scale));
  const values = parsed.flatMap((value) => value === null ? [] : [value]);
  if (values.length < 2) return null;
  const min = values.reduce((a, b) => a < b ? a : b);
  const max = values.reduce((a, b) => a > b ? a : b);
  const span = max - min || (max < 0n ? -max : max) / 10n || 1n;
  const firstEpoch = epochs[0]!;
  const dateSpan = Math.max(epochs[epochs.length - 1]! - firstEpoch, 1);
  const x = (index: number) => 8 + ((epochs[index]! - firstEpoch) / dateSpan) * 284;
  const y = (value: bigint) => max === min ? 46 : 76 - Number((value - min) * 60_000_000n / span) / 1_000_000;
  const segments: string[] = [];
  let current: string[] = [];
  ordered.forEach((point, index) => {
    const value = parsed[index]!;
    const priorEpoch = index > 0 ? epochs[index - 1]! : null;
    const elapsed = priorEpoch === null ? null : epochs[index]! - priorEpoch;
    const periodGap = elapsed !== null && (elapsed < 365 * 86_400_000 || elapsed > 366 * 86_400_000);
    if (periodGap && current.length) {
      segments.push(current.join(" "));
      current = [];
    }
    if (value === null) {
      if (current.length) segments.push(current.join(" "));
      current = [];
    } else current.push(`${current.length ? "L" : "M"}${x(index).toFixed(1)},${y(value).toFixed(1)}`);
  });
  if (current.length) segments.push(current.join(" "));
  if (!segments.length) return null;
  const metric = ordered[0]!.metric;
  const unit = ordered[0]!.unit;
  if (ordered.some((point) => point.metric !== metric || point.unit !== unit)) return null;
  const title = `${METRIC_LABELS[metric]} across ${values.length} persisted SEC periods`;
  const minValue = ordered[parsed.findIndex((value) => value === min)]!.value;
  const maxValue = ordered[parsed.findIndex((value) => value === max)]!.value;
  if (minValue === null || maxValue === null) return null;
  const axisMin = compactAxisValue(minValue, unit);
  const axisMax = compactAxisValue(maxValue, unit);
  return (
    <figure className="company-fundamentals-chart">
      <figcaption>{title} · {unit} · linear scale. Gaps indicate periods without a persisted value; source-reported precision is shown below.</figcaption>
      <div className="cf-chart-plot">
        <div className="cf-chart-y-axis" aria-hidden="true"><span>{axisMax}</span><span>{axisMin}</span></div>
        <svg viewBox="0 0 300 88" role="img" aria-label={`${title}. Vertical range ${axisMin} to ${axisMax}.`} preserveAspectRatio="none">
          <line x1="8" y1="16" x2="292" y2="16" className="cf-chart-grid" />
          <line x1="8" y1="76" x2="292" y2="76" className="cf-chart-axis" />
          {segments.map((path, index) => <path key={index} d={path} className="cf-chart-line" />)}
          {ordered.map((point, index) => parsed[index] === null ? null : <circle key={`${point.periodEnd}-${index}`} cx={x(index)} cy={y(parsed[index]!)} r="1.8" className="cf-chart-point" />)}
        </svg>
      </div>
      <div className="cf-chart-range"><span>{dateLabel(ordered[0]!.periodEnd)}</span><span>{dateLabel(ordered[ordered.length - 1]!.periodEnd)}</span></div>
      <details className="cf-chart-data">
        <summary>Inspect source values and reporting precision</summary>
        <div className="cf-chart-table-scroll" role="region" aria-label={`Returned persisted ${METRIC_LABELS[metric].toLowerCase()} values`} tabIndex={0}>
          <table>
            <caption>CompanyFacts values shown in the chart</caption>
            <thead><tr><th scope="col">Period end</th><th scope="col">Returned value</th><th scope="col">Unit</th><th scope="col">Reporting precision</th></tr></thead>
            <tbody>{ordered.map((point, index) => <tr key={`${point.periodEnd}-${index}`}>
              <th scope="row">{dateLabel(point.periodEnd)}</th>
              <td>{point.value === null ? "No eligible value saved" : point.value}</td>
              <td>{point.unit}</td>
              <td>{reportedPrecisionLabel(point.reportedPrecisionStatus, point.reportedDecimals, point.unit)}</td>
            </tr>)}</tbody>
          </table>
        </div>
      </details>
    </figure>
  );
}

function stateMessage(state: FundamentalsState, staleReason?: string | null): string | null {
  switch (state) {
    case "idle": return "Saved SEC facts have not been checked in this view yet.";
    case "loading": return "Loading saved SEC facts…";
    case "refreshing": return "Refreshing SEC facts. Previously saved facts remain available.";
    case "partial": return "Some SEC facts or filing-time details are unavailable; review the coverage limits before comparing periods.";
    case "empty": return "No eligible SEC facts are saved for this company yet.";
    case "stale": return staleReason || "The saved SEC facts may be out of date.";
    case "blocked": return null;
    case "failed": return "SEC facts could not be loaded. Previously saved facts, if any, are retained.";
    default: return null;
  }
}

const PERIOD_DURATION_PRIORITY: Record<FundamentalDisplayFact["durationClass"], number> = {
  quarter: 0,
  ytd_q2: 1,
  ytd_q3: 2,
  annual: 3,
  unknown: 4,
};

function compareFactPeriods(a: FundamentalDisplayFact, b: FundamentalDisplayFact): number {
  return b.endDate.localeCompare(a.endDate)
    || PERIOD_DURATION_PRIORITY[a.durationClass] - PERIOD_DURATION_PRIORITY[b.durationClass]
    || (b.startDate ?? "").localeCompare(a.startDate ?? "");
}

function comparisonForFact(
  fact: FundamentalDisplayFact,
  comparisons: readonly FundamentalComparison[],
): FundamentalComparison | undefined {
  return comparisons.find((comparison) => comparison.metric === fact.metric && comparison.currentFactId === fact.id);
}

function periodKindLabel(fact: FundamentalDisplayFact): string {
  switch (fact.durationClass) {
    case "quarter": return "Quarter";
    case "ytd_q2":
    case "ytd_q3": return "Year to date";
    case "annual": return "Fiscal year";
    default: return "Reported period";
  }
}

export function CompanyFundamentals(props: CompanyFundamentalsProps) {
  const { companyId, companyName, ticker, state, facts, comparisons, points, coverage, refreshAllowed, lastRefreshError, staleReason, onRefresh } = props;
  const factsByMetric = new Map<FundamentalMetricKey, FundamentalDisplayFact[]>();
  for (const fact of facts) {
    if (!/^-?\d+(?:\.\d+)?$/.test(fact.value)) continue;
    const group = factsByMetric.get(fact.metric) ?? [];
    group.push(fact);
    factsByMetric.set(fact.metric, group);
  }
  for (const group of factsByMetric.values()) group.sort(compareFactPeriods);
  const loading = state === "loading" || state === "refreshing";
  const message = stateMessage(state, staleReason);
  const showData = facts.length > 0;
  const chart = renderChart(points);
  const headingId = `company-fundamentals-${ticker.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
  const revenueFacts = facts.filter((fact) => fact.metric === "revenue").sort(compareFactPeriods);
  const latestRevenue = revenueFacts[0];
  // Triage must describe the newest reported revenue fact. Picking an older
  // fact merely because it has a comparison makes stale context look current.
  // Keep older comparisons in the detailed history; the headline comparison
  // is only the one explicitly attached to this newest fact.
  const researchFact = latestRevenue ?? [...facts].sort(compareFactPeriods)[0];
  const researchComparison = researchFact ? comparisonForFact(researchFact, comparisons) : undefined;
  const researchPriorFact = researchComparison?.priorFactId
    ? facts.find((fact) => fact.id === researchComparison.priorFactId)
    : undefined;
  const researchPriorDate = researchPriorFact?.endDate ? dateLabel(researchPriorFact.endDate) : "the earlier matched period";
  const researchPeriodContext = researchPriorFact && researchFact
    ? comparisonPeriodContext(researchComparison?.periodAlignment ?? null, researchFact, researchPriorFact)
    : null;
  const filingFinding = !researchFact
    ? null
    : researchComparison?.state !== "comparable" || researchComparison.delta === null
      ? `No supported material-change finding: there is no eligible comparable ${METRIC_LABELS[researchFact.metric].toLowerCase()} period in the saved SEC facts.`
      : researchComparison.changeInterpretation === "within_reported_precision"
        ? `Reported ${METRIC_LABELS[researchFact.metric].toLowerCase()} differs by ${formatValue(researchComparison.delta, researchFact.unit)} from the period ending ${researchPriorDate}; that gap is within the combined reported-precision bound, so direction is unresolved.`
        : researchComparison.changeInterpretation === "reported_values_only"
          ? `The returned ${METRIC_LABELS[researchFact.metric].toLowerCase()} amounts differ by ${formatValue(researchComparison.delta, researchFact.unit)} from the period ending ${researchPriorDate}, but source precision is unavailable; an underlying change is not established.`
          : researchComparison.changeInterpretation === "no_reported_difference"
            ? `Both ${METRIC_LABELS[researchFact.metric].toLowerCase()} amounts are declared decimals=INF in XBRL and show no reported difference from the period ending ${researchPriorDate}.`
            : `Reported ${METRIC_LABELS[researchFact.metric].toLowerCase()} differs by ${formatValue(researchComparison.delta, researchFact.unit)} from the period ending ${researchPriorDate}; the reported gap exceeds the combined precision bound, but does not establish its cause or materiality.`;
  const filingNextCheck = !researchFact
    ? null
    : researchComparison?.state !== "comparable" || researchComparison.delta === null
      ? "Open the cited filing and locate the same metric in an eligible earlier reported period."
      : researchComparison.changeInterpretation === "within_reported_precision"
        ? "Check the filed statement and narrative disclosures; the reported gap is too close to source precision for a directional read."
        : researchComparison.changeInterpretation === "reported_values_only"
          ? "Check the as-filed statement for its unit and reported precision before interpreting the difference."
          : "Inspect management discussion and segment disclosures for drivers, qualifications, and contrary evidence.";
  const researchUrl = researchFact ? safeFilingUrl(researchFact.sourceUrl) : null;

  return (
    <section className="panel company-fundamentals" aria-labelledby={headingId} aria-busy={loading}>
      <header className="cf-header">
        <div className="cf-title-wrap">
          <p className="micro">SEC COMPANY FACTS</p>
          <h2 id={headingId}>{companyName} <span>{ticker}</span></h2>
        </div>
        <button type="button" className="cf-refresh" onClick={onRefresh} disabled={!refreshAllowed || loading} aria-describedby="cf-refresh-reason">
          {loading ? "Working…" : "Refresh SEC facts"}
        </button>
      </header>
      <p id="cf-refresh-reason" className="cf-refresh-reason" role={state === "blocked" ? "status" : undefined}>
        {refreshAllowed ? "Refresh is on demand for this company." : "SEC fact updates are unavailable right now. Saved values remain visible when available."}
      </p>
      <p className="cf-refresh-reason">Financial facts are shown separately from news and market updates.</p>

      {message && <p className={`cf-state cf-state-${state}`} role={state === "failed" ? "alert" : loading || state === "stale" || state === "blocked" ? "status" : "note"}>{message}</p>}
      {companyId && facts.length > 0 && <CompanyEvidenceAssessmentPanel companyId={companyId} snapshotId={props.snapshotId ?? null} companyName={companyName} ticker={ticker} facts={facts} />}
      {lastRefreshError && showData && <p className="cf-state cf-state-warning" role="status">The latest SEC fact update could not be completed. Previously saved facts below were retained.</p>}
      {lastRefreshError && !showData && state === "failed" && <p className="cf-detail" role="status">SEC facts are temporarily unavailable. Try again later.</p>}
      {filingFinding && filingNextCheck && researchFact && <aside className="cf-next-question" aria-label="Filing triage">
        <p className="micro">FILING TRIAGE · {METRIC_LABELS[researchFact.metric].toUpperCase()}</p>
        <p className="cf-triage-values"><span><strong>Current</strong> {formatValue(researchFact.value, researchFact.unit)} <span className="cf-triage-date">({periodRange(researchFact)})</span></span>
          {researchPriorFact && <span><strong>Matched prior</strong> {formatValue(researchPriorFact.value, researchPriorFact.unit)} <span className="cf-triage-date">({periodRange(researchPriorFact)})</span></span>}
          {researchComparison?.delta !== null && researchComparison?.delta !== undefined && <span><strong>Arithmetic difference</strong> {formatValue(researchComparison.delta, researchFact.unit)}</span>}
        </p>
        {researchPeriodContext && <p><strong>Period match</strong><br />{researchPeriodContext}</p>}
        <p><strong>Interpretation limit</strong><br />{filingFinding} This totals-only view does not assess cause, materiality, persistence, or narrative counterevidence.</p>
        <p><strong>Next check</strong><br />{filingNextCheck}</p>
        {researchUrl && <a href={researchUrl} target="_blank" rel="noreferrer">Open cited SEC filing · {researchFact.accession}</a>}
        <dl className="cf-clocks cf-triage-clocks">
          <div><dt>Filed</dt><dd>{filedDateLabel(researchFact.filedAt)}</dd></div>
          <div><dt>Accepted</dt><dd>{clockLabelMs(researchFact.acceptedAt)}</dd></div>
          <div><dt>Retrieved</dt><dd>{clockLabelMs(researchFact.retrievedAt)}</dd></div>
        </dl>
      </aside>}
      {showData ? <details className="cf-evidence">
        <summary>All reported metrics, precision, chart and source details</summary>
        <div className="cf-metric-grid">
          {METRICS.map((metric) => {
            const rows = factsByMetric.get(metric) ?? [];
            return (
              <article className="cf-metric" key={metric} aria-label={METRIC_LABELS[metric]}>
                <h3>{METRIC_LABELS[metric]}</h3>
                {rows.length ? rows.slice(0, 2).map((fact) => {
                  const href = safeFilingUrl(fact.sourceUrl);
                  const comparison = comparisons.find((item) => item.metric === metric && item.currentFactId === fact.id);
                  const priorFact = comparison?.priorFactId ? facts.find((prior) => prior.id === comparison.priorFactId) : undefined;
                  const exactInputs = fact.reportedPrecisionStatus === "declared" && fact.reportedDecimals === "INF"
                    && priorFact?.reportedPrecisionStatus === "declared" && priorFact.reportedDecimals === "INF";
                  const visiblePercentChange = exactInputs ? comparison?.percentChange ?? null : null;
                  return (
                    <div className="cf-fact" key={fact.id}>
                      <div className="cf-value-row"><strong>{formatValue(fact.value, fact.unit)}</strong></div>
                      <p className="cf-precision-note">{reportedPrecisionLabel(fact.reportedPrecisionStatus, fact.reportedDecimals, fact.unit)}</p>
                      <p className="cf-period">{periodKindLabel(fact)} · {fact.startDate ? `${dateLabel(fact.startDate)} – ` : "as of "}{dateLabel(fact.endDate)} · {fact.form}</p>
                      {comparison?.state === "comparable" && comparison.delta !== null ? (
                        <>
                          <p className="cf-comparison">{comparisonLabel(comparison.changeInterpretation, comparison.delta)} vs {priorFact ? periodRange(priorFact) : "the matched period"} in the same filing: {formatValue(comparison.delta, fact.unit)}{visiblePercentChange === null ? "" : ` (${visiblePercentChange}%)`}{comparison.changeInterpretation === "within_reported_precision" ? " · direction unresolved" : ""}</p>
                          {priorFact && <p className="cf-precision-note">{comparisonPeriodContext(comparison.periodAlignment, fact, priorFact)}</p>}
                          {comparison.percentChange !== null && visiblePercentChange === null && <p className="cf-precision-note">Percentage change is withheld because both reported amounts are not declared exact in XBRL.</p>}
                          {comparison.reason && <p className="cf-precision-note">{comparison.reason}</p>}
                        </>
                      ) : <p className="cf-comparison cf-muted">Comparison unavailable: {comparison?.reason || "No API-confirmed comparable period."}</p>}
                      {href ? <a className="cf-filing" href={href} target="_blank" rel="noreferrer">SEC filing · {fact.accession}</a> : <span className="cf-filing">Filing link unavailable · {fact.accession}</span>}
                      <dl className="cf-clocks">
                        <div><dt>Filed</dt><dd>{filedDateLabel(fact.filedAt)}</dd></div>
                        <div><dt>Accepted</dt><dd>{clockLabelMs(fact.acceptedAt)}</dd></div>
                        <div><dt>Retrieved</dt><dd>{clockLabelMs(fact.retrievedAt)}</dd></div>
                      </dl>
                    </div>
                  );
                }) : <p className="cf-missing">No persisted fact for this metric.</p>}
              </article>
            );
          })}
        </div>
        {chart}
        <details className="cf-coverage">
          <summary>SEC coverage and comparison limits</summary>
          <p>CompanyFacts covers standard, whole-entity XBRL facts. It may omit custom tags and dimensional disclosures. SEC period comparisons do not establish cause, materiality, business quality, or investment merit.</p>
          {coverage.length ? <ul>{coverage.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul> : <p>Coverage diagnostics have not been supplied for this saved view.</p>}
        </details>
      </details> : state !== "loading" && state !== "refreshing" && <p className="cf-empty">No financial values are available for this company yet.</p>}
    </section>
  );
}

function CompanyEvidenceAssessmentPanel({companyId,snapshotId,companyName,ticker,facts}:{companyId:string;snapshotId:string|null;companyName:string;ticker:string;facts:readonly FundamentalDisplayFact[]}){
  const [selectedIds,setSelectedIds]=useState<string[]>(()=>facts.slice(0,Math.min(6,facts.length)).map(f=>f.id));
  const [provider,setProvider]=useState<"openai"|"google_gemini">("google_gemini");
  const [confirmedRequestKey,setConfirmedRequestKey]=useState<string|null>(null);const [paidAttestationKey,setPaidAttestationKey]=useState<string|null>(null);const [usageReviewKey,setUsageReviewKey]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);const [status,setStatus]=useState<string|null>(null);const [result,setResult]=useState<CompanyAssessmentResult|null>(null);
  const [savedReadback,setSavedReadback]=useState<CompanyAssessmentReadback|null>(null);const [savedReadbackKey,setSavedReadbackKey]=useState<string|null>(null);const [readbackLoading,setReadbackLoading]=useState(false);const [readbackError,setReadbackError]=useState(false);
  const cik=facts[0]?.cik??"";const identityConsistent=/^\d{10}$/.test(cik)&&facts.every(f=>f.cik===cik);
  const selected=facts.filter(f=>selectedIds.includes(f.id)).slice(0,12);
  const requestKey=JSON.stringify([companyId,cik,snapshotId,provider,selected.map(f=>f.id)]);
  const currentRequestKey=useRef(requestKey);currentRequestKey.current=requestKey;
  const readbackKey=JSON.stringify([companyId,cik,snapshotId,provider]);
  const currentReadbackKey=useRef(readbackKey);currentReadbackKey.current=readbackKey;
  const confirmSend=confirmedRequestKey===requestKey;
  const paidServiceAttested=paidAttestationKey===requestKey;
  const usageReviewAcknowledged=usageReviewKey===requestKey;
  const currentReadback=savedReadbackKey===readbackKey?savedReadback:null;
  const usageReview=currentReadback?.usageReview;
  const needsUsageReview=usageReview?.required===true;
  const readbackMatchesCurrentSnapshot=Boolean(snapshotId&&currentReadback?.snapshotId===snapshotId);
  const persistedResult=readbackMatchesCurrentSnapshot&&currentReadback?.assessment?.status==="completed"?currentReadback.assessment.result:null;
  const displayedResult=result??persistedResult;
  const displayedResultIsPersisted=!result&&persistedResult!==null;
  const model=provider==="openai"?"GPT-6 Luna":"Gemini 3.8 Flash";
  useEffect(()=>{
    setSelectedIds(facts.slice(0,Math.min(6,facts.length)).map(f=>f.id));
    setConfirmedRequestKey(null);setPaidAttestationKey(null);setUsageReviewKey(null);setResult(null);setStatus(null);
  },[companyId,cik,snapshotId]);
  useEffect(()=>{
    const key=readbackKey,controller=new AbortController();
    setSavedReadback(null);setSavedReadbackKey(null);setReadbackError(false);setReadbackLoading(true);
    void getCompanyEvidenceAssessment(companyId,provider,controller.signal).then(value=>{
      if(currentReadbackKey.current!==key)return;
      if(value&&snapshotId&&value.snapshotId!==snapshotId){setReadbackError(true);return;}
      setSavedReadback(value);setSavedReadbackKey(key);
    }).catch(()=>{if(currentReadbackKey.current===key&&!controller.signal.aborted)setReadbackError(true);})
      .finally(()=>{if(currentReadbackKey.current===key)setReadbackLoading(false);});
    return()=>controller.abort();
  },[companyId,cik,snapshotId,provider]);
  const reloadReadback=async(expectedKey=readbackKey)=>{
    try{
      const value=await getCompanyEvidenceAssessment(companyId,provider);
      if(currentReadbackKey.current!==expectedKey)return;
      if(value&&snapshotId&&value.snapshotId!==snapshotId){setSavedReadback(null);setSavedReadbackKey(null);setReadbackError(true);return;}
      setSavedReadback(value);setSavedReadbackKey(expectedKey);setReadbackError(false);
    }catch{if(currentReadbackKey.current===expectedKey)setReadbackError(true);}
  };
  const toggle=(id:string)=>{setResult(null);setStatus(null);setSelectedIds(current=>current.includes(id)?current.filter(item=>item!==id):current.length>=12?current:[...current,id]);};
  const submit=async()=>{
    if(!companyId||!identityConsistent||selected.length===0||!confirmSend||readbackLoading||readbackError||(provider==="google_gemini"&&!paidServiceAttested)||(needsUsageReview&&!usageReviewAcknowledged)||busy)return;
    const submittedRequestKey=requestKey,submittedReadbackKey=readbackKey;
    setBusy(true);setStatus(null);setResult(null);
    try{const value=await requestCompanyEvidenceAssessment(companyId,{cik,factIds:selected.map(f=>f.id),provider,confirmSend:true,paidServiceAttested,usageReviewAcknowledged});
      if(currentRequestKey.current!==submittedRequestKey){setStatus("The assessment completed for an earlier SEC snapshot or fact selection. It was saved with that evidence and is not shown against the current selection.");return;}
      setResult(value);setStatus("Assessment saved with its selected SEC fact lineage.");}
    catch(error){const message=error instanceof Error?error.message:"request_failed";
      setStatus(message.includes("unknown_delivery")?"Delivery is unknown. The provider may have received the request; no automatic retry was made. Review provider usage before deciding whether to send again.":message.includes("usage_review_required")?"A previous request has unresolved delivery. Review the saved attempt and provider usage, acknowledge the risk below, and then review this exact preview again.":message.includes("source_changed")?"The saved SEC snapshot changed. Refresh the facts and review the preview again.":message.includes("provider_key_not_configured")?`No saved ${provider==="openai"?"OpenAI":"Gemini"} key is available in this local app.`:"The assessment could not be completed. No automatic retry was made.");}
    finally{setBusy(false);setConfirmedRequestKey(null);setPaidAttestationKey(null);setUsageReviewKey(null);void reloadReadback(submittedReadbackKey);}
  };
  const reloadStatus=()=>{setReadbackError(false);setReadbackLoading(true);void reloadReadback().finally(()=>setReadbackLoading(false));};
  return <section className="cf-assessment" aria-labelledby={`cf-assessment-${ticker}`}>
    <div><p className="micro">SEC EVIDENCE BRIEF</p><h3 id={`cf-assessment-${ticker}`}>Potentially bullish and bearish evidence</h3>
      <p>Build a balanced read from the exact reported facts you select. The model does not receive filing text, news, saved keys, or private research.</p></div>
    {!identityConsistent?<p role="status">Company identity is inconsistent across these saved facts; assessment is unavailable.</p>:<>
      <label className="cf-assessment-provider">Provider
        <select value={provider} disabled={busy} onChange={e=>{setProvider(e.target.value as typeof provider);setConfirmedRequestKey(null);setPaidAttestationKey(null);setResult(null);setStatus(null);}}>
          <option value="google_gemini">Google Gemini · Gemini 3.8 Flash</option><option value="openai">OpenAI API · GPT-6 Luna</option>
        </select>
      </label>
      <p className="cf-assessment-disclosure">Your selected SEC financial fact values, units, periods, filing dates, CIK, and SEC filing links will be sent to {provider==="openai"?"OpenAI":"Google"} using your locally saved API key. The app keeps the key on this device and does not put it in the request body. The provider may charge your API account; this app caps company assessments at 10 requests per UTC day, which does not cap provider billing. {provider==="google_gemini"?<> {GEMINI_PURPOSE_DISCLOSURE} Google may use prompts and responses from unpaid Gemini services to improve products, and human reviewers may process them where unpaid-service use is allowed. In the EEA, UK, and Switzerland, Google requires Gemini API Paid Services via an actively billed Cloud project; a free-tier-only project is not eligible, and paid-tier usage may incur metered charges. <a href="https://ai.google.dev/gemini-api/terms?hl=en" target="_blank" rel="noreferrer">Gemini API terms</a>.</>:"The OpenAI request disables response storage; OpenAI API data terms apply."} This is research support, not a recommendation, forecast, or valuation.</p>
      {readbackLoading&&<p className="cf-assessment-status" role="status">Checking saved assessment status…</p>}
      {readbackError&&<p className="cf-assessment-status" role="status">Saved assessment status could not be checked, or the saved SEC snapshot has changed. Sending is paused until status is reloaded. <button type="button" onClick={reloadStatus} disabled={readbackLoading}>Reload saved status</button></p>}
      {currentReadback?.assessment&&readbackMatchesCurrentSnapshot&&<div className="cf-assessment-status" role="status">
        <strong>Saved request · {currentReadback.assessment.status.replaceAll("_"," ")}</strong>
        {currentReadback.assessment.status==="unknown_delivery"&&<p>The provider may have received this request before the connection ended. It was not retried automatically.</p>}
        {currentReadback.assessment.status==="rejected"&&<p>The provider rejected the request. No result was saved.</p>}
        {currentReadback.assessment.status==="invalid_output"&&<p>The response could not be validated, so no summary is shown.</p>}
        <p>Started {new Date(currentReadback.assessment.startedAt).toLocaleString()}. Selected SEC facts: {currentReadback.assessment.selectedFactIds.map(id=>facts.find(f=>f.id===id)?.concept??id).join(", ")||"none available in the current view"}.</p>
      </div>}
      {needsUsageReview&&<div className="cf-assessment-status" role="alert"><strong>Provider usage review required</strong><p>{usageReview?.unresolvedCount} {provider==="openai"?"OpenAI":"Gemini"} request{usageReview?.unresolvedCount===1?"":"s"} on this device have unresolved delivery. Check the provider account usage page first; the requests may have been billed even without a saved answer. Acknowledgment does not retry or cancel them.</p>
        <label className="cf-assessment-confirm"><input type="checkbox" checked={usageReviewAcknowledged} disabled={busy||readbackLoading||readbackError} onChange={e=>setUsageReviewKey(e.target.checked?requestKey:null)} />I reviewed provider usage and understand the earlier request may already have been processed.</label></div>}
      <fieldset className="cf-assessment-facts"><legend>Select facts to include ({selected.length}/12)</legend>{facts.slice(0,24).map(fact=><label key={fact.id}>
        <input type="checkbox" checked={selectedIds.includes(fact.id)} disabled={busy||(!selectedIds.includes(fact.id)&&selectedIds.length>=12)} onChange={()=>toggle(fact.id)} />
        <span><strong>{fact.concept}</strong> · {formatValue(fact.value,fact.unit)} · {fact.startDate?`${fact.startDate} to `:"as of "}{fact.endDate} · {fact.form} filed {filedDateLabel(fact.filedAt)}</span>
      </label>)}</fieldset>
      {selected.length>0&&<details className="cf-assessment-preview" open><summary>Preview exact data sent ({selected.length} facts)</summary><ul>{selected.map(f=><li key={f.id}><strong>{f.concept}</strong>: {f.value} {f.unit}; period {f.startDate?`${f.startDate}–`:"instant "}{f.endDate}; precision {f.reportedDecimals??"not supplied"}; {f.form}, filed {filedDateLabel(f.filedAt)}, accession {f.accession}, fact ID {f.id}; SEC URL <a href={f.sourceUrl} target="_blank" rel="noreferrer">{f.sourceUrl}</a></li>)}</ul><p>Issuer: {companyName} ({ticker}), CIK {cik}. No document text is included.</p></details>}
      <label className="cf-assessment-confirm"><input type="checkbox" checked={confirmSend} disabled={busy||selected.length===0||readbackLoading||readbackError||(needsUsageReview&&!usageReviewAcknowledged)} onChange={e=>setConfirmedRequestKey(e.target.checked?requestKey:null)} />I reviewed this exact preview and authorize one request to {provider==="openai"?"OpenAI":"Google Gemini"}.</label>
      {provider==="google_gemini"&&<label className="cf-assessment-confirm"><input type="checkbox" checked={paidServiceAttested} disabled={busy} onChange={e=>setPaidAttestationKey(e.target.checked?requestKey:null)} />If this client is made available in the EEA, UK, or Switzerland, I confirm it uses Paid Services with active Cloud Billing and accept metered charges may apply.</label>}
      <button type="button" className="cf-assessment-send" onClick={()=>void submit()} disabled={busy||!confirmSend||selected.length===0||readbackLoading||readbackError||(needsUsageReview&&!usageReviewAcknowledged)||(provider==="google_gemini"&&!paidServiceAttested)}>{busy?"Sending one assessment…":`Send selected SEC facts to ${model}`}</button>
      {status&&<p role="status" className="cf-assessment-status">{status}</p>}
      {displayedResult&&<div className="cf-assessment-result" aria-live="polite"><p className="micro">{displayedResult.assessment.stance.replaceAll("_"," ").toUpperCase()} · {displayedResult.model}{displayedResultIsPersisted?" · SAVED RESULT":""}</p>
        {displayedResultIsPersisted&&currentReadback?.assessment&&<p>Saved for {currentReadback.assessment.selectedFactIds.map(id=>facts.find(f=>f.id===id)?.concept??id).join(", ")}. Your current preview may include a different selection.</p>}
        <h4>{displayedResult.assessment.summary} {displayedResult.assessment.summaryCitationIds.map(id=>{const citation=displayedResult.citations.find(c=>c.id===id);return citation?<a key={id} href={citation.sourceUrl} target="_blank" rel="noreferrer">[{id}]</a>:null;})}</h4>
        {([ ["Potentially bullish",displayedResult.assessment.bullishEvidence], ["Potentially bearish",displayedResult.assessment.bearishEvidence] ] as const).map(([heading,items])=><div key={heading}><strong>{heading}</strong>{items.length?<ul>{items.map((item,index)=><li key={`${heading}-${index}`}>{item.claim} {item.citationIds.map(id=>{const citation=displayedResult.citations.find(c=>c.id===id);return citation?<a key={id} href={citation.sourceUrl} target="_blank" rel="noreferrer">[{id}]</a>:null;})}</li>)}</ul>:<p>No supported point in the selected evidence.</p>}</div>)}
        {displayedResult.assessment.unknowns.length>0&&<div><strong>Unknowns</strong><ul>{displayedResult.assessment.unknowns.map((item,index)=><li key={index}>{item}</li>)}</ul></div>}
        <p>Generated {new Date(displayedResult.generatedAt).toLocaleString()} · source-grounded wording is model-generated and not independently verified.</p>
      </div>}
    </>}
  </section>;
}
