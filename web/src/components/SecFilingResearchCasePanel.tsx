import { useEffect, useRef, useState } from "react";
import type { CompanyFundamentalsView } from "../../../shared/company-fundamentals.js";
import type { CompanyResearchDecision } from "../../../shared/company-research-brief.js";
import type { SavedSecFilingResearchDecision } from "../../../shared/sec-filing-research-cases.js";
import type { SecFilingResearchCase, SecFilingResearchCaseDetail } from "../../../shared/sec-filing-research-cases.js";
import {
  getSecFilingResearchCase,
  refreshSecFilingResearchCaseFundamentals,
  saveSecFilingResearchCaseDecision,
  verifySecFilingResearchCaseIdentity,
} from "../lib/api.js";
import { CompanyFundamentals } from "./CompanyFundamentals.js";

const DECISIONS: ReadonlyArray<{ value: CompanyResearchDecision; label: string }> = [
  { value: "investigate_further", label: "Investigate further" },
  { value: "insufficient_evidence", label: "Insufficient evidence" },
  { value: "set_aside", label: "Set aside" },
];

function emptyFundamentals(id: string): CompanyFundamentalsView {
  return {
    companyId: id,
    state: "idle",
    periodComparisonPolicyVersion: "sec-period-comparison/2",
    snapshotId: null,
    facts: [],
    comparisons: [],
    points: [],
    coverage: [],
    refreshAllowed: true,
    refreshBlockedReason: null,
    lastRefreshError: null,
    staleReason: null,
    latestAttemptAt: null,
    retrievedAt: null,
  };
}

function savedForSnapshot(
  detail: SecFilingResearchCaseDetail | null,
): SavedSecFilingResearchDecision | null {
  const brief = detail?.brief;
  if (!brief) return null;
  return brief.decision?.snapshotKey === brief.snapshotKey ? brief.decision : null;
}

function savedFields(detail: SecFilingResearchCaseDetail | null) {
  const saved = savedForSnapshot(detail);
  return {
    decision: saved?.decision ?? "insufficient_evidence" as const,
    rationale: saved?.rationale ?? "",
    nextCheckDate: saved?.nextCheckDate ?? "",
  };
}

function savedAtLabel(value: number): string {
  return Number.isSafeInteger(value) && Math.abs(value) <= 8_640_000_000_000_000
    ? new Date(value).toISOString()
    : "time not verified";
}

function hasVerifiedIdentity(detail: SecFilingResearchCaseDetail | null, expectedCase: SecFilingResearchCase): boolean {
  const identity = detail?.case.identity;
  const receipt = identity?.receipt;
  return detail?.case.id === expectedCase.id
    && detail.case.cik === expectedCase.cik
    && detail.case.triggeringAccession === expectedCase.triggeringAccession
    && identity?.status === "verified"
    && identity.ticker === detail.case.filingSymbol
    && typeof identity.issuerName === "string" && identity.issuerName.trim().length > 0
    && receipt?.url === "https://www.sec.gov/files/company_tickers_exchange.json"
    && /^\d{4}-\d\d-\d\dT/.test(receipt.retrievedAt)
    && /^[a-f0-9]{64}$/i.test(receipt.sha256);
}

export function SecFilingResearchCasePanel({
  initialCase,
  onClose,
}: {
  initialCase: SecFilingResearchCase;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<SecFilingResearchCaseDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [transportError, setTransportError] = useState<string | null>(null);
  const [decision, setDecision] = useState<CompanyResearchDecision>("insufficient_evidence");
  const [rationale, setRationale] = useState("");
  const [nextCheckDate, setNextCheckDate] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const refreshKey = useRef<string | null>(null);
  const saveKey = useRef<{ body: string; key: string } | null>(null);
  const identityVerified = hasVerifiedIdentity(detail, initialCase);
  const subjectName = identityVerified && detail ? detail.case.identity.issuerName! : initialCase.filingIssuer;
  const ticker = identityVerified && detail ? detail.case.identity.ticker! : initialCase.filingSymbol;
  const caseFundamentals = detail?.fundamentals?.caseId === initialCase.id ? detail.fundamentals : null;
  const fundamentals = identityVerified && caseFundamentals ? caseFundamentals : emptyFundamentals(initialCase.id);
  const briefResponse = identityVerified ? detail?.brief ?? null : null;
  const saved = savedForSnapshot(detail);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setTransportError(null);
    void getSecFilingResearchCase(initialCase.id, controller.signal).then((value) => {
      if (!active) return;
      setDetail(value);
      const fields = savedFields(value);
      setDecision(fields.decision);
      setRationale(fields.rationale);
      setNextCheckDate(fields.nextCheckDate);
      setLoading(false);
    }).catch(() => {
      if (!active || controller.signal.aborted) return;
      setTransportError("The saved research case could not be read. Its original filing remains available in Recent Filings.");
      setLoading(false);
    });
    return () => { active = false; controller.abort(); };
  }, [initialCase.id]);

  const reload = async () => {
    setLoading(true);
    setTransportError(null);
    try {
      const value = await getSecFilingResearchCase(initialCase.id);
      setDetail(value);
      const fields = savedFields(value);
      setDecision(fields.decision);
      setRationale(fields.rationale);
      setNextCheckDate(fields.nextCheckDate);
    } catch {
      setTransportError("The saved research case could not be read. Retry when local storage is available.");
    } finally {
      setLoading(false);
    }
  };

  const refreshFacts = async () => {
    if (refreshing || !fundamentals.refreshAllowed || !identityVerified) return;
    refreshKey.current ??= crypto.randomUUID();
    setRefreshing(true);
    setTransportError(null);
    setSaveMessage(null);
    try {
      const value = await refreshSecFilingResearchCaseFundamentals(initialCase.id, refreshKey.current);
      refreshKey.current = null;
      setDetail(value);
      const fields = savedFields(value);
      setDecision(fields.decision);
      setRationale(fields.rationale);
      setNextCheckDate(fields.nextCheckDate);
    } catch {
      setTransportError("SEC could not complete the fundamentals refresh. Saved evidence remains available; retry only after reviewing the displayed status.");
      // Keep the key after an unknown transport outcome so a deliberate retry
      // cannot create a duplicate request after a lost response.
    } finally {
      setRefreshing(false);
    }
  };

  const verifyIdentity = async () => {
    if (verifying || !["unverified", "mismatch"].includes(detail?.case.identity.status ?? "")) return;
    setVerifying(true);
    setTransportError(null);
    setSaveMessage(null);
    try {
      await verifySecFilingResearchCaseIdentity(initialCase.id);
      await reload();
    } catch {
      setTransportError("SEC issuer verification could not be completed. No CompanyFacts request or model analysis was made; retry when the SEC identity service is available.");
    } finally {
      setVerifying(false);
    }
  };

  const save = async () => {
    if (!briefResponse?.decisionStorageAvailable || saving) return;
    const values = {
      asOfMs: briefResponse.brief.asOfMs,
      snapshotKey: briefResponse.snapshotKey,
      factIds: briefResponse.brief.facts.map((fact) => fact.id),
      decision,
      rationale,
      nextCheckDate: nextCheckDate || null,
    };
    const serialized = JSON.stringify(values);
    if (saveKey.current?.body !== serialized) saveKey.current = { body: serialized, key: crypto.randomUUID() };
    setSaving(true);
    setSaveMessage(null);
    try {
      const savedBrief = await saveSecFilingResearchCaseDecision(initialCase.id, {
        ...values,
        requestKey: saveKey.current!.key,
      });
      setDetail((current) => current ? { ...current, brief: savedBrief } : current);
      saveKey.current = null;
      setSaveMessage("Decision saved against this exact SEC evidence snapshot.");
    } catch {
      setSaveMessage("The decision did not save. Your draft remains here; retry after checking that local storage is available.");
    } finally {
      setSaving(false);
    }
  };

  return <section className="panel grid min-w-0 gap-4 p-4 sm:p-5" aria-labelledby={`sec-case-${initialCase.id}`} aria-busy={loading || refreshing || verifying}>
    <header className="flex min-w-0 flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="micro text-emerald-200/70">PUBLIC ISSUER · RESEARCH ONLY</p>
        <h2 id={`sec-case-${initialCase.id}`} tabIndex={-1} className="mt-1 break-words text-lg font-semibold text-white/90">{subjectName} <span className="font-mono text-sm text-white/50">{ticker}</span></h2>
        <p className="mt-1 break-all font-mono text-[10px] text-white/40">CIK {initialCase.cik} · filing {initialCase.triggeringAccession}</p>
      </div>
      <button type="button" onClick={onClose} className="rounded border border-white/10 px-2.5 py-1.5 text-xs text-white/55 hover:text-white/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300">Close case</button>
    </header>

    <div className="grid min-w-0 gap-2 rounded-md border border-white/[0.08] bg-black/15 p-3 text-xs leading-5 text-white/55">
      <p>This selected filing opens a source-bound SEC research case. It does not add the issuer to the watchlist, sentiment collection, private-note workflow, or Opportunity Radar.</p>
      <p className="text-amber-100/75">The filing inbox is not a complete company universe or a small-cap screen. Market capitalization is unavailable until price, dated shares, and corporate-action basis are verified.</p>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-white/40">
        <span>Listing directory retrieved {initialCase.listingProof.retrievedAt}</span>
        <span>SHA-256 {initialCase.listingProof.sha256.slice(0, 12)}</span>
        <a href={initialCase.filingUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="text-emerald-200/70 underline-offset-2 hover:underline">Open triggering SEC filing</a>
      </div>
    </div>

    {loading && !detail && <p className="text-sm text-white/50" role="status">Reading saved case evidence…</p>}
    {transportError && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-300/20 bg-amber-200/[0.04] p-3 text-xs text-amber-100/80"><span>{transportError}</span><button type="button" onClick={() => void reload()} className="rounded border border-white/15 px-2.5 py-1.5 text-white/75 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300">Retry read</button></div>}

    {detail?.case.identity.status === "mismatch" && <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-rose-300/20 bg-rose-200/[0.04] p-3">
      <p role="alert" className="max-w-2xl text-xs leading-5 text-rose-100/80">SEC identity verification did not match the selected filing and listed ticker. Facts and decisions remain withheld. You can explicitly re-check the current SEC directory; the prior receipt will be retained.</p>
      <button type="button" onClick={() => void verifyIdentity()} disabled={verifying || loading} className="shrink-0 rounded-md border border-rose-200/25 px-3 py-2 text-xs text-rose-100/85 hover:bg-rose-200/[0.08] focus-visible:outline focus-visible:outline-2 focus-visible:outline-rose-200 disabled:cursor-wait disabled:opacity-45">{verifying ? "Checking SEC identity…" : "Re-check with SEC"}</button>
    </div>}
    {detail?.case.identity.status === "verified" && identityVerified && <p className="rounded border border-emerald-300/15 bg-emerald-200/[0.025] p-3 text-xs leading-5 text-emerald-100/70">Issuer identity verified against the SEC’s current ticker directory · received {detail.case.identity.receipt!.retrievedAt} · receipt SHA-256 {detail.case.identity.receipt!.sha256.slice(0, 12)}.</p>}
    {detail?.case.identity.status === "verified" && !identityVerified && <p role="alert" className="rounded border border-amber-300/20 bg-amber-200/[0.04] p-3 text-xs leading-5 text-amber-100/75">The saved SEC identity receipt is missing or does not match this case. Company facts and decisions are withheld.</p>}
    {detail?.case.identity.status === "unverified" && <div className="flex flex-wrap items-center justify-between gap-3 rounded border border-white/[0.08] p-3">
      <p className="max-w-2xl text-xs leading-5 text-white/55">Confirm this listed ticker against the SEC’s current issuer directory before loading company facts. This sends one bounded identity request to SEC only; it does not invoke Luna.</p>
      <button type="button" onClick={() => void verifyIdentity()} disabled={verifying || loading} className="shrink-0 rounded-md border border-emerald-300/25 px-3 py-2 text-xs text-emerald-100/80 hover:bg-emerald-300/[0.08] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:cursor-wait disabled:opacity-45">{verifying ? "Checking SEC identity…" : "Verify with SEC"}</button>
    </div>}

    <CompanyFundamentals
      companyName={subjectName}
      ticker={ticker}
      state={refreshing ? "refreshing" : fundamentals.state}
      facts={fundamentals.facts}
      comparisons={fundamentals.comparisons}
      points={fundamentals.points}
      coverage={fundamentals.coverage}
      refreshAllowed={fundamentals.refreshAllowed && identityVerified && !refreshing && !verifying}
      refreshBlockedReason={identityVerified ? fundamentals.refreshBlockedReason : "Verify the listed ticker and CIK with SEC first."}
      lastRefreshError={transportError ?? fundamentals.lastRefreshError}
      staleReason={fundamentals.staleReason}
      onRefresh={() => void refreshFacts()}
    />

    {briefResponse && <section className="grid min-w-0 gap-3 rounded-md border border-white/[0.08] p-3 sm:p-4" aria-labelledby={`sec-case-decision-${initialCase.id}`}>
      <div>
        <p className="micro">ANALYST DECISION · SAVED SEC EVIDENCE</p>
        <h3 id={`sec-case-decision-${initialCase.id}`} className="mt-1 text-sm font-medium text-white/80">Does this issuer merit more research?</h3>
        <p className="mt-1 text-xs leading-5 text-white/45">This is your disposition of the cited filings, not a model conclusion. Unavailable drivers remain unknown; reported-value changes do not establish cause or materiality.</p>
      </div>
      {briefResponse.brief.nextResearchQuestion && <p className="rounded bg-white/[0.025] p-3 text-xs leading-5 text-white/65"><span className="text-emerald-100/75">Next evidence question · </span>{briefResponse.brief.nextResearchQuestion.question}</p>}
      {briefResponse.brief.coverage.reasons.length > 0 && <div className="grid gap-1 text-xs leading-5 text-amber-100/65"><p>Evidence coverage notes</p><ul className="list-disc pl-5">{briefResponse.brief.coverage.reasons.map((reason, index) => <li key={`${index}:${reason}`}>{reason}</li>)}</ul></div>}
      {briefResponse.brief.facts.length === 0 && <p className="text-xs leading-5 text-white/50">No comparable SEC facts are available in this saved snapshot. You can record “Insufficient evidence” without treating the empty result as neutral or as proof of no change.</p>}
      <div className="grid min-w-0 gap-3 sm:grid-cols-2">
        <label className="grid gap-1 text-xs text-white/55" htmlFor={`sec-case-decision-select-${initialCase.id}`}>Disposition
          <select id={`sec-case-decision-select-${initialCase.id}`} value={decision} onChange={(event) => setDecision(event.currentTarget.value as CompanyResearchDecision)} className="rounded border border-white/10 bg-[#101218] px-2.5 py-2 text-sm text-white/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300">
            {DECISIONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-xs text-white/55" htmlFor={`sec-case-next-check-${initialCase.id}`}>Next check date (optional)
          <input id={`sec-case-next-check-${initialCase.id}`} type="date" value={nextCheckDate} onChange={(event) => setNextCheckDate(event.currentTarget.value)} className="rounded border border-white/10 bg-[#101218] px-2.5 py-2 text-sm text-white/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300" />
        </label>
      </div>
      <label className="grid gap-1 text-xs text-white/55" htmlFor={`sec-case-rationale-${initialCase.id}`}>Reasoning and unresolved uncertainty
        <textarea id={`sec-case-rationale-${initialCase.id}`} rows={3} maxLength={2000} value={rationale} onChange={(event) => setRationale(event.currentTarget.value)} className="w-full min-w-0 resize-y rounded border border-white/10 bg-black/25 px-2.5 py-2 text-sm text-white/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300" placeholder="What does the evidence support? What remains unknown?" />
      </label>
      <div className="flex min-w-0 flex-wrap items-center gap-3">
        <button type="button" onClick={() => void save()} disabled={!briefResponse.decisionStorageAvailable || saving} className="rounded-md border border-emerald-300/25 bg-emerald-300/[0.07] px-3 py-2 text-xs font-medium text-emerald-100/85 hover:bg-emerald-300/[0.12] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:cursor-not-allowed disabled:opacity-45">{saving ? "Saving decision…" : saved ? "Save new decision version" : "Save decision"}</button>
        {saved && <span className="text-[10px] text-white/40">Previous decision saved {savedAtLabel(saved.createdAt)} · {saved.factIds.length} facts</span>}
        {!briefResponse.decisionStorageAvailable && <span className="text-xs text-amber-100/70">Decision storage unavailable{briefResponse.decisionStorageUnavailableReason ? ` · ${briefResponse.decisionStorageUnavailableReason}` : ""}</span>}
        {saveMessage && <span role="status" className="text-xs text-white/55">{saveMessage}</span>}
      </div>
    </section>}
  </section>;
}
