import { useEffect, useMemo, useRef, useState } from "react";
import { boundModelProviderInput } from "../../../shared/model-provider-input.js";
import type { Mention } from "../lib/api.js";
import { sourceClockForMention } from "../lib/source-clock.js";
import { GEMINI_PURPOSE_DISCLOSURE } from "../lib/gemini-purpose-disclosure.js";

type ProviderId = "openai" | "google_gemini" | "typesafe_jev" | "codex_luna";
type Attempt = {
  id: string; modelRequested: string; status: string; reservedAt: number; completedAt: number | null;
  httpStatus: number | null; modelReturned: string | null; inputTokens: number | null; outputTokens: number | null;
  estimatedCostUsd: number | null; errorCategory: string | null;
};
type Classification = {
  attemptId: string; provider: ProviderId; modelRequested: string; modelReturned: string | null;
  sourceTimeAt: number | null; retrievedAt: number; sentiment: "negative" | "neutral" | "positive" | null;
  eventType: string | null; takeaway: string | null; evidenceSufficient: boolean; summary: string | null;
  supportingExcerpt: string | null; disposition: "classified" | "excluded" | "review_required"; createdAt: number;
  pPositive?: number; pNeutral?: number; pNegative?: number; confidence?: number;
};
type ProviderStatus = { provider: ProviderId; configured: boolean; model: string; unknownOutcome?: boolean };
type ReadState = { contextKey: string; result: Classification | null; attempts: Attempt[] };

const providerName: Record<ProviderId, string> = { openai: "OpenAI", google_gemini: "Google Gemini", typesafe_jev: "TypeSafe Jev", codex_luna: "Codex" };
const modelName: Record<ProviderId, string> = { openai: "gpt-6-luna", google_gemini: "gemini-3.8-flash", typesafe_jev: "jev-latest", codex_luna: "gpt-6-luna" };
const labelBySentiment = { positive: "Bullish signal", neutral: "Neutral / mixed", negative: "Bearish signal" } as const;
const assessmentContextKey = (mentionId: string, provider: ProviderId) => `${mentionId}\u0000${provider}`;

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store", headers: { ...(init?.headers ?? {}), "content-type": "application/json" } });
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `request_failed_${response.status}`);
  return body;
}

function timestamp(value: number | null): string {
  return value == null ? "time unavailable" : new Date(value).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

function errorCopy(code: string): string {
  switch (code) {
    case "codex_sign_in_unavailable": return "Open Codex and sign in on this computer, then reopen this source. No API key is needed.";
    case "codex_auth_expired": return "The existing Codex session needs renewal. Open Codex before reviewing a new request.";
    case "codex_request_in_progress": return "Another Codex source request is running. Wait for its result before sending this item.";
    case "codex_model_rerouted": return "Codex changed the requested model. No sentiment point was accepted.";
    case "external_requests_disabled": return "Model requests are paused in this local app session.";
    case "local_storage_paused": return "A local storage safety limit is pausing model requests.";
    case "provider_credential_missing": return "Save this provider’s key in Model providers first.";
    case "source_not_approved_for_model_processing": return "This source type is not approved for model processing.";
    case "source_not_suitable_for_investor_classification": return "This item did not pass company identity or investor-relevance checks, so it was not sent.";
    case "provider_usage_review_required": return "Review this provider’s usage for the earlier uncertain request before sending another one.";
    case "provider_request_not_sent": return "The request was not sent. Review it before trying again.";
    case "provider_assessment_failed": return "Jev did not return a valid assessment. No chart point was added.";
    case "daily_request_limit": return "This provider reached today’s local request limit.";
    case "daily_byte_limit": return "This provider reached today’s local request-size limit.";
    case "daily_cost_limit": return "This provider reached today’s conservative local cost ceiling.";
    case "provider_outcome_unknown": return "The provider may have received the request, but no verified result was saved. Check provider usage before any new request.";
    default: return "The request did not produce a saved classification. Review provider usage before retrying.";
  }
}

export function SourceModelAssessment({
  mention,
  companyName,
  ticker,
  sector,
  onOpenProviderSettings,
  onClassificationSaved,
}: {
  mention: Mention;
  companyName: string;
  ticker: string;
  sector?: string;
  onOpenProviderSettings?: () => void;
  onClassificationSaved?: () => void;
}) {
  const [provider, setProvider] = useState<ProviderId>("google_gemini");
  const providerChosenRef = useRef(false);
  const contextKey = assessmentContextKey(mention.id, provider);
  const contextKeyRef = useRef(contextKey);
  contextKeyRef.current = contextKey;
  const requestGenerationRef = useRef(0);
  const mountedRef = useRef(false);
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [state, setState] = useState<ReadState | null>(null);
  const [loadingContextKey, setLoadingContextKey] = useState<string | null>(contextKey);
  const [checking, setChecking] = useState(false);
  const [requestReviewOpen, setRequestReviewOpen] = useState(false);
  const [confirmDataSend, setConfirmDataSend] = useState(false);
  const [geminiPaidServiceAttested, setGeminiPaidServiceAttested] = useState(false);
  const [reviewedProviderUsage, setReviewedProviderUsage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loading = loadingContextKey === contextKey;
  const activeState = state?.contextKey === contextKey ? state : null;
  const configured = providers.find(item => item.provider === provider)?.configured === true;
  const unknownAttemptExists = useMemo(() => activeState?.attempts.some(item => item.status === "unknown") === true
    || providers.some(item => item.provider === provider && item.unknownOutcome), [activeState,providers,provider]);
  const jevSourceClock = useMemo(() => sourceClockForMention(mention), [mention]);
  const categoricalRequestPreview = useMemo(() => boundModelProviderInput({
    company: { name: companyName, ticker, sector },
    source: { collector: mention.collector, publisher: mention.publisherName, title: mention.title, excerpt: mention.snippet },
  }), [companyName, ticker, sector, mention]);

  const loadState = async (mentionId: string, providerId: ProviderId, signal?: AbortSignal) => {
    const requestContextKey = assessmentContextKey(mentionId, providerId);
    if (contextKeyRef.current !== requestContextKey || signal?.aborted || !mountedRef.current) return;
    const generation = ++requestGenerationRef.current;
    const isCurrent = () => mountedRef.current
      && contextKeyRef.current === requestContextKey
      && requestGenerationRef.current === generation
      && !signal?.aborted;
    setLoadingContextKey(requestContextKey);
    try {
      const [nextStatus, nextState] = await Promise.all([
        request<{ providers: ProviderStatus[] }>("/api/model-providers/status", { signal }),
        request<Omit<ReadState, "contextKey">>(`/api/mentions/${encodeURIComponent(mentionId)}/model-classification?provider=${providerId}`, { signal }),
      ]);
      if (!isCurrent()) return;
      setProviders(nextStatus.providers);
      if (!providerChosenRef.current && nextStatus.providers.some(item => item.provider === "codex_luna" && item.configured)) {
        providerChosenRef.current = true;
        setProvider("codex_luna");
        return;
      }
      setState({ ...nextState, contextKey: requestContextKey });
    } catch {
      if (!isCurrent()) return;
      setState(null);
      setError("Model-provider status is unavailable. No request was sent.");
    } finally {
      if (isCurrent()) setLoadingContextKey(null);
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setRequestReviewOpen(false);
    setConfirmDataSend(false);
    setGeminiPaidServiceAttested(false);
    setReviewedProviderUsage(false);
    void loadState(mention.id, provider, controller.signal);
    return () => {
      controller.abort();
      requestGenerationRef.current += 1;
    };
  }, [mention.id, provider]);

  const run = async () => {
    if (!confirmDataSend) return;
    if (provider === "google_gemini" && (!confirmDataSend || !geminiPaidServiceAttested)) return;
    const requestContextKey = contextKey;
    setChecking(true);
    setError(null);
    try {
      const endpoint = provider === "codex_luna" ? "codex-luna-classification" : provider === "typesafe_jev" ? "jev-assessment" : "model-classification";
      await request<{ result: Classification }>(`/api/mentions/${encodeURIComponent(mention.id)}/${endpoint}`, {
        method: "POST",
        body: JSON.stringify({ ...(provider === "typesafe_jev" || provider === "codex_luna" ? {} : { provider }), confirmDataSend: true,
          ...(provider === "google_gemini" ? { confirmGeminiPaidService: geminiPaidServiceAttested } : {}),
          confirmProviderUsageReview: reviewedProviderUsage }),
      });
      if (!mountedRef.current || contextKeyRef.current !== requestContextKey) return;
      onClassificationSaved?.();
      setRequestReviewOpen(false);
      setConfirmDataSend(false);
      setGeminiPaidServiceAttested(false);
      await loadState(mention.id, provider);
    } catch (reason) {
      if (!mountedRef.current || contextKeyRef.current !== requestContextKey) return;
      const code = reason instanceof Error ? reason.message : "provider_classification_failed";
      setError(errorCopy(code));
      setRequestReviewOpen(false);
      setConfirmDataSend(false);
      setGeminiPaidServiceAttested(false);
      if (code === "provider_outcome_unknown") await loadState(mention.id, provider);
    } finally {
      if (mountedRef.current && contextKeyRef.current === requestContextKey) setChecking(false);
    }
  };

  const result = activeState?.result ?? null;
  return (
    <section className="mt-4 rounded-lg border border-emerald-200/15 bg-emerald-100/[0.025] p-3" aria-labelledby="source-model-assessment-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 id="source-model-assessment-heading" className="micro m-0">SOURCE MODEL ASSESSMENT</h3>
          <p className="mt-1 text-[10px] text-white/45">One saved public source · explicit request · Jev history stays separate</p>
        </div>
        <label className="flex items-center gap-2 text-[10px] text-white/65">
          Provider
          <select value={provider} disabled={checking || loading} onChange={event => {
            providerChosenRef.current = true;
            const nextProvider = event.currentTarget.value as ProviderId;
            const nextContextKey = assessmentContextKey(mention.id, nextProvider);
            contextKeyRef.current = nextContextKey;
            requestGenerationRef.current += 1;
            setProvider(nextProvider);
            setState(null);
            setLoadingContextKey(nextContextKey);
            setError(null);
            setRequestReviewOpen(false);
            setConfirmDataSend(false);
            setGeminiPaidServiceAttested(false);
            setReviewedProviderUsage(false);
          }} className="rounded border border-white/15 bg-[#111318] px-2 py-1.5 text-[10px] text-white/85 disabled:opacity-50">
            <option value="codex_luna">Codex · Luna · existing subscription</option>
            <option value="google_gemini">Google Gemini · {modelName.google_gemini}</option>
            <option value="openai">OpenAI · {modelName.openai}</option>
            <option value="typesafe_jev">TypeSafe Jev · {modelName.typesafe_jev}</option>
          </select>
        </label>
      </div>

      {result && <div className="mt-3 rounded-md border border-white/10 bg-black/20 p-2.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <strong className={`text-[11px] ${result.disposition === "classified" && result.sentiment === "positive" ? "text-emerald-200" : result.disposition === "classified" && result.sentiment === "negative" ? "text-rose-200" : "text-white/70"}`}>
            {result.disposition === "classified" && result.sentiment ? labelBySentiment[result.sentiment] : result.disposition === "excluded" ? "Excluded by the model rubric" : "Needs review · no directional read"}
          </strong>
          <span className="text-[9px] text-white/40">{providerName[result.provider]} · {result.modelReturned ?? "Luna requested · returned model not exposed"}</span>
        </div>
        {result.summary && <p className="mt-2 text-[11px] leading-relaxed text-white/80">{result.summary}</p>}
        {provider === "typesafe_jev" && result.takeaway && <p className="mt-2 text-[10px] text-white/65">Jev rubric · {result.eventType?.replaceAll("_", " ")} · {result.takeaway.replaceAll("_", " ")}{result.confidence == null ? "" : ` · ${Math.round(result.confidence * 100)}% confidence`}</p>}
        {provider === "typesafe_jev" && result.pPositive != null && result.pNegative != null && <p className="mt-1 text-[9px] text-white/40">Jev probabilities · bullish {Math.round(result.pPositive * 100)}% · neutral {Math.round((result.pNeutral ?? 0) * 100)}% · bearish {Math.round(result.pNegative * 100)}%</p>}
        {result.supportingExcerpt && <blockquote className="mt-2 border-l-2 border-emerald-200/30 pl-2 text-[10px] leading-relaxed text-white/55">“{result.supportingExcerpt}”</blockquote>}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[9px] text-white/40">
          <span>source time {timestamp(result.sourceTimeAt)}</span>
          <span>retrieved {timestamp(result.retrievedAt)}</span>
          <a className="underline underline-offset-2" href={mention.source.url} target="_blank" rel="noreferrer">Open source ↗</a>
          <span>saved {timestamp(result.createdAt)}</span>
        </div>
        <p className="mt-2 text-[9px] text-white/35">A source-level model judgment, not a company recommendation, forecast, or verified materiality finding.</p>
      </div>}

      {!configured ? (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-md border border-white/8 bg-white/[0.02] p-2.5">
          <p className="m-0 text-[10px] text-white/55">{provider === "codex_luna" ? "Open Codex and sign in on this computer, then reopen this source. No API key is needed." : `No ${providerName[provider]} key is saved on this computer.`}</p>
          {provider !== "codex_luna" && onOpenProviderSettings && <button type="button" onClick={onOpenProviderSettings} className="rounded border border-emerald-200/20 px-2.5 py-1.5 text-[10px] text-emerald-100/80">Manage model API keys</button>}
        </div>
      ) : requestReviewOpen ? (
        <div className="mt-3 rounded-md border border-amber-200/20 bg-amber-100/[0.035] p-2.5">
          <strong className="text-[10px] text-amber-100/90">Review this one-item request</strong>
          <p className="mt-1 text-[10px] leading-relaxed text-white/65">This sends one saved public source to {providerName[provider]} {modelName[provider]}. Review the exact fields below. The source URL, your private notes, and other company records are not included.</p>
          {provider === "codex_luna" && <p className="mt-2 text-[10px] text-amber-100/75">Uses the existing Codex account and its subscription allowance. This local integration is experimental; no separate Desk sign-in or API key is used. Luna is requested, but the native completion does not expose the actual returned model. No tools or local instructions are sent.</p>}
          <dl className="mt-2 grid gap-2 rounded border border-white/[0.08] bg-black/15 p-2 text-[10px] sm:grid-cols-[6rem_1fr]">
            <dt className="text-white/40">Company</dt><dd className="m-0 text-white/75">{provider === "typesafe_jev" ? `${companyName} (${ticker})${sector ? ` · ${sector}` : ""}` : `${categoricalRequestPreview.company.name} (${categoricalRequestPreview.company.ticker})${categoricalRequestPreview.company.sector ? ` · ${categoricalRequestPreview.company.sector}` : ""}`}</dd>
            <dt className="text-white/40">Publisher / feed</dt><dd className="m-0 text-white/75">{provider === "typesafe_jev" ? `${mention.publisherName} · ${mention.collector}` : `${categoricalRequestPreview.source.publisher} · ${categoricalRequestPreview.source.collector}`}</dd>
            {provider === "typesafe_jev" && <><dt className="text-white/40">Publisher domain</dt><dd className="m-0 text-white/75">{mention.publisherDomain ?? "Not provided"}</dd><dt className="text-white/40">Source tier</dt><dd className="m-0 text-white/75">{mention.source.tier}</dd><dt className="text-white/40">Source time</dt><dd className="m-0 text-white/75">{jevSourceClock.label} · {timestamp(jevSourceClock.at)}</dd></>}
            <dt className="text-white/40">{provider === "typesafe_jev" ? "Saved title" : "Title sent (up to 500 characters)"}</dt><dd className="m-0 break-words text-white/75">{provider === "typesafe_jev" ? mention.title : categoricalRequestPreview.source.title}</dd>
            <dt className="text-white/40">{provider === "typesafe_jev" ? "Saved excerpt" : "Excerpt sent (up to 4,000 characters)"}</dt><dd className="m-0 whitespace-pre-wrap break-words text-white/75">{provider === "typesafe_jev" ? mention.snippet || "No excerpt was saved." : categoricalRequestPreview.source.excerpt || "No excerpt was sent."}</dd>
          </dl>
          {provider === "google_gemini" && <p className="mt-1.5 text-[10px] leading-relaxed text-amber-100/75">{GEMINI_PURPOSE_DISCLOSURE} For API clients made available in the EEA, Switzerland, or UK, Google requires Paid Services through a Cloud project with active billing; a free-tier-only project is not eligible, and Gemini 3.8 Flash paid-tier usage is metered. If you require strictly $0 use in those regions, do not send this request. Outside those regions, free quota depends on project eligibility and remaining quota; unpaid-service prompts may be used to improve products and may be reviewed by people. This app cannot verify your region, billing, eligibility, remaining quota, or charges. Send only the public, non-sensitive text shown here; your private notes and source URL are excluded. Review your project in <a className="underline underline-offset-2" href="https://aistudio.google.com/" target="_blank" rel="noreferrer">Google AI Studio</a>, the <a className="underline underline-offset-2" href="https://ai.google.dev/gemini-api/terms?hl=en" target="_blank" rel="noreferrer">Gemini API terms</a>, and <a className="underline underline-offset-2" href="https://ai.google.dev/gemini-api/docs/pricing" target="_blank" rel="noreferrer">pricing and data-use details</a>.</p>}
          {provider === "openai" && <p className="mt-1.5 text-[10px] leading-relaxed text-white/55">This uses your OpenAI API key and may be billed to your OpenAI account. The response is requested with storage disabled; OpenAI controls account data and billing policies.</p>}
          {provider === "typesafe_jev" && <p className="mt-1.5 text-[10px] leading-relaxed text-white/55">This sends the company name, ticker and sector; publisher name and domain; feed and source tier; title, excerpt and the labeled source time shown above to TypeSafe Jev. Feed or provider timestamps are identified by their source; retrieval time is not presented as publication time. Your source URL, private notes and other company records are not included. TypeSafe controls account data, model availability and billing; the saved Jev result stays separate from OpenAI/Gemini classifications.</p>}
          {result && <p className="mt-1.5 text-[10px] leading-relaxed text-amber-100/75">This sends a new request and may consume additional quota or credits. The app will not retry it automatically.</p>}
          {unknownAttemptExists && <label className="mt-2 flex items-start gap-2 text-[10px] leading-relaxed text-amber-100/80"><input type="checkbox" checked={reviewedProviderUsage} onChange={event => setReviewedProviderUsage(event.currentTarget.checked)} className="mt-0.5 accent-amber-300" />I reviewed this provider’s usage for an earlier request whose outcome is unknown.</label>}
          <label className="mt-2 flex items-start gap-2 text-[10px] leading-relaxed text-white/65"><input type="checkbox" checked={confirmDataSend} onChange={event => setConfirmDataSend(event.currentTarget.checked)} className="mt-0.5 accent-emerald-300" />{provider === "google_gemini" ? "I reviewed this public item, confirmed it has no sensitive or confidential information, and approve sending the shown fields to Gemini. I understand the professional/business-use limit and that the Desk cannot determine whether my personal or retail-investing use qualifies." : "Send this saved public source item for a model assessment."}</label>
          {provider === "google_gemini" && <label className="mt-2 flex items-start gap-2 text-[10px] leading-relaxed text-amber-100/80"><input type="checkbox" checked={geminiPaidServiceAttested} onChange={event => setGeminiPaidServiceAttested(event.currentTarget.checked)} className="mt-0.5 accent-amber-300" />If this client is made available in the EEA, Switzerland, or UK, I confirm its project uses Gemini API Paid Services with active Cloud Billing and accept that metered charges may apply.</label>}
          <div className="mt-2 flex gap-2">
            <button type="button" onClick={() => { setRequestReviewOpen(false); setConfirmDataSend(false); setGeminiPaidServiceAttested(false); }} className="rounded border border-white/10 px-2.5 py-1.5 text-[10px] text-white/55">Cancel</button>
            <button type="button" disabled={!confirmDataSend || (provider === "google_gemini" && !geminiPaidServiceAttested) || (unknownAttemptExists && !reviewedProviderUsage) || checking} onClick={() => void run()} className="rounded border border-emerald-200/25 bg-emerald-100/[0.08] px-2.5 py-1.5 text-[10px] font-medium text-emerald-100 disabled:opacity-40">{checking ? "Sending one request…" : `Send to ${providerName[provider]}`}</button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <p className="m-0 text-[10px] text-white/45">{loading ? "Loading saved assessment…" : activeState?.attempts.length ? `${activeState.attempts.length} saved attempt${activeState.attempts.length === 1 ? "" : "s"} for this provider` : "No saved assessment for this provider."}</p>
          <button type="button" disabled={checking || loading} onClick={() => { setConfirmDataSend(false); setGeminiPaidServiceAttested(false); setRequestReviewOpen(true); }} className="rounded border border-emerald-200/20 px-2.5 py-1.5 text-[10px] text-emerald-100/85 disabled:opacity-40">Review request</button>
        </div>
      )}
      {activeState?.attempts.slice(0, 3).map(attempt => <p key={attempt.id} className={`mt-1.5 text-[9px] ${attempt.status === "unknown" ? "text-amber-100/70" : "text-white/35"}`}>Latest attempt {attempt.status.replaceAll("_", " ")} · {attempt.modelReturned ?? attempt.modelRequested}{attempt.estimatedCostUsd == null ? "" : ` · estimated $${attempt.estimatedCostUsd.toFixed(6)}`}</p>)}
      {error && <p role="alert" className="mt-2 text-[10px] text-amber-100/85">{error}</p>}
      <p className="mt-2 text-[9px] leading-relaxed text-white/35">{provider === "codex_luna" ? "Local ceiling: 20 confirmed analyses and 512 KB of source text per UTC day. Codex subscription limits still apply. The Desk does not resubmit failed analyses; native Codex transport behavior applies." : "The desk applies a local ceiling of 5 requests, 500 KB of request bodies and $0.10 estimated model cost per provider per UTC day. Provider quota and final billing remain provider-managed."}</p>
    </section>
  );
}
