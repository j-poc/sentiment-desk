import { useEffect, useMemo, useRef, useState } from "react";
import { ApiRequestError, getCompanyResearchBrief, saveCompanyResearchDecision } from "../lib/api.js";
import type {
  CompanyResearchBriefResponse,
  CompanyResearchDecision,
  CompanyResearchEvidenceRole,
  CompanyResearchEvidenceRoleChoice,
  ResearchBriefObservation,
} from "../../../shared/company-research-brief.js";
import "./company-research-brief.css";

const DECISIONS: ReadonlyArray<{ value: CompanyResearchDecision; label: string }> = [
  { value: "investigate_further", label: "Investigate further" },
  { value: "insufficient_evidence", label: "Insufficient evidence" },
  { value: "set_aside", label: "Set aside" },
];
const ROLES: ReadonlyArray<{ value: CompanyResearchEvidenceRole; label: string }> = [
  { value: "not_reviewed", label: "Not reviewed" },
  { value: "supports_assessment", label: "Supports my assessment" },
  { value: "challenges_assessment", label: "Challenges my assessment" },
  { value: "context_only", label: "Context only" },
];
const METRICS: Record<string, string> = {
  revenue: "Revenue", operating_income: "Operating income", net_income: "Net income", operating_cash_flow: "Operating cash flow",
};
const CLOCK = new Intl.DateTimeFormat("en", {
  year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZone: "UTC", timeZoneName: "short",
});

function clock(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "Not recorded";
  return CLOCK.format(ms);
}

function safeHttpsUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function sourceClockLabel(item: ResearchBriefObservation): string {
  if (item.timeBasis === "aggregator_declared") return "Feed-declared time";
  if (item.timeBasis === "publisher_declared") return "Publisher-declared time";
  if (item.timeBasis === "provider_observed") return "Provider-observed time";
  return "Source time unknown";
}

function factLabel(value: string, unit: string): string {
  const match = value.match(/^(-?)(0|[1-9]\d*)(\.\d+)?$/);
  if (!match || value.length > 80) return "Unavailable";
  const integer = match[2]!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${match[1]}${integer}${match[3] ?? ""} ${unit}`.trim();
}

function percentUnavailableLabel(reason: string | null): string {
  const sourceReason = reason?.split(". ").find((sentence) => /^percentage change is withheld because /iu.test(sentence));
  if (sourceReason) return ` · ${sourceReason[0]!.toLowerCase()}${sourceReason.slice(1)}`;
  return " · percentage change unavailable; the saved SEC comparison does not provide a validated ratio.";
}

function factPeriodLabel(fact: NonNullable<CompanyResearchBriefResponse["brief"]>["facts"][number]): string {
  const period = fact.startDate ? `${fact.startDate}–${fact.endDate}` : `As of ${fact.endDate}`;
  const basis = fact.startDate ? `${fact.durationClass} duration` : "instant";
  return `${basis} · ${period}`;
}

function newRoles(response: CompanyResearchBriefResponse | null): Record<string, CompanyResearchEvidenceRole> {
  if (!response) return {};
  const saved = response.decision?.snapshotKey === response.snapshotKey ? response.decision.evidenceRoles : [];
  const result: Record<string, CompanyResearchEvidenceRole> = {};
  for (const item of response?.brief.observations ?? []) result[item.id] = "not_reviewed";
  for (const role of saved) if (role.observationId in result) result[role.observationId] = role.role;
  return result;
}

export function CompanyResearchBriefPanel(props: {
  companyId: string; companyName: string; ticker: string;
  resumeSnapshot?: { asOfMs: number; snapshotKey: string } | null;
}) {
  // A company switch must discard the prior issuer's in-flight reads, writes,
  // and draft state. The inner panel's requests may finish after unmount, but
  // they can no longer update a panel now showing another issuer.
  const resumeKey = props.resumeSnapshot ? `${props.resumeSnapshot.asOfMs}:${props.resumeSnapshot.snapshotKey}` : "current";
  return <CompanyResearchBriefForCompany key={`${props.companyId}:${resumeKey}`} {...props} />;
}

function CompanyResearchBriefForCompany({ companyId, companyName, ticker, resumeSnapshot }: {
  companyId: string; companyName: string; ticker: string;
  resumeSnapshot?: { asOfMs: number; snapshotKey: string } | null;
}) {
  const [response, setResponse] = useState<CompanyResearchBriefResponse | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "failed" | "resume_mismatch">("loading");
  const [saveState, setSaveState] = useState<"idle" | "saving" | "failed">("idle");
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [decision, setDecision] = useState<CompanyResearchDecision>("insufficient_evidence");
  const [rationale, setRationale] = useState("");
  const [nextCheckDate, setNextCheckDate] = useState("");
  const [roles, setRoles] = useState<Record<string, CompanyResearchEvidenceRole>>({});
  const pendingRequestRef = useRef<{ body: string; key: string } | null>(null);
  const nameId = useMemo(() => `research-brief-${ticker.toLowerCase().replace(/[^a-z0-9-]/g, "-")}`, [ticker]);
  const targetAsOfMs = resumeSnapshot?.asOfMs;
  const targetSnapshotKey = resumeSnapshot?.snapshotKey;

  useEffect(() => {
    const controller = new AbortController();
    let alive = true;
    setResponse(null);
    setLoadState("loading");
    setSaveState("idle");
    setSaveMessage(null);
    pendingRequestRef.current = null;
    void getCompanyResearchBrief(companyId, controller.signal, targetAsOfMs).then((loaded) => {
      if (!alive) return;
      if (loaded.brief.company.companyId !== companyId) {
        setResponse(null);
        setLoadState(targetSnapshotKey === undefined ? "failed" : "resume_mismatch");
        return;
      }
      if (targetSnapshotKey !== undefined && (!loaded.snapshotKey || loaded.snapshotKey !== targetSnapshotKey)) {
        setResponse(null);
        setLoadState("resume_mismatch");
        return;
      }
      setResponse(loaded);
      setLoadState("ready");
      setDecision(loaded.decision?.snapshotKey === loaded.snapshotKey ? loaded.decision.decision : "insufficient_evidence");
      setRationale(loaded.decision?.snapshotKey === loaded.snapshotKey ? loaded.decision.rationale : "");
      setNextCheckDate(loaded.decision?.snapshotKey === loaded.snapshotKey ? loaded.decision.nextCheckDate ?? "" : "");
      setRoles(newRoles(loaded));
    }).catch(() => {
      if (!alive || controller.signal.aborted) return;
      setResponse(null);
      setLoadState(targetSnapshotKey === undefined ? "failed" : "resume_mismatch");
    });
    return () => { alive = false; controller.abort(); };
  }, [companyId, targetAsOfMs, targetSnapshotKey]);

  const decisionForDisplay = loadState === "ready" && response?.decision && (targetSnapshotKey === undefined || response.decision.snapshotKey === targetSnapshotKey)
    ? response.decision
    : null;
  const hasMatchingSavedDecision = response != null && decisionForDisplay?.snapshotKey === response.snapshotKey;
  const saveEnabled = loadState === "ready" && response?.decisionStorageAvailable === true && saveState !== "saving";

  async function refresh() {
    setLoadState("loading");
    setResponse(null);
    setSaveMessage(null);
    try {
      const loaded = await getCompanyResearchBrief(companyId, undefined, targetAsOfMs);
      if (loaded.brief.company.companyId !== companyId) {
        setResponse(null);
        setLoadState(targetSnapshotKey === undefined ? "failed" : "resume_mismatch");
        return;
      }
      if (targetSnapshotKey !== undefined && (!loaded.snapshotKey || loaded.snapshotKey !== targetSnapshotKey)) {
        setResponse(null);
        setLoadState("resume_mismatch");
        return;
      }
      setResponse(loaded);
      setLoadState("ready");
      setDecision(loaded.decision?.snapshotKey === loaded.snapshotKey ? loaded.decision.decision : "insufficient_evidence");
      setRationale(loaded.decision?.snapshotKey === loaded.snapshotKey ? loaded.decision.rationale : "");
      setNextCheckDate(loaded.decision?.snapshotKey === loaded.snapshotKey ? loaded.decision.nextCheckDate ?? "" : "");
      setRoles(newRoles(loaded));
    } catch {
      setResponse(null);
      setLoadState(targetSnapshotKey === undefined ? "failed" : "resume_mismatch");
    }
  }

  async function save() {
    if (!response || !response.decisionStorageAvailable || saveState === "saving") return;
    const evidenceRoles: CompanyResearchEvidenceRoleChoice[] = response.brief.observations.map((item) => ({
      observationId: item.id,
      role: roles[item.id] ?? "not_reviewed",
    }));
    const values = {
      asOfMs: response.brief.asOfMs,
      snapshotKey: response.snapshotKey,
      decision,
      rationale,
      evidenceRoles,
      nextCheckDate: nextCheckDate || null,
    };
    const bodyWithoutKey = JSON.stringify(values);
    if (pendingRequestRef.current?.body !== bodyWithoutKey) {
      pendingRequestRef.current = { body: bodyWithoutKey, key: crypto.randomUUID() };
    }
    setSaveState("saving");
    setSaveMessage(null);
    try {
      const saved = await saveCompanyResearchDecision(companyId, { ...values, requestKey: pendingRequestRef.current.key });
      if (saved.brief.company.companyId !== companyId) return;
      setResponse(saved);
      setRoles(newRoles(saved));
      setSaveState("idle");
      setSaveMessage("Decision saved locally with this evidence snapshot.");
      pendingRequestRef.current = null;
    } catch (error) {
      setSaveState("failed");
      if (error instanceof ApiRequestError && error.code === "company_research_decision_storage_paused") {
        setResponse((current) => current ? {
          ...current,
          decisionStorageAvailable: false,
          decisionStorageUnavailableReason: "Local storage became unavailable while saving.",
        } : current);
        setSaveMessage("Storage is paused. Your decision draft is still here. Free disk space if needed, then reload this brief to recheck saving.");
      } else {
        setSaveMessage(error instanceof ApiRequestError && error.status === 409
          ? "This evidence snapshot changed. Reload the brief before saving your decision."
          : "The decision could not be saved. Your draft is still here; retry when local storage is available.");
      }
    }
  }

  const brief = loadState === "ready" ? response?.brief : undefined;
  const questionPair = brief?.nextResearchQuestion
    ? {
      prior: brief.facts.find((fact) => fact.id === brief.nextResearchQuestion!.priorFactId),
      current: brief.facts.find((fact) => fact.id === brief.nextResearchQuestion!.currentFactId),
      comparison: brief.comparisons.find((item) => item.priorFactId === brief.nextResearchQuestion!.priorFactId
        && item.currentFactId === brief.nextResearchQuestion!.currentFactId),
    }
    : null;
  const evidenceRoleCounts = useMemo(() => {
    const counts = { supports: 0, challenges: 0, context: 0, notReviewed: 0 };
    for (const item of brief?.observations ?? []) {
      const role = roles[item.id] ?? "not_reviewed";
      if (role === "supports_assessment") counts.supports += 1;
      else if (role === "challenges_assessment") counts.challenges += 1;
      else if (role === "context_only") counts.context += 1;
      else counts.notReviewed += 1;
    }
    return counts;
  }, [brief?.observations, roles]);
  const latestFacts = new Map<string, NonNullable<typeof brief>["facts"][number]>();
  for (const fact of brief?.facts ?? []) {
    const existing = latestFacts.get(fact.metric);
    if (!existing || fact.endDate > existing.endDate || (fact.endDate === existing.endDate && fact.retrievedAt > existing.retrievedAt)) {
      latestFacts.set(fact.metric, fact);
    }
  }

  return (
    <section id={`company-research-brief-${companyId}`} className="panel company-research-brief" aria-labelledby={nameId} aria-busy={loadState === "loading"}>
      <header className="crb-header">
        <div>
          <p className="micro">SOURCE-BOUND RESEARCH</p>
          <h2 id={nameId} tabIndex={-1}>{companyName} <span>{ticker}</span></h2>
        </div>
        {loadState === "ready" && brief && <p className="crb-cutoff">Saved evidence through<br /><time dateTime={new Date(brief.asOfMs).toISOString()}>{clock(brief.asOfMs)}</time></p>}
      </header>
      <p className="crb-explainer">Saved SEC facts and receipt-verified public records for this listed company. This is an analyst workspace, not an investment recommendation. Reading and saving make no source or model requests.</p>

      {loadState === "loading" && <p className="crb-state" role="status">Loading the saved evidence snapshot…</p>}
      {loadState === "failed" && <div className="crb-state crb-error" role="alert"><span>The saved research brief could not be loaded. Your other selected-company data remains available.</span><button type="button" onClick={() => void refresh()}>Retry</button></div>}
      {loadState === "resume_mismatch" && <div className="crb-state crb-warning" role="alert"><span>The requested saved evidence snapshot could not be reconstructed with its exact digest. Evidence and decision are withheld; the current brief is not substituted.</span><button type="button" onClick={() => void refresh()}>Retry reconstruction</button></div>}
      {brief && <>
        <div className="crb-coverage" aria-label="Evidence coverage">
          <span>SEC facts: <strong>{brief.coverage.sec}</strong></span>
          <span>Saved public observations: <strong>{brief.coverage.publicObservations}</strong> · {brief.observations.length} shown</span>
          {brief.company.cik && <span>CIK {brief.company.cik}</span>}
        </div>
        <p className="crb-review-progress" role="status" aria-live="polite">
          Your evidence tags · {evidenceRoleCounts.supports} support · {evidenceRoleCounts.challenges} challenge · {evidenceRoleCounts.context} context · {evidenceRoleCounts.notReviewed} not reviewed
        </p>

        {brief.nextResearchQuestion ? <aside className="crb-question" aria-label="Next research question">
          <p className="micro">NEXT RESEARCH QUESTION · {METRICS[brief.nextResearchQuestion.metric] ?? brief.nextResearchQuestion.metric}</p>
          <p>{brief.nextResearchQuestion.question}</p>
          <small>This asks what to investigate; it does not establish cause or materiality.</small>
        </aside> : <p className="crb-state">No validated same-filing metric pair supports a deterministic next question in this saved snapshot.</p>}

        {questionPair?.prior && questionPair.current && <section className="crb-pair" aria-label="SEC facts behind next research question">
          <div className="crb-pair-heading">
            <p className="micro">LINKED SEC FACT PAIR</p>
            <small>Exact persisted rows referenced by the question, including when another row is newer for the same metric.</small>
          </div>
          <div className="crb-pair-facts">
            {[{ label: "Prior fact", fact: questionPair.prior }, { label: "Current fact", fact: questionPair.current }].map(({ label, fact }) => {
              const link = safeHttpsUrl(fact.sourceUrl);
              return <article className="crb-pair-fact" key={`${label}-${fact.id}`}>
                <p className="crb-pair-role">{label}</p>
                <strong>{factLabel(fact.value, fact.unit)}</strong>
                <p>{factPeriodLabel(fact)}</p>
                <p>{fact.form} · accession {fact.accession}</p>
                <p>Accepted {clock(fact.acceptedAt)} · Retrieved {clock(fact.retrievedAt)}</p>
                {link && <a href={link} target="_blank" rel="noreferrer">Open source SEC filing</a>}
                <small>SEC fact {fact.id}</small>
              </article>;
            })}
          </div>
          <p className="crb-pair-caveat">Reported values can be compared arithmetically; the difference does not establish its cause, business significance, or materiality.</p>
          {questionPair.comparison?.delta != null && <p className="crb-pair-caveat" aria-label="Reported arithmetic change">
            Reported arithmetic difference: {questionPair.comparison.delta} {questionPair.current.unit}
            {questionPair.comparison.percentChange == null ? percentUnavailableLabel(questionPair.comparison.reason)
              : ` · ${questionPair.comparison.percentChange}% versus the prior reported value.`}
          </p>}
          {questionPair.comparison?.reason && <p className="crb-pair-caveat">Comparison note: {questionPair.comparison.reason}</p>}
        </section>}

        {decisionForDisplay && hasMatchingSavedDecision && decisionForDisplay.asOfMs !== brief.asOfMs && <p className="crb-state" role="status">
          Your saved decision was recorded at {clock(decisionForDisplay.asOfMs)}. The current cutoff is {clock(brief.asOfMs)}; the exact fact and source manifest is unchanged.
        </p>}
        {decisionForDisplay && !hasMatchingSavedDecision && <>
          <p className="crb-state crb-warning" role="status">
            The current brief contains a different saved evidence manifest. Your earlier decision and its original evidence references remain below; record a new decision only if your view has changed.
          </p>
          <details className="crb-section crb-prior-decision">
            <summary>Last saved decision · {decisionForDisplay.decision.replaceAll("_", " ")}</summary>
            <p>{decisionForDisplay.rationale || "No rationale was recorded."}</p>
            <p>Saved {clock(decisionForDisplay.createdAt)} · evidence cutoff {clock(decisionForDisplay.asOfMs)} · SEC snapshot {decisionForDisplay.snapshotId ?? "none"}</p>
            <p>Original evidence manifest {decisionForDisplay.snapshotKey}</p>
            <p>Fact IDs: {decisionForDisplay.factIds.length ? decisionForDisplay.factIds.join(", ") : "none"}</p>
            <p>Observation IDs and analyst roles: {decisionForDisplay.evidenceRoles.length
              ? decisionForDisplay.evidenceRoles.map((item) => `${item.observationId} (${item.role.replaceAll("_", " ")})`).join("; ")
              : decisionForDisplay.observationIds.length ? decisionForDisplay.observationIds.join(", ") : "none"}</p>
            {decisionForDisplay.nextCheckDate && <p>Next check: {decisionForDisplay.nextCheckDate}</p>}
          </details>
        </>}
        {response?.decisionStorageAvailable === false && <p className="crb-state crb-warning" role="status">
          Decision saving is unavailable. {response.decisionStorageUnavailableReason ?? "Local writes are paused."} Your draft stays on this page; reload this brief to recheck saving after resolving the storage issue.
        </p>}
        <form className="crb-decision" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <div className="crb-decision-head"><div><p className="micro">ANALYST DECISION</p><h3>What should happen next?</h3></div>
            {hasMatchingSavedDecision && <span>Saved {clock(decisionForDisplay!.createdAt)}</span>}
          </div>
          <fieldset disabled={loadState !== "ready"}>
            <legend>Choose a research disposition</legend>
            <div className="crb-decision-options">
              {DECISIONS.map((item) => <label key={item.value}>
                <input type="radio" name={`research-decision-${ticker}`} value={item.value} checked={decision === item.value} onChange={() => setDecision(item.value)} />
                <span>{item.label}</span>
              </label>)}
            </div>
            <label className="crb-rationale">Your reasoning for this decision
              <textarea value={rationale} maxLength={2_000} rows={3} onChange={(event) => setRationale(event.target.value)} placeholder="What does the evidence support, challenge, or leave unresolved?" />
            </label>
            <label className="crb-next-check">Next check date <span>Optional</span>
              <input type="date" value={nextCheckDate} onChange={(event) => setNextCheckDate(event.target.value)} />
            </label>
            <button className="crb-save" type="submit" disabled={!saveEnabled}>
              {saveState === "saving" ? "Saving locally…" : hasMatchingSavedDecision ? "Save revised decision" : "Save decision"}
            </button>
          </fieldset>
          {saveMessage && <p className={`crb-state ${saveState === "failed" ? "crb-error" : ""}`} role={saveState === "failed" ? "alert" : "status"}>{saveMessage}</p>}
        </form>

        <details className="crb-section">
          <summary>Reported financial facts · {brief.facts.length} saved rows</summary>
          {brief.facts.length === 0 ? <p className="crb-muted">No saved SEC facts at this cutoff. A later on-demand refresh will not alter this saved brief.</p> : <div className="crb-facts">
            {[...latestFacts.values()].sort((a, b) => a.metric.localeCompare(b.metric)).map((fact) => {
              const comparison = brief.comparisons.find((item) => item.currentFactId === fact.id);
              const prior = comparison?.priorFactId ? brief.facts.find((item) => item.id === comparison.priorFactId) : undefined;
              const link = safeHttpsUrl(fact.sourceUrl);
              return <article className="crb-fact" key={fact.id}>
                <div><strong>{METRICS[fact.metric] ?? fact.metric}</strong><span>{factLabel(fact.value, fact.unit)}</span></div>
                <p>{fact.startDate ? `${fact.startDate}–${fact.endDate}` : `As of ${fact.endDate}`} · {fact.form} · {fact.accession}</p>
                {prior && <p>Matched prior: {factLabel(prior.value, prior.unit)} · {prior.startDate ?? "as of"}–{prior.endDate} · {comparison?.periodAlignment?.replaceAll("_", " ")}</p>}
                {comparison?.delta !== null && comparison?.delta !== undefined && <p>Reported-value arithmetic difference: {comparison.delta} {fact.unit} · {comparison.changeInterpretation.replaceAll("_", " ")}</p>}
                {comparison?.reason && <p>{comparison.reason}</p>}
                <p>Filed {fact.filedAt == null ? "not recorded" : new Date(fact.filedAt).toISOString().slice(0, 10)} · Accepted {clock(fact.acceptedAt)} · Retrieved {clock(fact.retrievedAt)}</p>
                <p>Precision: {fact.reportedPrecisionStatus}{fact.reportedDecimals == null ? "" : ` · decimals ${fact.reportedDecimals}`}</p>
                <p>Fact {fact.id} · SEC receipt {fact.companyFactsDeliveryId}</p>
                {link && <a href={link} target="_blank" rel="noreferrer">Open SEC filing</a>}
              </article>;
            })}
          </div>}
        </details>

        <details className="crb-section">
          <summary>Public-source leads · {brief.observations.length} saved rows</summary>
          {brief.observations.length === 0 ? <p className="crb-muted">No receipt-verified public observations were saved by this cutoff.</p> : <div className="crb-observations">
            {brief.observations.map((item) => {
              const link = safeHttpsUrl(item.sourceUrl);
              return <article className="crb-observation" key={item.id}>
                <div className="crb-observation-head">
                  {link ? <a href={link} target="_blank" rel="noreferrer">{item.title}</a> : <strong>{item.title}</strong>}
                  <label>Analyst evidence role
                    <select value={roles[item.id] ?? "not_reviewed"} onChange={(event) => setRoles((current) => ({ ...current, [item.id]: event.target.value as CompanyResearchEvidenceRole }))}>
                      {ROLES.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}
                    </select>
                  </label>
                </div>
                {item.snippet && <p className="crb-snippet">{item.snippet}</p>}
                <p className="crb-source-meta">{item.publisher} · {item.collector} · {item.status}</p>
                <dl>
                  <div><dt>{sourceClockLabel(item)}</dt><dd>{clock(item.sourceTime)}</dd></div>
                  <div><dt>Retrieved</dt><dd>{clock(item.retrievedAt)}</dd></div>
                  <div><dt>Delivery completed</dt><dd>{clock(item.deliveryCompletedAt)} · {item.deliveryId}</dd></div>
                  <div><dt>Ingestion completed</dt><dd>{clock(item.ingestionCompletedAt)} · record {item.id}</dd></div>
                </dl>
              </article>;
            })}
          </div>}
          <p className="crb-muted">These items are leads to inspect. Sentiment, publisher count, or repeated coverage does not establish factual support, contradiction, source independence, or materiality.</p>
        </details>

        {brief.coverage.reasons.length > 0 && <details className="crb-section crb-limits">
          <summary>Coverage limits and withheld records</summary>
          <ul>{brief.coverage.reasons.map((reason, index) => <li key={`${index}-${reason}`}>{reason}</li>)}</ul>
          {brief.interpretationLimits.map((limit) => <p key={limit}>{limit}</p>)}
        </details>}

      </>}
    </section>
  );
}
