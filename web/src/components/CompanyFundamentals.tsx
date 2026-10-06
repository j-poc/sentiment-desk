import "./company-fundamentals.css";
import type {
  FundamentalComparison,
  FundamentalMetricKey,
  FundamentalsState,
  PersistedFundamentalFact,
  PersistedFundamentalPoint,
} from "../../../shared/company-fundamentals.js";
export type { FundamentalComparison, FundamentalMetricKey, FundamentalsState, PersistedFundamentalFact, PersistedFundamentalPoint } from "../../../shared/company-fundamentals.js";

export interface CompanyFundamentalsProps {
  companyName: string;
  ticker: string;
  state: FundamentalsState;
  facts: readonly PersistedFundamentalFact[];
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

function reportedPrecisionLabel(status: PersistedFundamentalFact["reportedPrecisionStatus"], decimals: string | null, unit: string): string {
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

export function CompanyFundamentals(props: CompanyFundamentalsProps) {
  const { companyName, ticker, state, facts, comparisons, points, coverage, refreshAllowed, refreshBlockedReason, lastRefreshError, staleReason, onRefresh } = props;
  const factsByMetric = new Map<FundamentalMetricKey, PersistedFundamentalFact[]>();
  for (const fact of facts) {
    if (!/^-?\d+(?:\.\d+)?$/.test(fact.value)) continue;
    const group = factsByMetric.get(fact.metric) ?? [];
    group.push(fact);
    factsByMetric.set(fact.metric, group);
  }
  for (const group of factsByMetric.values()) group.sort((a, b) => b.endDate.localeCompare(a.endDate));
  const loading = state === "loading" || state === "refreshing";
  const message = stateMessage(state, staleReason);
  const showData = facts.length > 0;
  const chart = renderChart(points);
  const headingId = `company-fundamentals-${ticker.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`;
  const latestRevenue = facts.filter((fact) => fact.metric === "revenue")
    .sort((a, b) => b.endDate.localeCompare(a.endDate))[0];
  const researchFact = latestRevenue ?? [...facts].sort((a, b) => b.endDate.localeCompare(a.endDate))[0];
  const researchComparison = researchFact
    ? comparisons.find((comparison) => comparison.metric === researchFact.metric && comparison.currentFactId === researchFact.id)
    : undefined;
  const researchPriorFact = researchComparison?.priorFactId
    ? facts.find((fact) => fact.id === researchComparison.priorFactId)
    : undefined;
  const researchPriorDate = researchPriorFact?.endDate ? dateLabel(researchPriorFact.endDate) : "the earlier matched period";
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
      ? "Open the cited filing and locate the same metric in a calendar-matched prior-year statement."
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
        {refreshAllowed ? "Refresh runs only when requested." : refreshBlockedReason || "Refresh is unavailable under current controls."}
      </p>
      <p className="cf-refresh-reason">On-demand for this company. Scheduled SEC 8-K monitoring is a separate source.</p>

      {message && <p className={`cf-state cf-state-${state}`} role={state === "failed" ? "alert" : loading || state === "stale" || state === "blocked" ? "status" : "note"}>{message}</p>}
      {lastRefreshError && showData && <p className="cf-state cf-state-warning" role="status">The latest refresh failed; saved SEC facts below were retained. {lastRefreshError}</p>}
      {lastRefreshError && !showData && state === "failed" && <p className="cf-detail" role="status">{lastRefreshError}</p>}
      {showData ? (
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
                      <p className="cf-period">{fact.startDate ? `${dateLabel(fact.startDate)} – ` : "As of "}{dateLabel(fact.endDate)} · {fact.form}</p>
                      {comparison?.state === "comparable" && comparison.delta !== null ? (
                        <>
                          <p className="cf-comparison">{comparisonLabel(comparison.changeInterpretation, comparison.delta)} vs period ending {priorFact?.endDate || "a prior date"} in the same filing: {formatValue(comparison.delta, fact.unit)}{visiblePercentChange === null ? "" : ` (${visiblePercentChange}%)`}{comparison.changeInterpretation === "within_reported_precision" ? " · direction unresolved" : ""}</p>
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
      ) : state !== "loading" && state !== "refreshing" && <p className="cf-empty">No saved values or chart are shown without persisted SEC facts.</p>}

      {filingFinding && filingNextCheck && researchFact && <aside className="cf-next-question" aria-label="Filing triage">
        <p className="micro">FILING TRIAGE</p>
        <p><strong>Observed</strong><br />{filingFinding}</p>
        <p><strong>Not established</strong><br />This totals-only view does not assess operating drivers, materiality, persistence, or narrative counterevidence.</p>
        <p><strong>Next check</strong><br />{filingNextCheck}</p>
        {researchUrl && <a href={researchUrl} target="_blank" rel="noreferrer">Open cited SEC filing · {researchFact.accession}</a>}
      </aside>}

      {chart}
      <details className="cf-coverage">
        <summary>SEC coverage and comparison limits</summary>
        <p>CompanyFacts covers standard, whole-entity XBRL facts. It may omit custom tags and dimensional disclosures. SEC period comparisons do not establish cause, materiality, business quality, or investment merit.</p>
        {coverage.length ? <ul>{coverage.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul> : <p>Coverage diagnostics have not been supplied for this saved view.</p>}
      </details>
    </section>
  );
}
