import { useCallback, useEffect, useState } from "react";
import { GEMINI_PURPOSE_DISCLOSURE } from "../lib/gemini-purpose-disclosure.js";

type ProviderId = "openai" | "google_gemini" | "typesafe_jev";
type ProviderStatus = {
  provider: ProviderId;
  configured: boolean;
  credentialUnavailable?: boolean;
  model: string;
  usage: { requests: number; requestBytes: number; estimatedCostUsd: number; verificationRequests: number };
  limits: { dailyRequests: number; dailyRequestBytes: number; dailyCostUsd: number; dailyVerificationRequests: number };
};
type Status = { providers: ProviderStatus[] };

const labels: Record<ProviderId, string> = { openai: "OpenAI API · GPT-6 Luna", google_gemini: "Google Gemini API · free only where permitted", typesafe_jev: "TypeSafe Jev" };
const DEFAULT_PROVIDER_ORDER: readonly ProviderId[] = ["google_gemini", "openai", "typesafe_jev"];

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, cache: "no-store", headers: { ...(init?.headers ?? {}), "content-type": "application/json" } });
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body?.error ?? `request_failed_${response.status}`);
  return body;
}

export function ModelProviderSettings({ preferredProvider }: { preferredProvider?: ProviderId } = {}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [keys, setKeys] = useState<Record<ProviderId, string>>({ openai: "", google_gemini: "", typesafe_jev: "" });
  const [busy, setBusy] = useState<ProviderId | null>(null);
  const [messages, setMessages] = useState<Partial<Record<ProviderId, { kind: "ok" | "error"; text: string }>>>({});
  const providerOrder: ProviderId[] = preferredProvider == null
    ? [...DEFAULT_PROVIDER_ORDER]
    : [preferredProvider, ...DEFAULT_PROVIDER_ORDER.filter(provider => provider !== preferredProvider)];

  const refresh = useCallback(async () => {
    try { setStatus(await requestJson<Status>("/api/model-providers/status")); }
    catch { setStatus(null); }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const save = async (provider: ProviderId) => {
    const apiKey = keys[provider];
    if (!apiKey.trim()) return;
    setKeys(current => ({ ...current, [provider]: "" }));
    setBusy(provider);
    setMessages(current => ({ ...current, [provider]: undefined }));
    try {
      await requestJson(`/api/model-providers/${provider}/credential`, { method: "PUT", body: JSON.stringify({ apiKey }) });
      setMessages(current => ({ ...current, [provider]: { kind: "ok", text: "Key saved securely on this computer. Saving it did not contact the provider." } }));
      await refresh();
    } catch (error) {
      const code = error instanceof Error ? error.message : "credential_save_failed";
      setMessages(current => ({ ...current, [provider]: { kind: "error", text: code === "loopback_only" ? "Provider keys are available in the local desktop app." : "Key could not be saved. Enter it again and retry." } }));
    } finally { setBusy(null); }
  };

  const verify = async (provider: ProviderId) => {
    setBusy(provider);
    setMessages(current => ({ ...current, [provider]: undefined }));
    try {
      const result = await requestJson<{ model: string; available: boolean }>(`/api/model-providers/${provider}/verify`, { method: "POST", body: "{}" });
      setMessages(current => ({ ...current, [provider]: {
        kind: result.available ? "ok" : "error",
        text: result.available ? `${result.model} is available for this key.` : `The key works, but ${result.model} is not in this account's available model list.`,
      } }));
    } catch (error) {
      const code = error instanceof Error ? error.message : "provider_verification_failed";
      const text = code === "external_requests_disabled" || code === "external_requests_paused" || code === "provider_request_not_sent" ? "External requests are paused. No provider request was sent."
        : code === "local_storage_paused" ? "A local storage safety limit is pausing provider checks."
        : code === "provider_credential_missing" ? "Save a key first."
          : code === "daily_verification_limit" ? "Today’s local connection-check limit has been reached for this provider."
            : "The provider could not verify this key. Check the key and your account access.";
      setMessages(current => ({ ...current, [provider]: { kind: "error", text } }));
    } finally { setBusy(null); }
  };

  const remove = async (provider: ProviderId) => {
    setBusy(provider);
    setMessages(current => ({ ...current, [provider]: undefined }));
    try {
      await requestJson(`/api/model-providers/${provider}/credential`, { method: "DELETE" });
      setMessages(current => ({ ...current, [provider]: { kind: "ok", text: "Saved key removed from this computer." } }));
      await refresh();
    } catch {
      setMessages(current => ({ ...current, [provider]: { kind: "error", text: "Saved key could not be removed." } }));
    } finally { setBusy(null); }
  };

  return (
    <section className="rounded-xl border border-white/10 bg-black/25 p-3" aria-labelledby="model-provider-settings-heading">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 id="model-provider-settings-heading" className="micro m-0">MODEL PROVIDERS</h3>
          <p className="mt-1 max-w-3xl text-[11px] leading-relaxed text-white/55">
            Add your own API key. It is encrypted locally using the operating system credential store. Save and verify never classify an item; choose a saved source and authorize that request separately. Local usage caps are not a provider billing limit or balance.
          </p>
        </div>
        <button type="button" onClick={() => void refresh()} className="rounded border border-white/10 px-2 py-1 text-[10px] text-white/60 hover:bg-white/[0.05]">Refresh</button>
      </div>
      {!status && <p role="status" className="mt-3 text-[11px] text-white/50">Local provider status is unavailable in this app session.</p>}
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {providerOrder.map(provider => {
          const entry = status?.providers.find(item => item.provider === provider);
          const message = messages[provider];
          return (
            <div key={provider} className="rounded-lg border border-white/10 bg-white/[0.025] p-3">
              <div className="flex items-center justify-between gap-2">
                <strong className="text-[12px] text-white/85">{labels[provider]}</strong>
                <span className={`text-[10px] ${entry?.configured ? "text-emerald-200/80" : entry?.credentialUnavailable ? "text-amber-100/75" : "text-white/40"}`}>{entry?.credentialUnavailable ? "Secure storage unavailable" : entry?.configured ? "Key saved" : "No key saved"}</span>
              </div>
              <p className="mt-1 text-[10px] text-white/45">Model: {entry?.model ?? (provider === "openai" ? "gpt-6-luna" : provider === "google_gemini" ? "gemini-3.8-flash" : "jev-latest")}</p>
              <label className="mt-3 block text-[10px] text-white/60" htmlFor={`provider-key-${provider}`}>API key</label>
              <input
                id={`provider-key-${provider}`}
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                value={keys[provider]}
                onChange={event => setKeys(current => ({ ...current, [provider]: event.currentTarget.value }))}
                placeholder={entry?.configured ? "Enter a replacement key" : "Paste key here"}
                className="mt-1 w-full rounded-md border border-white/12 bg-black/35 px-2.5 py-2 text-[11px] text-white outline-none focus:border-emerald-300/50"
              />
              <div className="mt-2 flex flex-wrap gap-2">
                <button type="button" disabled={busy !== null || !keys[provider].trim()} onClick={() => void save(provider)} className="rounded-md border border-emerald-300/25 bg-emerald-300/[0.07] px-2.5 py-1.5 text-[10px] font-medium text-emerald-100 disabled:opacity-40">Save key</button>
                <button type="button" disabled={busy !== null || !entry?.configured} onClick={() => void verify(provider)} className="rounded-md border border-white/10 px-2.5 py-1.5 text-[10px] text-white/70 disabled:opacity-40">Verify model access</button>
                {entry?.configured && <button type="button" disabled={busy !== null} onClick={() => void remove(provider)} className="rounded-md border border-white/10 px-2.5 py-1.5 text-[10px] text-white/55 disabled:opacity-40">Remove key</button>}
              </div>
              {provider === "google_gemini" && <div className="mt-3 space-y-2">
                <a className="inline-flex min-h-9 items-center rounded-md border border-emerald-300/25 bg-emerald-300/[0.07] px-3 text-[11px] font-medium text-emerald-100 hover:bg-emerald-300/[0.12]" href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">Get a Gemini API key ↗</a>
                <p className="m-0 text-[11px] leading-relaxed text-amber-100/75">{GEMINI_PURPOSE_DISCLOSURE} Google lists free input and output quota for eligible models and projects in regions where free-tier use is allowed. Its terms require Gemini API clients made available in the EEA, Switzerland, and UK to use Paid Services through a Cloud project with active billing; a free-tier-only project is not eligible there, and Gemini 3.8 Flash paid-tier usage is metered. If you require strictly $0 use in those regions, do not send Gemini requests. Elsewhere, free quota is account- and project-dependent, and use beyond quota may be charged. This app cannot verify region, eligibility, billing, or remaining quota, and its local cap cannot limit Google charges. Approve each public, non-sensitive source item; private notes are never sent through Gemini.</p>
                <details className="text-[10px] leading-relaxed text-white/45">
                  <summary className="cursor-pointer text-white/60">Review Gemini data-use terms</summary>
                  <p className="mt-1">Where free Gemini API quota is permitted, Google may use prompts and responses to improve products, and human reviewers may process them. For API clients made available in the EEA, Switzerland, and UK, Google requires Paid Services through a project with active billing; Paid Services data terms apply. <a className="underline underline-offset-2" href="https://ai.google.dev/gemini-api/terms?hl=en" target="_blank" rel="noreferrer">Gemini API terms</a> · <a className="underline underline-offset-2" href="https://ai.google.dev/gemini-api/docs/pricing" target="_blank" rel="noreferrer">Pricing and data-use details</a>.</p>
                </details>
              </div>}
              {provider === "openai" && <p className="mt-2 text-[10px] leading-relaxed text-white/45">This API-key route may incur OpenAI API charges; API billing is separate from ChatGPT plans. GPT-6 Luna through a ChatGPT plan uses the separate Luna access connection. This card cannot read ChatGPT plan allowance or API account balance.</p>}
              {provider === "typesafe_jev" && <p className="mt-2 text-[10px] leading-relaxed text-white/45">TypeSafe controls account access, model availability, data handling, and billing. Jev uses its own rubric and a separate source history. See the <a className="underline underline-offset-2" href="https://api.typesafe.ai/docs" target="_blank" rel="noreferrer">TypeSafe API documentation</a>.</p>}
              {entry && <p className="mt-2 text-[9px] text-white/40">Today on this computer: {entry.usage.requests}/{entry.limits.dailyRequests} {provider === "typesafe_jev" ? "Jev assessments" : "classifications"} · {entry.usage.verificationRequests}/{entry.limits.dailyVerificationRequests} connection checks · {entry.usage.requestBytes.toLocaleString()}/{entry.limits.dailyRequestBytes.toLocaleString()} request bytes · local conservative usage estimate ${entry.usage.estimatedCostUsd.toFixed(4)}/${entry.limits.dailyCostUsd.toFixed(2)} (not provider billing)</p>}
              {message && <p role={message.kind === "error" ? "alert" : "status"} className={`mt-2 text-[10px] ${message.kind === "error" ? "text-amber-200/85" : "text-emerald-100/75"}`}>{message.text}</p>}
            </div>
          );
        })}
      </div>
    </section>
  );
}
