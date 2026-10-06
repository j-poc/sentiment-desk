export type ChartView = "luna" | "jev";
export type ChartViewPreference =
  | { kind: "automatic" }
  | { kind: "manual"; view: ChartView };

/** A deliberate view choice belongs to the company where it was made. */
export function chartViewPreferenceAfterCompanySelection(
  preference: ChartViewPreference,
  currentCompanyId: string | null,
  nextCompanyId: string,
): ChartViewPreference {
  return currentCompanyId === nextCompanyId ? preference : { kind: "automatic" };
}

export type CategoricalChartSnapshot = {
  companyId: string;
  windowHours: number;
  status: "loading" | "ready" | "failed";
  eligibleObservationCount: number | null;
  observedAt: number | null;
};

export function shouldRefreshInactiveLunaSnapshot(
  chartView: ChartView,
  selectedCompanyId: string | null,
  update: { companyId: string; provider: string | null; classifiedAt: number | null },
): boolean {
  return chartView === "jev"
    && selectedCompanyId != null
    && update.companyId === selectedCompanyId
    && update.provider === "openai_luna"
    && update.classifiedAt != null;
}

export function automaticHistoricalArchiveLookupAction(
  lookupKey: string,
  attemptedKey: string | null,
  retriedKey: string | null,
  request: { loading: boolean; failed: boolean },
): "lookup" | "retry" | "skip" {
  if (request.loading) return "skip";
  if (attemptedKey !== lookupKey) return "lookup";
  if (request.failed && retriedKey !== lookupKey) return "retry";
  return "skip";
}

export function shouldLoadHistoricalJevForVisibleTab(input: {
  chartView: ChartView;
  companyId: string | null;
  lookupKey: string;
  attemptedKey: string | null;
  archive: {
    companyId: string;
    loading: boolean;
    hasResult: boolean;
    confirmedEmpty: boolean;
    failed: boolean;
  } | null;
}): boolean {
  if (input.chartView !== "jev" || input.companyId == null || input.attemptedKey === input.lookupKey) return false;
  if (input.archive?.companyId !== input.companyId) return true;
  return !input.archive.loading
    && !input.archive.hasResult
    && !input.archive.confirmedEmpty
    && !input.archive.failed;
}

export function matchingCategoricalSnapshot(
  snapshot: CategoricalChartSnapshot | null,
  companyId: string | null,
  windowHours: number,
): CategoricalChartSnapshot | null {
  return snapshot?.companyId === companyId && snapshot.windowHours === windowHours
    ? snapshot
    : null;
}

export function shouldLookupHistoricalJev(
  preference: ChartViewPreference,
  snapshot: CategoricalChartSnapshot | null,
  companyId: string | null,
  windowHours = 168,
): boolean {
  const matching = matchingCategoricalSnapshot(snapshot, companyId, windowHours);
  return preference.kind === "automatic"
    && companyId != null
    && matching != null
    && matching.status === "ready"
    && matching.eligibleObservationCount === 0;
}

export function deriveChartView(preference: ChartViewPreference): ChartView {
  // Current classifier output is the default research task. Historical Jev is
  // available by deliberate tab/action because its fixed archive week can be
  // older than the rolling source-evidence window shown beside it.
  return preference.kind === "manual" ? preference.view : "luna";
}
