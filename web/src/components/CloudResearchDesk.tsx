import { useEffect, useMemo, useRef, useState } from "react";
import { cloudSupabase } from "../lib/supabase.js";
import { readBoundedPages } from "../lib/bounded-pages.js";
import { CloudIssuerDirectory } from "./CloudIssuerDirectory.js";
import { CLOUD_COMPANY_UPDATE_CONCEPTS } from "../../../shared/cloud-company-updates.js";
import { canonicalSecFilingUrl, secFilingArchiveUrl } from "../../../shared/sec-filing-url.js";
import { CloudCompanyUpdates } from "./CloudCompanyUpdates.js";
import { CloudTradingViewChart } from "./CloudTradingViewChart.js";
import { CloudEvidenceAssessment } from "./CloudEvidenceAssessment.js";

type View = "discover" | "research" | "followed";
type Decision = "investigate_further" | "insufficient_evidence" | "set_aside";
interface DecisionDraft { decision: Decision; rationale: string; nextCheckDate: string; }
const EMPTY_DECISION_DRAFT: DecisionDraft = { decision: "investigate_further", rationale: "", nextCheckDate: "" };

interface Issuer {
  id: string; user_id: string; cik: string; ticker: string; issuer_name: string; exchange: string | null;
  selected_snapshot_id: string; created_at: string;
}
interface FactSnapshot { id: string; cik: string; retrieved_at: string; completed_at: string; fact_count: number; source_response_sha256: string; }
interface FilingSnapshot { id: string; cik: string; retrieved_at: string; completed_at: string; filing_count: number; source_response_sha256: string; }
interface Fact { id: string; cik: string; taxonomy: string; concept: string; unit: string; value_text: string; period_start: string | null; period_end: string; filed_at: string; form: string; accession: string; reported_decimals: string | null; }
interface Filing { id: string; cik: string; accession: string; form: string; filed_at: string; report_period: string | null; accepted_at: string | null; primary_document: string | null; source_url: string; retrieved_at: string; }
interface SavedDecision { id: string; decision: Decision; rationale: string; next_check_date: string | null; as_of: string; created_at: string; evidence_digest: string; companyfacts_snapshot_id: string; submissions_snapshot_id: string | null; evidence_fact_ids: string[]; evidence_filing_ids: string[]; }
interface SavedEvidence { facts: Fact[]; filings: Filing[]; }
interface Follow { id: string; cik: string; issuer_research_id: string; created_at: string; unfollowed_at: string | null; }
interface Baseline { id: string; follow_id: string; cik: string; snapshot_id: string; capture_key: string; version: number; captured_at: string; filing_count: number; evidence_digest: string; }
interface FollowChanges {
  snapshot_id: string | null; snapshot_retrieved_at: string | null; snapshot_completed_at: string | null;
  snapshot_filing_count: number | null; snapshot_source_response_sha256: string | null;
  baseline_id: string | null; baseline_snapshot_id: string | null; baseline_capture_key: string | null;
  baseline_version: number | null; baseline_captured_at: string | null; baseline_filing_count: number | null;
  baseline_evidence_digest: string | null; new_filing_count: number; omitted_filing_count: number; new_filings: Filing[];
}
interface FollowView { follow: Follow; issuer: Issuer | undefined; baseline: Baseline | null; baselineHistory: Baseline[]; currentSnapshot: FilingSnapshot | null; newFilings: Filing[]; newFilingCount: number; omittedFilingCount: number; currentFilingCount: number; state: string; }

function stamp(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "time unavailable";
  return `${new Date(value).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "")} UTC`;
}

function freshness(value: string | null | undefined): "current" | "stale" | "unavailable" {
  if (!value || !Number.isFinite(Date.parse(value))) return "unavailable";
  const age = Date.now() - Date.parse(value);
  return age >= 0 && age <= 24 * 60 * 60 * 1000 ? "current" : "stale";
}

function filingSourceUrl(filing: Filing): string | null {
  return canonicalSecFilingUrl(filing.source_url, filing.cik, filing.accession, filing.primary_document)
    ?? secFilingArchiveUrl(filing.cik, filing.accession);
}

function factSourceUrl(fact: Fact, filing: Filing | undefined): string | null {
  return (filing ? canonicalSecFilingUrl(filing.source_url, fact.cik, fact.accession, filing.primary_document) : null)
    ?? secFilingArchiveUrl(fact.cik, fact.accession);
}

const decisionLabel: Record<Decision, string> = {
  investigate_further: "Investigate further",
  insufficient_evidence: "Insufficient evidence",
  set_aside: "Set aside",
};

export function CloudResearchDesk({ userId }: { userId: string }) {
  const [view, setView] = useState<View>("discover");
  const [issuers, setIssuers] = useState<Issuer[]>([]);
  const [selectedCik, setSelectedCik] = useState("");
  const [loadingIssuers, setLoadingIssuers] = useState(true);
  const [loadingResearch, setLoadingResearch] = useState(false);
  const [factSnapshot, setFactSnapshot] = useState<FactSnapshot | null>(null);
  const [filingSnapshot, setFilingSnapshot] = useState<FilingSnapshot | null>(null);
  const [researchLoadedCik, setResearchLoadedCik] = useState("");
  const [facts, setFacts] = useState<Fact[]>([]);
  const [comparisonFacts, setComparisonFacts] = useState<Fact[]>([]);
  const [comparisonCoverageComplete, setComparisonCoverageComplete] = useState(true);
  const [filings, setFilings] = useState<Filing[]>([]);
  const [decisions, setDecisions] = useState<SavedDecision[]>([]);
  const [savedEvidence, setSavedEvidence] = useState<Record<string, SavedEvidence>>({});
  const [expandedDecisionId, setExpandedDecisionId] = useState<string | null>(null);
  const [loadingDecisionId, setLoadingDecisionId] = useState<string | null>(null);
  const [follows, setFollows] = useState<FollowView[]>([]);
  const [selectedFacts, setSelectedFacts] = useState<string[]>([]);
  const [selectedFilings, setSelectedFilings] = useState<string[]>([]);
  const [draftsByCik, setDraftsByCik] = useState<Record<string, DecisionDraft>>({});
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const researchLoadSequence = useRef(0);
  const automaticRefreshAttempted = useRef(new Set<string>());
  const selectedIssuer = issuers.find((issuer) => issuer.cik === selectedCik) ?? null;
  const activeDraft = draftsByCik[selectedCik] ?? EMPTY_DECISION_DRAFT;
  const updateActiveDraft = (changes: Partial<DecisionDraft>) => {
    if (!selectedCik) return;
    setDraftsByCik((current) => ({ ...current, [selectedCik]: { ...(current[selectedCik] ?? EMPTY_DECISION_DRAFT), ...changes } }));
  };
  const researchBelongsToSelection = Boolean(selectedCik && researchLoadedCik === selectedCik);
  const visibleFactSnapshot = researchBelongsToSelection && factSnapshot?.cik === selectedCik ? factSnapshot : null;
  const visibleFilingSnapshot = researchBelongsToSelection && filingSnapshot?.cik === selectedCik ? filingSnapshot : null;
  const visibleFacts = researchBelongsToSelection ? facts.filter((fact) => fact.cik === selectedCik) : [];
  const visibleComparisonFacts = researchBelongsToSelection ? comparisonFacts.filter((fact) => fact.cik === selectedCik) : [];
  const visibleFilings = researchBelongsToSelection ? filings.filter((filing) => filing.cik === selectedCik) : [];
  const visibleDecisions = researchBelongsToSelection ? decisions : [];
  const followedCiks = useMemo(() => new Set(follows.filter((row) => !row.follow.unfollowed_at).map((row) => row.follow.cik)), [follows]);
  const filingsByAccession = useMemo(() => new Map(visibleFilings.map((filing) => [filing.accession, filing])), [visibleFilings]);

  const reloadIssuers = async () => {
    if (!cloudSupabase) return [];
    const { data, error: readError } = await cloudSupabase.from("user_research_issuers")
      .select("id,user_id,cik,ticker,issuer_name,exchange,selected_snapshot_id,created_at")
      .order("created_at", { ascending: false }).limit(500);
    if (readError) throw readError;
    const rows = (data ?? []) as Issuer[];
    setIssuers(rows);
    setSelectedCik((current) => rows.some((row) => row.cik === current) ? current : rows[0]?.cik ?? "");
    return rows;
  };

  const reloadResearch = async (cik: string) => {
    const client = cloudSupabase;
    if (!client || !cik) {
      setFactSnapshot(null); setFilingSnapshot(null); setFacts([]); setComparisonFacts([]); setComparisonCoverageComplete(true); setFilings([]); setDecisions([]);
      setResearchLoadedCik(""); setLoadingResearch(false);
      return;
    }
    const requestSequence = ++researchLoadSequence.current;
    setLoadingResearch(true);
    try {
    const [factsHead, submissionsHead] = await Promise.all([
      client.from("sec_companyfacts_head").select("snapshot_id").eq("cik", cik).maybeSingle(),
      client.from("sec_submissions_head").select("snapshot_id").eq("cik", cik).maybeSingle(),
    ]);
    if (factsHead.error) throw factsHead.error;
    if (submissionsHead.error) throw submissionsHead.error;
    const [factsMeta, submissionsMeta] = await Promise.all([
      factsHead.data ? client.from("sec_companyfacts_snapshots").select("id,cik,retrieved_at,completed_at,fact_count,source_response_sha256").eq("id", factsHead.data.snapshot_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
      submissionsHead.data ? client.from("sec_submissions_snapshots").select("id,cik,retrieved_at,completed_at,filing_count,source_response_sha256").eq("id", submissionsHead.data.snapshot_id).maybeSingle() : Promise.resolve({ data: null, error: null }),
    ]);
    if (factsMeta.error) throw factsMeta.error;
    if (submissionsMeta.error) throw submissionsMeta.error;
    if (requestSequence !== researchLoadSequence.current) return;
    const nextFactSnapshot = (factsMeta.data ?? null) as FactSnapshot | null;
    const nextFilingSnapshot = (submissionsMeta.data ?? null) as FilingSnapshot | null;
    setFactSnapshot(nextFactSnapshot);
    setFilingSnapshot(nextFilingSnapshot);
    const [factRows, filingRows, decisionRows, comparisonRows] = await Promise.all([
      nextFactSnapshot ? client.from("sec_company_fact_values")
        .select("id,cik,taxonomy,concept,unit,value_text,period_start,period_end,filed_at,form,accession,reported_decimals")
        .eq("snapshot_id", nextFactSnapshot.id).eq("cik", cik).order("period_end", { ascending: false }).limit(200)
        : Promise.resolve({ data: [], error: null }),
      nextFilingSnapshot ? client.from("sec_filing_observations")
        .select("id,cik,accession,form,filed_at,report_period,accepted_at,primary_document,source_url,retrieved_at")
        .eq("snapshot_id", nextFilingSnapshot.id).eq("cik", cik).order("filed_at", { ascending: false }).limit(1000)
        : Promise.resolve({ data: [], error: null }),
      client.from("user_company_research_decisions")
        .select("id,decision,rationale,next_check_date,as_of,created_at,evidence_digest,companyfacts_snapshot_id,submissions_snapshot_id,evidence_fact_ids,evidence_filing_ids")
        .eq("cik", cik).order("created_at", { ascending: false }).limit(20),
      nextFactSnapshot ? readBoundedPages<Fact>(async (offset, limit) => {
        const result = await client.from("sec_company_fact_values")
          .select("id,cik,taxonomy,concept,unit,value_text,period_start,period_end,filed_at,form,accession,reported_decimals")
          .eq("snapshot_id", nextFactSnapshot.id).eq("cik", cik).in("concept", CLOUD_COMPANY_UPDATE_CONCEPTS)
          .order("period_end", { ascending: false }).order("filed_at", { ascending: false }).order("id", { ascending: true })
          .range(offset, offset + limit - 1);
        return { data: result.data as Fact[] | null, error: result.error };
      }, 1000, 10000) : Promise.resolve({ rows: [], complete: true }),
    ]);
    if (factRows.error) throw factRows.error;
    if (filingRows.error) throw filingRows.error;
    if (decisionRows.error) throw decisionRows.error;
    if (requestSequence !== researchLoadSequence.current) return;
    setFacts((factRows.data ?? []) as Fact[]);
    setComparisonFacts(comparisonRows.rows);
    setComparisonCoverageComplete(comparisonRows.complete);
    setFilings((filingRows.data ?? []) as Filing[]);
    setDecisions((decisionRows.data ?? []) as SavedDecision[]);
    setSelectedFacts([]); setSelectedFilings([]);
    setResearchLoadedCik(cik);
    } finally {
      if (requestSequence === researchLoadSequence.current) setLoadingResearch(false);
    }
  };

  const reloadFollowed = async (issuerRows: Issuer[] = issuers) => {
    const client = cloudSupabase;
    if (!client) return;
    const { data: followRows, error: followError } = await client.from("user_company_follows")
      .select("id,cik,issuer_research_id,created_at,unfollowed_at").order("created_at", { ascending: false }).limit(500);
    if (followError) throw followError;
    const result = await Promise.all(((followRows ?? []) as Follow[]).map(async (follow) => {
      const { data: baselineRows, error: baselineError } = await client.from("user_followed_evidence_baselines")
        .select("id,follow_id,cik,snapshot_id,capture_key,version,captured_at,filing_count,evidence_digest")
        .eq("follow_id", follow.id).order("version", { ascending: false }).limit(100);
      if (baselineError) throw baselineError;
      const baselineHistory = (baselineRows ?? []) as Baseline[];
      if (follow.unfollowed_at) return { follow, issuer: issuerRows.find((row) => row.id === follow.issuer_research_id),
        baseline: baselineHistory[0] ?? null, baselineHistory, currentSnapshot: null, newFilings: [], newFilingCount: 0,
        omittedFilingCount: 0, currentFilingCount: 0, state: "archived · baselines retained" } satisfies FollowView;
      const { data: changeRows, error: currentError } = await client.rpc("read_user_followed_filing_changes", { p_follow_id: follow.id });
      if (currentError) throw currentError;
      const current = ((changeRows ?? []) as FollowChanges[])[0];
      if (!current || !current.snapshot_id) return { follow, issuer: issuerRows.find((row) => row.id === follow.issuer_research_id),
        baseline: baselineHistory[0] ?? null, baselineHistory, currentSnapshot: null, newFilings: [], newFilingCount: 0,
        omittedFilingCount: 0, currentFilingCount: 0, state: "filing source unavailable" } satisfies FollowView;
      const currentSnapshot: FilingSnapshot = { id: current.snapshot_id, cik: follow.cik,
        retrieved_at: current.snapshot_retrieved_at ?? "", completed_at: current.snapshot_completed_at ?? "",
        filing_count: current.snapshot_filing_count ?? 0, source_response_sha256: current.snapshot_source_response_sha256 ?? "" };
      const baseline = current.baseline_id ? { id: current.baseline_id, follow_id: follow.id, cik: follow.cik,
        snapshot_id: current.baseline_snapshot_id ?? "", capture_key: current.baseline_capture_key ?? "",
        version: current.baseline_version ?? 0, captured_at: current.baseline_captured_at ?? "",
        filing_count: current.baseline_filing_count ?? 0, evidence_digest: current.baseline_evidence_digest ?? "" } satisfies Baseline : null;
      const newFilings = current.new_filings ?? [];
      const sourceFreshness = freshness(currentSnapshot.retrieved_at);
      const changeState = !baseline ? "baseline not captured"
        : current.new_filing_count > 0 ? "new filings since baseline" : "no new filings in the latest update";
      return { follow, issuer: issuerRows.find((row) => row.id === follow.issuer_research_id), baseline, baselineHistory,
        currentSnapshot, newFilings, newFilingCount: current.new_filing_count, omittedFilingCount: current.omitted_filing_count,
        currentFilingCount: currentSnapshot.filing_count,
        state: sourceFreshness === "stale" ? `may be out of date · ${changeState}` : changeState } satisfies FollowView;
    }));
    setFollows(result);
  };

  useEffect(() => {
    if (!cloudSupabase) return;
    let active = true;
    setLoadingIssuers(true);
    void reloadIssuers().then((rows) => reloadFollowed(rows)).then(() => {
      if (active) setError(null);
    }).catch(() => { if (active) setError("Your research list could not be loaded. Try again."); })
      .finally(() => { if (active) setLoadingIssuers(false); });
    return () => { active = false; };
  }, [userId]);

  useEffect(() => {
    let active = true;
    researchLoadSequence.current += 1;
    setFactSnapshot(null); setFilingSnapshot(null); setFacts([]); setComparisonFacts([]); setComparisonCoverageComplete(true); setFilings([]); setDecisions([]); setResearchLoadedCik("");
    void reloadResearch(selectedCik).then(() => { if (active) setError(null); })
      .catch(() => { if (active) setError("Company financials, filings, or saved decisions could not be loaded. Try again."); })
      .finally(() => { if (active) setLoadingResearch(false); });
    return () => { active = false; researchLoadSequence.current += 1; };
  }, [selectedCik, userId]);

  const retryReads = async () => {
    setError(null); setNotice(null);
    try { await reloadIssuers(); await reloadResearch(selectedCik); await reloadFollowed(); }
    catch { setError("Your saved research is temporarily unavailable. Your decisions have not changed."); }
  };

  const refreshEvidence = async (cik: string) => {
    if (!cloudSupabase || working) return;
    setWorking(`refresh:${cik}`); setNotice(null); setError(null);
    try {
      const { data, error: invokeError } = await cloudSupabase.functions.invoke("refresh-sec-company-evidence", {
        body: { cik, requestKey: crypto.randomUUID() },
      });
      if (invokeError) {
        setError("Company information could not be updated. Previously saved information is unchanged.");
      } else if (data?.state === "partial") {
        setError("Some company information was updated, but the rest was unavailable. Previously saved information remains available with its own update time.");
      } else if (data?.state === "failed") {
        setError("Company information could not be updated. Previously saved information is unchanged.");
      } else setNotice(data?.state === "current" ? "Company information is up to date." : "Company information was updated.");
      try {
        if (cik === selectedCik) await reloadResearch(cik);
        await reloadFollowed();
      }
      catch { setError("The update finished, but saved company information could not be read back."); }
    } catch {
      setError("Company information could not be updated. Previously saved information is unchanged.");
    } finally {
      setWorking(null);
    }
  };

  useEffect(() => {
    if (view !== "research" || !selectedCik || researchLoadedCik !== selectedCik || loadingResearch || working != null) return;
    const isStale = freshness(factSnapshot?.retrieved_at) !== "current" || freshness(filingSnapshot?.retrieved_at) !== "current";
    const attemptKey = `${userId}:${selectedCik}`;
    if (!isStale || automaticRefreshAttempted.current.has(attemptKey)) return;
    automaticRefreshAttempted.current.add(attemptKey);
    void refreshEvidence(selectedCik);
  }, [view, selectedCik, researchLoadedCik, loadingResearch, working, factSnapshot?.retrieved_at, filingSnapshot?.retrieved_at, userId]);

  const saveDecision = async () => {
    if (!cloudSupabase || !selectedIssuer || !visibleFactSnapshot || working) return;
    if (activeDraft.rationale.trim().length < 3 || activeDraft.rationale.length > 2000 || selectedFacts.length > 100 || selectedFilings.length > 100) {
      setError("Add a short rationale and choose no more than 100 facts and 100 filings."); return;
    }
    setWorking("decision"); setError(null); setNotice(null);
    const { error: writeError } = await cloudSupabase.from("user_company_research_decisions").insert({
      user_id: userId, cik: selectedIssuer.cik, issuer_research_id: selectedIssuer.id,
      companyfacts_snapshot_id: visibleFactSnapshot.id, submissions_snapshot_id: visibleFilingSnapshot?.id ?? null,
      decision: activeDraft.decision, rationale: activeDraft.rationale.trim(), next_check_date: activeDraft.nextCheckDate || null,
      evidence_fact_ids: selectedFacts, evidence_filing_ids: selectedFilings,
      as_of: visibleFactSnapshot.completed_at,
    });
    if (writeError) setError("These sources could not be matched to the selected company. No decision was saved.");
    else {
      setDraftsByCik((current) => { const next = { ...current }; delete next[selectedIssuer.cik]; return next; });
      setSelectedFacts([]); setSelectedFilings([]); setNotice("Your decision was saved with the selected SEC evidence.");
    }
    try { await reloadResearch(selectedIssuer.cik); } catch { setError("The decision returned, but the saved decision list could not be read back."); }
    setWorking(null);
  };

  const toggleSavedEvidence = async (item: SavedDecision) => {
    if (expandedDecisionId === item.id) { setExpandedDecisionId(null); return; }
    if (savedEvidence[item.id]) { setExpandedDecisionId(item.id); return; }
    if (!cloudSupabase || loadingDecisionId) return;
    setLoadingDecisionId(item.id);
    try {
      const [factResult, selectedFilingResult] = await Promise.all([
        item.evidence_fact_ids.length ? cloudSupabase.from("sec_company_fact_values")
          .select("id,cik,taxonomy,concept,unit,value_text,period_start,period_end,filed_at,form,accession,reported_decimals")
          .eq("cik", selectedCik).eq("snapshot_id", item.companyfacts_snapshot_id).in("id", item.evidence_fact_ids)
          : Promise.resolve({ data: [], error: null }),
        item.submissions_snapshot_id && item.evidence_filing_ids.length ? cloudSupabase.from("sec_filing_observations")
          .select("id,cik,accession,form,filed_at,report_period,accepted_at,primary_document,source_url,retrieved_at")
          .eq("cik", selectedCik).eq("snapshot_id", item.submissions_snapshot_id).in("id", item.evidence_filing_ids)
          : Promise.resolve({ data: [], error: null }),
      ]);
      if (factResult.error) throw factResult.error;
      if (selectedFilingResult.error) throw selectedFilingResult.error;
      const facts = (factResult.data ?? []) as Fact[];
      const selectedFilings = (selectedFilingResult.data ?? []) as Filing[];
      if (facts.length !== item.evidence_fact_ids.length || selectedFilings.length !== item.evidence_filing_ids.length) {
        throw new Error("saved_decision_evidence_unavailable");
      }
      const factAccessions = [...new Set(facts.map((fact) => fact.accession))];
      const sourceFilingResult = item.submissions_snapshot_id && factAccessions.length ? await cloudSupabase.from("sec_filing_observations")
        .select("id,cik,accession,form,filed_at,report_period,accepted_at,primary_document,source_url,retrieved_at")
        .eq("cik", selectedCik).eq("snapshot_id", item.submissions_snapshot_id).in("accession", factAccessions)
        : { data: [], error: null };
      if (sourceFilingResult.error) throw sourceFilingResult.error;
      const filingsById = new Map<string, Filing>();
      for (const filing of [...selectedFilings, ...((sourceFilingResult.data ?? []) as Filing[])]) filingsById.set(filing.id, filing);
      setSavedEvidence((current) => ({ ...current, [item.id]: { facts, filings: [...filingsById.values()] } }));
      setExpandedDecisionId(item.id);
    } catch {
      setError("The sources saved with this decision could not be read back. Your saved decision is unchanged.");
    } finally {
      setLoadingDecisionId(null);
    }
  };

  const followIssuer = async () => {
    if (!cloudSupabase || !selectedIssuer || working) return;
    setWorking(`follow:${selectedIssuer.cik}`); setError(null); setNotice(null);
    const { data, error: followError } = await cloudSupabase.from("user_company_follows")
      .insert({ user_id: userId, cik: selectedIssuer.cik, issuer_research_id: selectedIssuer.id })
      .select("id,cik,issuer_research_id,created_at").maybeSingle();
    if (followError || !data) {
      setError(followError?.code === "23505" ? "This CIK is already followed." : "The follow could not be saved to your account.");
    } else if (visibleFilingSnapshot) {
      const { error: baselineError } = await cloudSupabase.rpc("capture_user_followed_evidence_baseline", {
        p_follow_id: data.id, p_capture_key: crypto.randomUUID(), p_expected_previous_baseline_id: null,
      });
      if (baselineError) {
        setError("Company followed, but its initial filing baseline could not be saved. Your follow is active; open Followed evidence and choose ‘Use current filings as baseline’ to retry.");
      } else setNotice("Company followed with the current SEC filing list as its initial baseline.");
    } else setNotice("Company followed. Set its first filing baseline when recent SEC filings are available.");
    try { await reloadFollowed(); } catch { setError("The follow was saved, but the followed-company view could not be read back."); }
    setWorking(null);
  };

  const captureBaseline = async (row: FollowView) => {
    if (!cloudSupabase || working || !row.currentSnapshot) return;
    setWorking(`baseline:${row.follow.id}`); setNotice(null); setError(null);
    const { error: captureError } = await cloudSupabase.rpc("capture_user_followed_evidence_baseline", {
      p_follow_id: row.follow.id, p_capture_key: crypto.randomUUID(),
      p_expected_previous_baseline_id: row.baseline?.id ?? null,
    });
    if (captureError?.code === "40001") setError("Another baseline was saved first. Reload the followed-company state before capturing again.");
    else if (captureError) setError("The current filing list could not be saved as a new baseline.");
    else setNotice("A new comparison point was saved for the current SEC filings.");
    try { await reloadFollowed(); } catch { setError("The baseline was saved, but its current state could not be read back."); }
    setWorking(null);
  };

  const unfollow = async (row: FollowView) => {
    if (!cloudSupabase || working) return;
    const confirmed = window.confirm("Remove this company from your active followed list? Previously saved filing baselines will remain in your account.");
    if (!confirmed) return;
    setWorking(`unfollow:${row.follow.id}`); setError(null); setNotice(null);
    const { data, error: unfollowError } = await cloudSupabase.rpc("unfollow_user_company_follow", { p_follow_id: row.follow.id });
    if (unfollowError || !data) setError("Unfollow could not be completed.");
    else setNotice("The company was removed from your active followed list. Its saved baselines remain in your account.");
    try { await reloadFollowed(); } catch { setError("Followed-company state could not be read back."); }
    setWorking(null);
  };

  const refollow = async (row: FollowView) => {
    if (!cloudSupabase || working || followedCiks.has(row.follow.cik)) return;
    setWorking(`refollow:${row.follow.id}`); setError(null); setNotice(null);
    const { error: followError } = await cloudSupabase.from("user_company_follows")
      .insert({ user_id: userId, cik: row.follow.cik, issuer_research_id: row.follow.issuer_research_id });
    if (followError) setError("Follow could not be restored. Reload the followed-company state and try again.");
    else setNotice("A new active follow was created. The archived follow and its baselines remain available below.");
    try { await reloadFollowed(); } catch { setError("Followed-company state could not be read back."); }
    setWorking(null);
  };

  const toggleEvidence = (id: string, selected: string[], setter: (value: string[]) => void) => {
    setter(selected.includes(id) ? selected.filter((item) => item !== id) : selected.length < 100 ? [...selected, id] : selected);
  };

  return <div className="mx-auto w-full max-w-6xl space-y-4 pb-8 pt-5">
    <nav className="panel flex flex-wrap items-center gap-2 px-3 py-2" aria-label="Core research workflows">
      {(["discover", "research", "followed"] as View[]).map((item) => <button key={item} type="button" onClick={() => setView(item)} aria-current={view === item ? "page" : undefined}
        className={`rounded px-3 py-2 text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 ${view === item ? "bg-emerald-300/10 text-emerald-100" : "text-white/55 hover:bg-white/[0.04]"}`}>
        {item === "discover" ? "Discover" : item === "research" ? "Company research" : `Followed evidence${follows.length ? ` · ${follows.length}` : ""}`}
      </button>)}
      <span className="ml-auto text-[10px] text-white/35">Your saved research</span>
    </nav>

    {error && <div className="panel flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-xs text-amber-100/75" role="alert"><span>{error}</span><button type="button" onClick={() => void retryReads()} className="rounded border border-white/15 px-2.5 py-1.5 text-[10px]">Retry saved reads</button></div>}
    {notice && <p className="panel px-3 py-2 text-xs text-emerald-100/75" role="status">{notice}</p>}

    {view === "discover" ? <CloudIssuerDirectory userId={userId} onWorkspaceChanged={async (issuer) => {
      const rows = await reloadIssuers();
      await reloadFollowed(rows);
      if (issuer) { setSelectedCik(issuer.cik); setView("research"); }
    }} /> : null}

    {view === "research" ? <>
      <section className="panel flex flex-wrap items-end justify-between gap-3 p-4">
        <div className="min-w-[min(100%,20rem)] flex-1">
          <p className="micro">CIK-SCOPED COMPANY RESEARCH</p>
          <label className="mt-2 block text-[11px] text-white/50">My saved issuers
            <select value={selectedCik} onChange={(event) => setSelectedCik(event.target.value)} disabled={issuers.length === 0}
              className="mt-1.5 w-full rounded border border-white/10 bg-[#101113] px-3 py-2 text-xs text-white/80 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300">
              {issuers.length === 0 ? <option value="">No saved issuer yet</option> : issuers.map((issuer) => <option key={issuer.id} value={issuer.cik}>{issuer.issuer_name} · {issuer.ticker} · CIK {issuer.cik}</option>)}
            </select>
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          {selectedIssuer && <button type="button" disabled={working != null} onClick={() => void refreshEvidence(selectedIssuer.cik)} className="rounded border border-white/15 px-3 py-2 text-[10px] text-white/70 hover:bg-white/[0.05] disabled:opacity-45">{working === `refresh:${selectedIssuer.cik}` ? "Updating company information…" : "Refresh company information"}</button>}
          {selectedIssuer && <button type="button" disabled={working != null || followedCiks.has(selectedIssuer.cik)} onClick={() => void followIssuer()} className="rounded border border-emerald-300/25 bg-emerald-300/[0.08] px-3 py-2 text-[10px] text-emerald-100/80 disabled:opacity-45">{followedCiks.has(selectedIssuer.cik) ? "Following" : "Follow this company"}</button>}
        </div>
      </section>
      {!selectedIssuer ? <section className="panel p-5 text-xs leading-5 text-white/50">Add an issuer from Discover before opening source-backed company research.</section> : <>
        <section className="panel p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><p className="micro">SEC COMPANY RECORD</p><h2 className="mt-1 text-sm font-semibold text-white/80">{selectedIssuer.issuer_name} <span className="font-mono text-white/40">{selectedIssuer.ticker}</span></h2><p className="mt-1 font-mono text-[10px] text-white/40">CIK {selectedIssuer.cik} · matched to the SEC issuer record</p></div>
            <p className="max-w-2xl text-[10px] leading-4 text-white/40">This view includes a limited set of reported SEC financial measures. It does not cover every business driver or establish quality, materiality, sentiment, or investment merit.</p>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <div className="rounded border border-white/[0.08] p-3"><p className="micro">REPORTED FINANCIALS · {freshness(visibleFactSnapshot?.retrieved_at).toUpperCase()}</p><p className="mt-1 text-[11px] text-white/65">{visibleFactSnapshot ? `${visibleFactSnapshot.fact_count.toLocaleString()} reported values` : loadingResearch && !researchBelongsToSelection ? "Loading company financials" : "No current SEC financial data is available"}</p><p className="mt-1 text-[10px] text-white/40">Retrieved {stamp(visibleFactSnapshot?.retrieved_at)}</p></div>
            <div className="rounded border border-white/[0.08] p-3"><p className="micro">SEC FILINGS · {freshness(visibleFilingSnapshot?.retrieved_at).toUpperCase()}</p><p className="mt-1 text-[11px] text-white/65">{visibleFilingSnapshot ? `${visibleFilingSnapshot.filing_count.toLocaleString()} recent SEC filings` : loadingResearch && !researchBelongsToSelection ? "Loading company filings" : "No recent SEC filings are available"}</p><p className="mt-1 text-[10px] text-white/40">Retrieved {stamp(visibleFilingSnapshot?.retrieved_at)}</p></div>
          </div>
          {!visibleFactSnapshot || !visibleFilingSnapshot ? <p className="mt-3 text-[10px] leading-4 text-amber-100/60">Some recent company information is unavailable. Try again later; previously saved research remains available.</p> : null}
        </section>

        <CloudTradingViewChart ticker={selectedIssuer.ticker} exchange={selectedIssuer.exchange} companyName={selectedIssuer.issuer_name} />

        <CloudCompanyUpdates cik={selectedIssuer.cik} facts={visibleComparisonFacts} filings={visibleFilings} retrievedAt={visibleFactSnapshot?.retrieved_at} coverageComplete={comparisonCoverageComplete} />

        <section className="panel" aria-labelledby="company-facts-heading">
          <div className="panel-head"><h2 id="company-facts-heading" className="micro m-0 p-0">REPORTED FACTS · LATEST 200</h2><span className="text-[10px] text-white/40">{loadingResearch && !researchBelongsToSelection ? "loading selected CIK" : `${visibleFacts.length} shown`}</span></div>
          {visibleFacts.length === 0 ? <p className="p-4 text-xs text-white/45">{loadingResearch && !researchBelongsToSelection ? "Loading reported facts…" : "No supported revenue, operating income, net income, or operating cash flow fact is available in the latest SEC financial data."}</p> : <ul className="divide-y divide-white/[0.06]">{visibleFacts.map((fact) => {
            const sourceFiling = filingsByAccession.get(fact.accession);
            return <li key={fact.id} className="flex flex-wrap items-start gap-2 px-3 py-2.5 sm:px-4">
              <input type="checkbox" aria-label={`Select ${fact.concept} for research decision`} checked={selectedFacts.includes(fact.id)} onChange={() => toggleEvidence(fact.id, selectedFacts, setSelectedFacts)} className="mt-0.5 accent-emerald-300" />
              <div className="min-w-0 flex-1"><p className="font-mono text-[11px] text-white/75">{fact.concept} <span className="text-white/40">{fact.value_text} {fact.unit}</span></p><p className="mt-1 text-[10px] text-white/40">{fact.form} · period {fact.period_start ? `${fact.period_start} — ` : "instant "}{fact.period_end} · filed {fact.filed_at} · accession {fact.accession}</p>{factSourceUrl(fact, sourceFiling) ? <a href={factSourceUrl(fact, sourceFiling)!} target="_blank" rel="noreferrer" className="mt-1 inline-block text-[10px] text-emerald-100/60 underline decoration-white/20 underline-offset-2">Open SEC filing record</a> : <p className="mt-1 text-[10px] text-white/35">Source filing link unavailable.</p>}</div>
              <span className="text-[9px] text-white/30">{fact.taxonomy} · {stamp(visibleFactSnapshot?.retrieved_at)}</span>
            </li>;
          })}</ul>}
        </section>

        <section className="panel" aria-labelledby="company-filings-heading">
          <div className="panel-head"><h2 id="company-filings-heading" className="micro m-0 p-0">RECENT FILINGS · LATEST 50</h2><span className="text-[10px] text-white/40">{visibleFilings.length} available</span></div>
          {visibleFilings.slice(0, 50).map((filing) => <label key={filing.id} className="flex cursor-pointer items-start gap-2 border-t border-white/[0.05] px-3 py-2.5 text-[10px] sm:px-4">
            <input type="checkbox" checked={selectedFilings.includes(filing.id)} onChange={() => toggleEvidence(filing.id, selectedFilings, setSelectedFilings)} className="mt-0.5 accent-emerald-300" />
            <span className="min-w-0 flex-1">{filingSourceUrl(filing) ? <a href={filingSourceUrl(filing)!} target="_blank" rel="noreferrer" className="text-emerald-100/65 underline decoration-white/20 underline-offset-2">{filing.form} · filed {filing.filed_at}</a> : <span>{filing.form} · filed {filing.filed_at} · source link unavailable</span>}<span className="ml-2 font-mono text-white/35">{filing.accession}</span><span className="block mt-1 text-white/35">Report period {filing.report_period ?? "not supplied"} · retrieved {stamp(filing.retrieved_at)}</span></span>
          </label>)}
          {visibleFilings.length === 0 && <p className="p-4 text-xs text-white/40">{loadingResearch && !researchBelongsToSelection ? "Loading company filings…" : "No recent SEC filings are available for this company."}</p>}
        </section>

        <CloudEvidenceAssessment
          key={`${userId}:${selectedIssuer.cik}`}
          userId={userId}
          cik={selectedIssuer.cik}
          ticker={selectedIssuer.ticker}
          companyName={selectedIssuer.issuer_name}
          factSnapshotId={visibleFactSnapshot?.id ?? null}
          filingSnapshotId={visibleFilingSnapshot?.id ?? null}
          facts={visibleFacts}
          filings={visibleFilings}
          selectedFactIds={selectedFacts}
          selectedFilingIds={selectedFilings}
        />

        <section className="panel p-4" aria-labelledby="save-research-decision-heading">
          <p className="micro">ANALYST-OWNED DECISION</p><h2 id="save-research-decision-heading" className="mt-1 text-sm font-semibold text-white/80">Save your next research step</h2>
          <p className="mt-1 text-[10px] leading-4 text-white/40">The choice and rationale are yours. A saved decision keeps the selected evidence and its SEC filing dates together; no automatic recommendation is generated.</p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-[10px] text-white/50">Decision<select value={activeDraft.decision} onChange={(event) => updateActiveDraft({ decision: event.target.value as Decision })} className="mt-1 block w-full rounded border border-white/10 bg-[#101113] px-2.5 py-2 text-xs text-white/80">{Object.entries(decisionLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
            <label className="text-[10px] text-white/50">Next check date (optional)<input type="date" value={activeDraft.nextCheckDate} onChange={(event) => updateActiveDraft({ nextCheckDate: event.target.value })} className="mt-1 block w-full rounded border border-white/10 bg-[#101113] px-2.5 py-2 text-xs text-white/80" /></label>
          </div>
          <label className="mt-3 block text-[10px] text-white/50">Your rationale<textarea value={activeDraft.rationale} maxLength={2000} rows={3} onChange={(event) => updateActiveDraft({ rationale: event.target.value })} placeholder="What evidence would change your view, and what remains unresolved?" className="mt-1 block w-full resize-y rounded border border-white/10 bg-black/20 px-3 py-2 text-xs text-white/80 outline-none focus-visible:border-emerald-300/50" /></label>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2"><span className="text-[10px] text-white/35">Selected evidence: {selectedFacts.length} facts · {selectedFilings.length} filings</span><button type="button" disabled={working != null || !visibleFactSnapshot || activeDraft.rationale.trim().length < 3} onClick={() => void saveDecision()} className="rounded border border-emerald-300/25 bg-emerald-300/[0.08] px-3 py-2 text-[10px] text-emerald-100/80 disabled:opacity-40">{working === "decision" ? "Saving decision…" : "Save research decision"}</button></div>
          {visibleDecisions.length > 0 && <div className="mt-4 border-t border-white/[0.07] pt-3"><p className="micro">YOUR LAST SAVED DECISIONS</p><ul className="mt-2 space-y-2">{visibleDecisions.map((item) => {
            const evidence = savedEvidence[item.id];
            const evidenceFilingsByAccession = new Map((evidence?.filings ?? []).map((filing) => [filing.accession, filing]));
            return <li key={item.id} className="rounded border border-white/[0.07] p-2.5">
              <div className="flex flex-wrap justify-between gap-2"><span className="text-[11px] text-white/70">{decisionLabel[item.decision]}</span><span className="font-mono text-[9px] text-white/35">as of {stamp(item.as_of)}</span></div>
              <p className="mt-1 text-[10px] leading-4 text-white/50">{item.rationale}</p>
              <p className="mt-1 font-mono text-[9px] text-white/35">{item.evidence_fact_ids.length} facts · {item.evidence_filing_ids.length} filings{item.next_check_date ? ` · next check ${item.next_check_date}` : ""}</p>
              <button type="button" disabled={loadingDecisionId != null} onClick={() => void toggleSavedEvidence(item)} className="mt-2 rounded border border-white/10 px-2.5 py-1.5 text-[10px] text-white/65 disabled:opacity-45">
                {loadingDecisionId === item.id ? "Loading saved sources…" : expandedDecisionId === item.id ? "Hide saved evidence" : "Review saved evidence"}
              </button>
              {expandedDecisionId === item.id && evidence && <div className="mt-3 space-y-3 border-t border-white/[0.07] pt-3">
                {evidence.facts.length > 0 && <ul className="space-y-2">{evidence.facts.map((fact) => {
                  const sourceFiling = evidenceFilingsByAccession.get(fact.accession);
                  const sourceUrl = factSourceUrl(fact, sourceFiling);
                  return <li key={fact.id} className="text-[10px] text-white/55">
                    <p className="font-mono text-white/70">{fact.concept} · {fact.value_text} {fact.unit}</p>
                    <p className="mt-1">{fact.form} · period {fact.period_start ? `${fact.period_start} to ` : "instant "}{fact.period_end} · filed {fact.filed_at} · accession {fact.accession}</p>
                    {sourceUrl && <a href={sourceUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block text-emerald-100/65 underline underline-offset-2">Open saved SEC filing</a>}
                  </li>;
                })}</ul>}
                {evidence.filings.filter((filing) => item.evidence_filing_ids.includes(filing.id)).map((filing) => <p key={filing.id} className="text-[10px] text-white/55">{filingSourceUrl(filing) ? <a href={filingSourceUrl(filing)!} target="_blank" rel="noreferrer" className="text-emerald-100/65 underline underline-offset-2">{filing.form} · filed {filing.filed_at}</a> : `${filing.form} · filed ${filing.filed_at} · source link unavailable`}<span className="ml-2 font-mono text-white/35">{filing.accession}</span></p>)}
                {evidence.facts.length === 0 && item.evidence_filing_ids.length === 0 && <p className="text-[10px] text-white/45">No SEC source rows were attached to this decision.</p>}
                <p className="text-[9px] text-white/35">These are the saved rows from the original source snapshots, not the latest company data.</p>
              </div>}
            </li>;
          })}</ul></div>}
        </section>
      </>}
    </> : null}

    {view === "followed" ? <section className="space-y-3" aria-labelledby="followed-evidence-heading">
      <header className="panel p-4"><p className="micro">FOLLOWED-COMPANY UPDATES</p><h1 id="followed-evidence-heading" className="mt-1 text-sm font-semibold text-white/80">Recent SEC filings for companies you follow</h1><p className="mt-1 max-w-3xl text-[10px] leading-4 text-white/45">New filings are compared with the list you saved as your baseline. This shows filing activity; it does not judge materiality or investment impact.</p></header>
      {follows.length === 0 ? <div className="panel p-4 text-xs text-white/45">You are not following any companies yet. Open Company research to follow one.</div> : follows.map((row) => <article key={row.follow.id} className="panel space-y-3 p-4">
        {row.follow.unfollowed_at ? <>
          <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="micro">NO LONGER FOLLOWED · HISTORY SAVED</p><h2 className="mt-1 text-sm font-semibold text-white/80">{row.issuer?.issuer_name ?? "Saved company"} <span className="font-mono text-white/40">{row.issuer?.ticker ?? ""}</span></h2><p className="mt-1 font-mono text-[10px] text-white/40">CIK {row.follow.cik} · unfollowed {stamp(row.follow.unfollowed_at)}</p><p className="mt-1 text-[10px] text-white/40">{row.baselineHistory.length} saved baseline{row.baselineHistory.length === 1 ? "" : "s"}</p></div>
            <button type="button" disabled={working != null || followedCiks.has(row.follow.cik)} onClick={() => void refollow(row)} className="rounded border border-emerald-300/25 px-3 py-2 text-[10px] text-white/70 disabled:opacity-40">{followedCiks.has(row.follow.cik) ? "Already followed" : working === `refollow:${row.follow.id}` ? "Following…" : "Follow again"}</button></div>
          {row.baselineHistory.length ? <ul className="space-y-1.5">{row.baselineHistory.map((baseline) => <li key={baseline.id} className="rounded border border-white/[0.07] px-3 py-2"><p className="text-[10px] text-white/65">Baseline {baseline.version} · captured {stamp(baseline.captured_at)} · {baseline.filing_count} filings</p></li>)}</ul> : <p className="text-[10px] text-white/40">No baseline was saved before this company was unfollowed.</p>}
        </> : <>
        <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="micro">{row.state.toUpperCase()}</p><h2 className="mt-1 text-sm font-semibold text-white/80">{row.issuer?.issuer_name ?? "Saved company"} <span className="font-mono text-white/40">{row.issuer?.ticker ?? ""}</span></h2><p className="mt-1 font-mono text-[10px] text-white/40">CIK {row.follow.cik} · filings last retrieved {stamp(row.currentSnapshot?.retrieved_at)}</p><p className="mt-1 text-[10px] text-white/40">Baseline {row.baseline ? `v${row.baseline.version} captured ${stamp(row.baseline.captured_at)} · ${row.baseline.filing_count} filings` : "not yet saved"} · ${row.currentFilingCount} filings available now</p></div>
          <div className="flex flex-wrap gap-2"><button type="button" disabled={working != null} onClick={() => void refreshEvidence(row.follow.cik)} className="rounded border border-white/15 px-3 py-2 text-[10px] text-white/65 disabled:opacity-40">{working === `refresh:${row.follow.cik}` ? "Refreshing…" : "Refresh company data"}</button><button type="button" disabled={working != null || !row.currentSnapshot} onClick={() => void captureBaseline(row)} className="rounded border border-emerald-300/25 px-3 py-2 text-[10px] text-white/70 disabled:opacity-40">{working === `baseline:${row.follow.id}` ? "Saving…" : "Set current filings as baseline"}</button><button type="button" disabled={working != null} onClick={() => void unfollow(row)} className="rounded border border-white/10 px-3 py-2 text-[10px] text-white/45 disabled:opacity-40">Unfollow</button></div>
        </div>
        {row.omittedFilingCount > 0 && <p className="text-[10px] text-amber-100/70">Showing the newest {row.newFilings.length} of {row.newFilingCount} new SEC accessions; {row.omittedFilingCount} additional accessions are omitted from this review list.</p>}
        {row.newFilings.length > 0 ? <ul className="space-y-1.5">{row.newFilings.map((filing) => <li key={filing.id} className="rounded border border-white/[0.07] px-3 py-2">{filingSourceUrl(filing) ? <a href={filingSourceUrl(filing)!} target="_blank" rel="noreferrer" className="text-[11px] text-emerald-100/70 underline decoration-white/20 underline-offset-2">{filing.form} filed {filing.filed_at}</a> : <span>{filing.form} filed {filing.filed_at} · source link unavailable</span>}<span className="ml-2 font-mono text-[9px] text-white/40">{filing.accession}</span><p className="mt-1 text-[9px] text-white/35">Report period {filing.report_period ?? "not supplied"} · retrieved {stamp(filing.retrieved_at)}</p></li>)}</ul> : <p className="text-[10px] text-white/40">{row.baseline ? "No new filings have appeared since this baseline." : "No filing history is available to review yet."}</p>}
        </>}
      </article>)}
    </section> : null}
  </div>;
}
