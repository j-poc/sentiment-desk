import { useEffect, useMemo, useRef, useState } from "react";
import {
  COMPANY_ASSESSMENT_PROMPT_VERSION,
  GEMINI_COMPANY_ASSESSMENT_MODEL,
  OPENAI_COMPANY_ASSESSMENT_MODEL,
  companyAssessmentInstructions,
  type CompanyAssessmentCitation,
  type CompanyAssessmentResult,
} from "../../../shared/company-evidence-assessment.js";
import { canonicalSecFilingUrl, secFilingArchiveUrl } from "../../../shared/sec-filing-url.js";
import { cloudFunctionErrorCode, cloudSupabase } from "../lib/supabase.js";
import { GEMINI_PURPOSE_DISCLOSURE } from "../lib/gemini-purpose-disclosure.js";

type Provider = "openai" | "google_gemini";
interface Fact { id: string; concept: string; unit: string; value_text: string; period_start: string | null; period_end: string; filed_at: string; form: string; accession: string; reported_decimals: string | null; }
interface Filing { id: string; accession: string; form: string; filed_at: string; report_period: string | null; primary_document: string | null; source_url: string; }
interface Props {
  userId: string;
  cik: string;
  ticker: string;
  companyName: string;
  factSnapshotId: string | null;
  filingSnapshotId: string | null;
  facts: readonly Fact[];
  filings: readonly Filing[];
  selectedFactIds: readonly string[];
  selectedFilingIds: readonly string[];
}

const MAX_FACTS = 12;
const MAX_FILINGS = 6;

function modelFor(provider: Provider): string {
  return provider === "openai" ? OPENAI_COMPANY_ASSESSMENT_MODEL : GEMINI_COMPANY_ASSESSMENT_MODEL;
}

function dateRange(fact: Fact): string {
  return fact.period_start ? `${fact.period_start} to ${fact.period_end}` : `instant ${fact.period_end}`;
}

function factSourceUrl(cik: string, fact: Fact, filing: Filing | undefined): string | null {
  return (filing ? canonicalSecFilingUrl(filing.source_url, cik, fact.accession, filing.primary_document) : null)
    ?? secFilingArchiveUrl(cik, fact.accession);
}

function filingSourceUrl(cik: string, filing: Filing): string | null {
  return canonicalSecFilingUrl(filing.source_url, cik, filing.accession, filing.primary_document);
}

function CitationLinks({ ids, citations }: { ids: readonly string[]; citations: readonly CompanyAssessmentCitation[] }) {
  const byId = new Map(citations.map((citation) => [citation.id, citation]));
  return <span className="ml-1 inline-flex flex-wrap gap-x-2">{ids.map((id) => {
    const citation = byId.get(id);
    return citation ? <a key={id} href={citation.sourceUrl} target="_blank" rel="noreferrer" className="text-emerald-100/70 underline decoration-white/20 underline-offset-2" title={citation.label}>{id}</a> : null;
  })}</span>;
}

export function CloudEvidenceAssessment(props: Props) {
  const [provider, setProvider] = useState<Provider>("openai");
  const [apiKey, setApiKey] = useState("");
  const [geminiTermsAccepted, setGeminiTermsAccepted] = useState(false);
  const [geminiPaidServiceAttested, setGeminiPaidServiceAttested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultState, setResultState] = useState<{ contextKey: string; value: CompanyAssessmentResult } | null>(null);
  const apiKeyRef = useRef("");
  const requestController = useRef<AbortController | null>(null);
  const factsById = useMemo(() => new Map(props.facts.map((fact) => [fact.id, fact])), [props.facts]);
  const filingsById = useMemo(() => new Map(props.filings.map((filing) => [filing.id, filing])), [props.filings]);
  const selectedFacts = props.selectedFactIds.flatMap((id) => factsById.has(id) ? [factsById.get(id)!] : []);
  const selectedFilings = props.selectedFilingIds.flatMap((id) => filingsById.has(id) ? [filingsById.get(id)!] : []);
  const assessmentContextKey = JSON.stringify([props.cik, props.factSnapshotId, props.filingSnapshotId,
    selectedFacts.map((fact) => fact.id), selectedFilings.map((filing) => filing.id)]);
  const assessmentContextKeyRef = useRef(assessmentContextKey);
  assessmentContextKeyRef.current = assessmentContextKey;
  const result = resultState?.contextKey === assessmentContextKey ? resultState.value : null;
  const selectedEvidenceCount = selectedFacts.length + selectedFilings.length;
  const selectionsWithinLimit = selectedFacts.length <= MAX_FACTS && selectedFilings.length <= MAX_FILINGS;
  const ready = Boolean(cloudSupabase && props.factSnapshotId && props.filingSnapshotId && selectedEvidenceCount > 0
    && selectionsWithinLimit && apiKey.trim().length >= 16
    && (provider !== "google_gemini" || (geminiTermsAccepted && geminiPaidServiceAttested)) && !busy);

  const clearKey = () => {
    apiKeyRef.current = "";
    setApiKey("");
  };
  useEffect(() => () => {
    apiKeyRef.current = "";
    requestController.current?.abort();
    requestController.current = null;
  }, []);
  useEffect(() => {
    requestController.current?.abort();
    setResultState(null);
    setError(null);
    setGeminiTermsAccepted(false);
    setGeminiPaidServiceAttested(false);
  }, [assessmentContextKey]);

  const changeProvider = (next: Provider) => {
    if (next === provider) return;
    clearKey();
    setGeminiTermsAccepted(false);
    setGeminiPaidServiceAttested(false);
    setResultState(null);
    setError(null);
    setProvider(next);
  };

  const submit = async () => {
    if (!cloudSupabase || !ready || (provider === "google_gemini" && (!geminiTermsAccepted || !geminiPaidServiceAttested)) || !props.factSnapshotId || !props.filingSnapshotId) return;
    const requestKey = apiKeyRef.current;
    if (!requestKey) return;
    setBusy(true);
    setError(null);
    setResultState(null);
    const requestContextKey = assessmentContextKey;
    setGeminiTermsAccepted(false);
    setGeminiPaidServiceAttested(false);
    const factIds = selectedFacts.map((fact) => fact.id);
    const filingIds = selectedFilings.map((filing) => filing.id);
    const controller = new AbortController();
    requestController.current = controller;
    try {
      const { data, error: invokeError } = await cloudSupabase.functions.invoke("assess-company-evidence", {
        body: { provider, cik: props.cik, factSnapshotId: props.factSnapshotId, filingSnapshotId: props.filingSnapshotId,
          factIds, filingIds, paidServiceAttested: provider === "google_gemini" && geminiPaidServiceAttested },
        headers: { "x-provider-api-key": requestKey },
        signal: controller.signal,
        timeout: 35_000,
      });
      if (controller.signal.aborted || assessmentContextKeyRef.current !== requestContextKey) return;
      if (invokeError) {
        const code = await cloudFunctionErrorCode(invokeError);
        const messages: Record<string, string> = {
          source_snapshot_changed: "Company data changed while you were reviewing it. Refresh company information and select the evidence again.",
          selected_source_changed: "The selected evidence changed. Refresh company information and select it again.",
          selected_source_unavailable: "The selected SEC records are temporarily unavailable. Refresh company information and try again.",
          provider_key_required: "The provider key was not accepted by the request form. Enter it again.",
          provider_request_failed: "The provider did not complete this request. Check the key, account access, and provider quota.",
          provider_output_invalid: "The response failed structure or policy checks. No assessment was shown. Citations alone do not verify claim support.",
        };
        setError(messages[code ?? ""] ?? "The assessment request did not complete. The key has been cleared; check the provider and try again.");
      } else if (!data || typeof data !== "object") {
        setError("The assessment request did not complete. The key has been cleared; check the provider and try again.");
      } else if ("error" in data && typeof data.error === "string") {
        const messages: Record<string, string> = {
          source_snapshot_changed: "Company data changed while you were reviewing it. Refresh company information and select the evidence again.",
          provider_key_required: "The provider key was not accepted by the request form. Enter it again.",
          provider_request_failed: "The provider did not complete this request. Check the key, account access, and provider quota.",
          provider_output_invalid: "The response failed structure or policy checks. No assessment was shown. Citations alone do not verify claim support.",
        };
        setError(messages[data.error] ?? "The selected source rows could not be verified. Refresh company information and try again.");
      } else {
        setResultState({ contextKey: requestContextKey, value: data as CompanyAssessmentResult });
      }
    } catch {
      if (!controller.signal.aborted && assessmentContextKeyRef.current === requestContextKey) {
        setError("The assessment request did not complete. The key has been cleared; check the provider and try again.");
      }
    } finally {
      clearKey();
      if (requestController.current === controller) requestController.current = null;
      setBusy(false);
    }
  };

  const stance = result?.assessment.stance.replaceAll("_", " ").toUpperCase();
  const citedPoints = (points: CompanyAssessmentResult["assessment"]["bullishEvidence"]) => points.map((point, index) => <li key={`${point.claim}:${index}`} className="text-[11px] leading-5 text-white/65">{point.claim}<CitationLinks ids={point.citationIds} citations={result!.citations} /></li>);

  return <section className="panel p-4" aria-labelledby="evidence-assessment-heading">
    <p className="micro">OPTIONAL MODEL READ</p>
    <h2 id="evidence-assessment-heading" className="mt-1 text-sm font-semibold text-white/80">Assess selected company evidence</h2>
    <p className="mt-1 max-w-4xl text-[10px] leading-4 text-white/45">Get a source-cited bullish, bearish, mixed, or insufficient-evidence read of selected reported facts and filing metadata. Filing documents are not sent. The assessment is a research aid, not a recommendation.</p>
    <p className="mt-1 max-w-4xl text-[9px] leading-4 text-white/35">TypeSafe Jev remains a separate source-level sentiment workflow. This SEC evidence screen does not relabel Jev’s source judgment as a company bull/bear thesis.</p>

    <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <label className="text-[10px] text-white/50">Provider<select value={provider} onChange={(event) => changeProvider(event.target.value as Provider)} disabled={busy} className="mt-1 block w-full rounded border border-white/10 bg-[#101113] px-2.5 py-2 text-xs text-white/80"><option value="openai">OpenAI</option><option value="google_gemini">Google Gemini</option></select><span className="mt-1 block text-[9px] text-white/35">Model: {modelFor(provider)}</span></label>
      <label className="text-[10px] text-white/50">Your {provider === "openai" ? "OpenAI" : "Google AI Studio"} API key<input type="password" autoComplete="off" spellCheck={false} value={apiKey} disabled={busy} onChange={(event) => { apiKeyRef.current = event.target.value; setApiKey(event.target.value); }} placeholder="Entered for this request only" className="mt-1 block w-full rounded border border-white/10 bg-black/20 px-3 py-2 text-xs text-white/80 outline-none focus-visible:border-emerald-300/50" /></label>
    </div>
    <p className="mt-2 text-[9px] leading-4 text-white/35">Your key is sent in an HTTPS header through this authenticated app function for one request. App code does not save or log it. Hosting and deployment access logs have not been independently verified. The assessment response is held in this page only.</p>

    {provider === "openai" ? <p className="mt-2 text-[9px] leading-4 text-white/40">OpenAI receives only the company name, ticker, and selected SEC values and filing metadata. The request disables response storage. See <a href="https://platform.openai.com/docs/guides/your-data" target="_blank" rel="noreferrer" className="underline underline-offset-2">OpenAI API data controls</a>.</p> : <div className="mt-2 rounded border border-amber-200/15 bg-amber-200/[0.035] p-3 text-[9px] leading-4 text-amber-100/65">
      <p className="m-0">{GEMINI_PURPOSE_DISCLOSURE} Where free quota is permitted, Google may use unpaid-service prompts and responses to improve products and may have people review them. For API clients made available in the EEA, Switzerland, or UK, Google requires Paid Services through a Cloud project with active billing; a free-tier-only project is not eligible there, and Gemini 3.8 Flash paid-tier usage is metered. If you require strictly $0 use in those regions, do not send this request. Elsewhere, free quota depends on project eligibility and remaining quota; usage beyond quota may be charged. This app cannot verify your region, project eligibility, billing, remaining quota, or charges. Do not send confidential or personal information. <a href="https://ai.google.dev/gemini-api/terms?hl=en" target="_blank" rel="noreferrer" className="underline underline-offset-2">Read Gemini API terms</a> and <a href="https://ai.google.dev/gemini-api/docs/pricing" target="_blank" rel="noreferrer" className="underline underline-offset-2">pricing and data-use details</a>.</p>
      <label className="mt-2 flex cursor-pointer items-start gap-2"><input type="checkbox" checked={geminiTermsAccepted} onChange={(event) => setGeminiTermsAccepted(event.target.checked)} disabled={busy} className="mt-0.5 accent-amber-200" /><span>I understand Google’s unpaid-service data use and professional/business-purpose limit (not consumer use), and that the Desk cannot determine whether my personal or retail-investing use qualifies. I will send only non-confidential SEC evidence.</span></label>
      <label className="mt-2 flex cursor-pointer items-start gap-2"><input type="checkbox" checked={geminiPaidServiceAttested} onChange={(event) => setGeminiPaidServiceAttested(event.target.checked)} disabled={busy} className="mt-0.5 accent-amber-200" /><span>If this client is made available in the EEA, Switzerland, or UK, I confirm its project uses Gemini API Paid Services with active Cloud Billing and accept that metered charges may apply.</span></label>
    </div>}

    <div className="mt-3 rounded border border-white/[0.07] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2"><p className="micro m-0 p-0">EXACT REQUEST PREVIEW</p><span className="text-[9px] text-white/40">{selectedFacts.length}/{MAX_FACTS} facts · {selectedFilings.length}/{MAX_FILINGS} filings · {COMPANY_ASSESSMENT_PROMPT_VERSION}</span></div>
      <p className="mt-2 text-[10px] text-white/60">{props.companyName} ({props.ticker}) · CIK {props.cik} · {modelFor(provider)}</p>
      {!selectionsWithinLimit && <p className="mt-2 text-[10px] text-amber-100/70">Choose no more than {MAX_FACTS} facts and {MAX_FILINGS} filings for one request.</p>}
      {selectedFacts.length > 0 && <ul className="mt-2 space-y-1.5">{selectedFacts.map((fact) => {
        const filing = selectedFilings.find((row) => row.accession === fact.accession);
        const sourceUrl = factSourceUrl(props.cik, fact, filing);
        return <li key={fact.id} className="break-all text-[9px] leading-4 text-white/50"><span className="font-mono text-white/65">{fact.concept}: {fact.value_text} {fact.unit}</span> · {dateRange(fact)} · {fact.form} filed {fact.filed_at} · SEC reported decimals {fact.reported_decimals ?? "not supplied"} · accession {fact.accession} · {sourceUrl ? <a href={sourceUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">{sourceUrl}</a> : "filing link unavailable"}</li>;
      })}</ul>}
      {selectedFilings.length > 0 && <ul className="mt-2 space-y-1">{selectedFilings.map((filing) => {
        const sourceUrl = filingSourceUrl(props.cik, filing);
        return <li key={filing.id} className="break-all text-[9px] leading-4 text-white/50">{sourceUrl ? <><a href={sourceUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">{filing.form} · filed {filing.filed_at}</a> · <span className="text-white/35">metadata only; filing text is not sent · {sourceUrl}</span></> : <>{filing.form} · filed {filing.filed_at} · filing link unavailable</>} · report period {filing.report_period ?? "not supplied"} · accession {filing.accession}</li>;
      })}</ul>}
      {selectedEvidenceCount === 0 && <p className="mt-2 text-[10px] text-white/40">Select facts or filings above to preview the outbound evidence.</p>}
      <p className="mt-3 border-t border-white/[0.06] pt-2 text-[9px] leading-4 text-white/35"><span className="text-white/45">Instructions sent to the model:</span> {companyAssessmentInstructions()}</p>
    </div>

    <div className="mt-3 flex flex-wrap items-center gap-2">
      <button type="button" disabled={!ready} onClick={() => void submit()} className="rounded border border-emerald-300/25 bg-emerald-300/[0.08] px-3 py-2 text-[10px] text-emerald-100/80 disabled:opacity-40">{busy ? "Requesting assessment…" : "Assess selected evidence once"}</button>
      <button type="button" disabled={busy || !apiKey} onClick={clearKey} className="rounded border border-white/10 px-3 py-2 text-[10px] text-white/55 disabled:opacity-35">Clear key</button>
      {provider === "google_gemini" && (!geminiTermsAccepted || !geminiPaidServiceAttested) && <span className="text-[9px] text-amber-100/55">Accept both Gemini data-use and regional Paid Services confirmations to continue.</span>}
    </div>
    {error && <p role="alert" className="mt-3 text-[10px] leading-4 text-amber-100/75">{error}</p>}

    {result && <div className="mt-4 space-y-3 border-t border-white/[0.07] pt-3" aria-live="polite">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="m-0 text-xs font-semibold text-white/80">{stance} · {props.companyName} ({props.ticker})</h3><span className="text-[9px] text-white/40">{result.provider === "openai" ? "OpenAI" : "Google Gemini"} · {result.model} · {new Date(result.generatedAt).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC")}</span></div>
      <p className="m-0 text-[11px] leading-5 text-white/70">{result.assessment.summary}<CitationLinks ids={result.assessment.summaryCitationIds} citations={result.citations} /></p>
      <div className="grid gap-3 sm:grid-cols-2">
        <section><h4 className="micro">POTENTIALLY BULLISH EVIDENCE</h4><ul className="mt-1 space-y-1">{citedPoints(result.assessment.bullishEvidence)}</ul>{result.assessment.bullishEvidence.length === 0 && <p className="text-[10px] text-white/40">No supported bullish point in the selected evidence.</p>}</section>
        <section><h4 className="micro">POTENTIALLY BEARISH EVIDENCE</h4><ul className="mt-1 space-y-1">{citedPoints(result.assessment.bearishEvidence)}</ul>{result.assessment.bearishEvidence.length === 0 && <p className="text-[10px] text-white/40">No supported bearish point in the selected evidence.</p>}</section>
      </div>
      <section><h4 className="micro">IMPORTANT UNKNOWNS</h4>{result.assessment.unknowns.length ? <ul className="mt-1 list-disc space-y-1 pl-4 text-[10px] leading-4 text-white/50">{result.assessment.unknowns.map((item, index) => <li key={`${item}:${index}`}>{item}</li>)}</ul> : <p className="mt-1 text-[10px] text-white/40">No additional unknowns were returned.</p>}</section>
      <ul className="border-t border-white/[0.06] pt-2 text-[9px] text-white/40">{result.citations.map((citation) => <li key={citation.id}><a href={citation.sourceUrl} target="_blank" rel="noreferrer" className="underline underline-offset-2">{citation.id} · {citation.label}</a></li>)}</ul>
      <p className="m-0 text-[9px] leading-4 text-white/35">This model-generated read is not independently verified. Citations link to selected records; they do not prove that a claim follows from its cited values. Review each claim and period before relying on it. Reported values do not establish business quality, materiality, favorability, or investment merit.</p>
    </div>}
  </section>;
}
