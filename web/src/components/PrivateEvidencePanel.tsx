import { useEffect, useState } from "react";
import { isWellFormedUnicode } from "../../../shared/well-formed-unicode.js";

type PrivateEvidenceMeta = {
  id: string;
  companyId: string;
  title: string;
  sourceLabel: string;
  fileName: string | null;
  asOfDate: string | null;
  importedAt: number;
  sha256: string;
};
type PrivateEvidenceAnalysisRecord = {
  companyId: string; evidenceId: string; evidenceSha256: string; modelRequested: string; modelReturned: string;
  usage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number };
  analysis: { sentiment: "positive" | "neutral" | "negative" | "unclear"; summary: string; evidence: Array<{ quote: string; explanation: string }>; uncertainties: string[]; nextQuestion: string };
};
type PrivateEvidenceAnalysisState = {
  status: "in_progress" | "complete" | "failed" | "outcome_unknown";
  payloadSha256: string; requestBytes: number; startedAt: number; savedAt: number | null; errorCode: string | null;
  record: PrivateEvidenceAnalysisRecord | null;
};
type PrivateEvidenceAnalysisAvailability = {
  enabled: boolean; blockedReason: string | null; model: string;
  dataControls: { disclosure: string; documentationUrl: string; promptCachingDocumentationUrl: string };
};
type PrivateEvidenceList = { items: PrivateEvidenceMeta[]; totalCount: number; totalBytes: number; nextCursor: null; analysis: PrivateEvidenceAnalysisAvailability };
type PrivateEvidenceDetail = PrivateEvidenceMeta & { content: string; savedAnalysis: PrivateEvidenceAnalysisState | null };

const MAX_BYTES = 128 * 1024;
const MAX_CODE_POINTS = 40_000;
const MAX_ITEMS = 250;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;
const ACCEPTED_FILE = /\.(txt|md|csv)$/i;

const CAPACITY_MESSAGES: Record<string, string> = {
  item_limit: "The local private-evidence store has reached its 250-note limit. Delete an unneeded note before adding another.",
  byte_limit: "The local private-evidence store has reached its 8 MiB content limit. Delete an unneeded note before adding more.",
  disk_headroom: "The device does not have enough free space for a safe save. No note was added.",
  store_file_limit: "The local private-evidence database has reached its storage limit. Delete an unneeded note before adding more.",
};

function saveErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (code === "private_evidence_capacity_reached") return "Private-note storage is full. Delete an unneeded note and retry.";
  const reason = code.startsWith("private_evidence_capacity_reached:") ? code.slice(code.indexOf(":") + 1) : "";
  if (CAPACITY_MESSAGES[reason]) return CAPACITY_MESSAGES[reason]!;
  return "Could not save the private note. Check the size limits and local connection.";
}

function analysisErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : "";
  if (code === "private_evidence_analysis_attempt_already_recorded") return "This note already has a recorded Luna attempt. The app will not send it again, to avoid duplicate charges. Check OpenAI usage if the prior outcome is uncertain.";
  if (code === "private_evidence_analysis_budget_exhausted") return "The shared OpenAI daily request, byte, or USD limit would be exceeded. No request was sent.";
  if (code === "external_requests_are_disabled" || code === "private_evidence_analysis_external_requests_paused") return "External requests are paused. No Luna request was sent.";
  if (code === "shared_openai_daily_budgets_are_disabled") return "Private-note analysis is disabled until finite shared OpenAI daily request, byte, and USD limits are configured.";
  if (code === "openai_api_key_is_missing") return "Private-note analysis is unavailable because no OpenAI API credential is configured.";
  if (code === "openai_account_use_is_not_approved") return "Private-note analysis is unavailable because OpenAI account use is not approved in this installation.";
  if (code === "private_note_analysis_is_disabled_by_operator") return "GPT-6 Luna analysis is disabled by the local operator.";
  return "Luna did not return a verified private-note analysis. The request may have reached OpenAI; check account usage before trying anything else.";
}

function analysisGateMessage(code: string | null): string {
  if (code === "private_evidence_requires_loopback_binding") return "The app is not bound to a private loopback address.";
  if (code === "external_requests_are_disabled") return "External requests are paused in this installation.";
  if (code === "private_note_analysis_is_disabled_by_operator") return "The local operator has not enabled private-note analysis.";
  if (code === "openai_api_key_is_missing") return "No OpenAI API credential is configured.";
  if (code === "openai_account_use_is_not_approved") return "OpenAI account use is not approved in this installation.";
  if (code === "shared_openai_daily_budgets_are_disabled") return "Finite shared OpenAI daily request, byte, and USD limits are not configured.";
  return "The local account, privacy, storage, or spend gates are closed.";
}

export function privateEvidenceTextError(content: string): string | null {
  if (!isWellFormedUnicode(content)) return "The note contains invalid Unicode text. Replace the affected characters before saving.";
  if (content.includes("\u0000")) return "The note contains a null character. Remove it before saving.";
  if (new TextEncoder().encode(content).length > MAX_BYTES) return "The note exceeds the 128 KiB limit.";
  if ([...content].length > MAX_CODE_POINTS) return "The note exceeds the 40,000 character limit.";
  return null;
}

async function readJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => null) as T | { error?: string } | null;
  if (!response.ok) {
    const reason = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : "request_failed";
    const limit = body && typeof body === "object" && "limit" in body && typeof body.limit === "string" ? body.limit : null;
    throw new Error(limit ? `${reason}:${limit}` : reason);
  }
  if (body === null) throw new Error("invalid_response");
  return body as T;
}

function formatImportedAt(value: number): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : "Import time unavailable";
}

function safeDisclosureText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, "�");
}

function consentPreview(value: string): string {
  const compact = safeDisclosureText(value.replace(/\s+/gu, " ")).trim();
  const points = Array.from(compact);
  return points.length > 180 ? `${points.slice(0, 180).join("")}…` : compact;
}

async function validateFile(file: File): Promise<string> {
  if (!ACCEPTED_FILE.test(file.name)) throw new Error("Choose a UTF-8 .txt, .md, or .csv file.");
  if (file.name.length > 128) throw new Error("The imported file name exceeds the 128 character limit.");
  if (file.size > MAX_BYTES) throw new Error("That file exceeds the 128 KiB limit.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let content: string;
  try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("This file is not valid UTF-8."); }
  if (content.includes("\u0000")) throw new Error("This file contains a null character.");
  if ([...content].length > MAX_CODE_POINTS) throw new Error("That file exceeds the 40,000 character limit.");
  return content;
}

type Props = { companyId: string; companyName: string; ticker: string };

export function PrivateEvidencePanel(props: Props) {
  // A company change must synchronously discard the prior draft before it can
  // render or submit under the next issuer. Keying the full stateful panel
  // makes all form, file-input, selection, and request state company-scoped.
  return <PrivateEvidenceForCompany key={props.companyId} {...props} />;
}

function PrivateEvidenceForCompany({ companyId, companyName, ticker }: Props) {
  const [list, setList] = useState<PrivateEvidenceList | null>(null);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [hasOpened, setHasOpened] = useState(false);
  const [selected, setSelected] = useState<PrivateEvidenceDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [sourceLabel, setSourceLabel] = useState("");
  const [asOfDate, setAsOfDate] = useState("");
  const [content, setContent] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);

  const base = `/api/companies/${encodeURIComponent(companyId)}/private-evidence`;
  const reload = async () => {
    setLoadState("loading");
    try {
      const next = await readJson<PrivateEvidenceList>(await fetch(base, { headers: { Accept: "application/json" } }));
      setList(next);
      setLoadState("ready");
    } catch {
      setList(null);
      setLoadState("error");
    }
  };

  useEffect(() => {
    if (!hasOpened) return;
    let active = true;
    const controller = new AbortController();
    setLoadState("loading");
    fetch(base, { headers: { Accept: "application/json" }, signal: controller.signal })
      .then((response) => readJson<PrivateEvidenceList>(response))
      .then((value) => { if (active) { setList(value); setLoadState("ready"); } })
      .catch(() => { if (active) { setList(null); setLoadState("error"); } });
    return () => { active = false; controller.abort(); };
  }, [base, hasOpened]);

  async function selectEvidence(item: PrivateEvidenceMeta) {
    setError(null); setSelected(null); setBusy(true);
    try {
      const detail = await readJson<PrivateEvidenceDetail>(await fetch(`${base}/${encodeURIComponent(item.id)}`, { headers: { Accept: "application/json" } }));
      if (detail.companyId !== companyId || detail.id !== item.id) throw new Error("issuer_mismatch");
      setSelected(detail);
    } catch { setError("Could not open this private note. Check the connection and try again."); }
    finally { setBusy(false); }
  }

  async function save(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError(null);
    if (!title.trim() || !sourceLabel.trim() || !content.trim()) { setError("Add a title, source, and note content."); return; }
    const validationError = privateEvidenceTextError(content);
    if (validationError) { setError(validationError); return; }
    setBusy(true);
    try {
      await readJson<PrivateEvidenceMeta>(await fetch(base, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ title: title.trim(), sourceLabel: sourceLabel.trim(), fileName, asOfDate: asOfDate || null, content }),
      }));
      setTitle(""); setSourceLabel(""); setAsOfDate(""); setContent(""); setFileName(null);
      const file = document.getElementById(`private-evidence-file-${companyId}`) as HTMLInputElement | null;
      if (file) file.value = "";
      await reload();
    } catch (reason: unknown) { setError(saveErrorMessage(reason)); }
    finally { setBusy(false); }
  }

  async function remove(item: PrivateEvidenceMeta) {
    const safeTitle = safeDisclosureText(item.title);
    const accepted = window.confirm(
      `Delete the private note “${safeTitle}” for ${companyName} (${ticker}) from this device?\n\n` +
      "This cannot be undone. The note will not be sent to OpenAI. Continue with this item only?",
    );
    if (!accepted) return;
    setError(null); setBusy(true);
    try {
      await readJson<{ deleted: true }>(await fetch(`${base}/${encodeURIComponent(item.id)}`, { method: "DELETE", headers: { Accept: "application/json" } }));
      setSelected(null); await reload();
    } catch { setError("Could not delete this private note. It may still be saved locally."); }
    finally { setBusy(false); }
  }

  async function analyzeSelected() {
    if (!selected || !list?.analysis.enabled || selected.savedAnalysis) return;
    const disclosure = list.analysis.dataControls.disclosure;
    const safeTitle = safeDisclosureText(selected.title);
    const safeSourceLabel = safeDisclosureText(selected.sourceLabel);
    const safeNoteId = safeDisclosureText(selected.id);
    const preview = consentPreview(selected.content);
    const accepted = window.confirm(
      `Send this selected private note to OpenAI ${list.analysis.model}?\n\n` +
      `Issuer: ${companyName} (${ticker})\n` +
      `Title: “${safeTitle}”\n` +
      `Source: ${safeSourceLabel}\n` +
      `User-asserted date: ${selected.asOfDate ?? "not provided"}\n` +
      `Note ID: ${safeNoteId}\n` +
      `Content SHA-256 prefix: ${selected.sha256.slice(0, 12)}\n` +
      `Text preview: “${preview}”\n\n` +
      `This sends the note and its issuer identity for one private analysis. It does not create a public sentiment score or alter public charts. The result is saved in this local private store.\n\n${disclosure}\n\n` +
      `Continue with this item only?`,
    );
    if (!accepted) return;
    setError(null); setBusy(true);
    try {
      const state = await readJson<PrivateEvidenceAnalysisState & { reusedSavedAnalysis?: boolean }>(await fetch(`${base}/${encodeURIComponent(selected.id)}/analyze`, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ confirmExternalProcessing: true }),
      }));
      setSelected({ ...selected, savedAnalysis: state });
    } catch (reason: unknown) { setError(analysisErrorMessage(reason)); }
    finally { setBusy(false); }
  }

  return (
    <details id={`private-evidence-${companyId}`} className="private-evidence-panel" onToggle={(event) => { if (event.currentTarget.open) setHasOpened(true); }}>
      <summary>Private research notes <span>Saved locally · optional external analysis</span></summary>
      <section aria-label={`Private research notes for ${companyName}`}>
        <aside className="private-evidence-policy" aria-label="Privacy and data handling before adding a note">
          <h3>Before saving a note</h3>
          <p><strong>For {companyName} ({ticker}) only.</strong> Notes are stored in a separate database on this device, restricted to this operating-system account. The app does not encrypt them or authenticate users; use a trusted device. Device backups may retain deleted copies. Notes stay separate from public mentions, sentiment charts, alerts, and automatic Luna classifications.</p>
          <p>Saving, opening, or deleting a note makes no provider request. If you choose analysis, the selected note's text, title, source label, optional user-asserted date, note ID, content hash and byte count, plus its issuer identity, are sent to OpenAI GPT-6 Luna only after a separate item-specific confirmation. Its filename and local import time are not sent. The request disables response-object storage and prompt caching. OpenAI's default API abuse monitoring may retain prompts, responses, and derived metadata for up to 30 days, with longer retention possible for legal or safety reasons; this installation's account retention controls are unverified. Any result is private analyst context, not public sentiment.</p>
          {loadState === "ready" && list && <p><a href={list.analysis.dataControls.documentationUrl} target="_blank" rel="noreferrer">OpenAI API data controls</a> · <a href={list.analysis.dataControls.promptCachingDocumentationUrl} target="_blank" rel="noreferrer">prompt caching details</a></p>}
          <p>Maximum 250 notes and 8 MiB total across this local desk; each note or imported file is limited to 128 KiB and 40,000 characters.</p>
        </aside>
        {loadState === "loading" && <p role="status">Loading private notes…</p>}
        {loadState === "error" && <div role="alert">Could not load saved private notes. Nothing was changed. <button type="button" onClick={() => void reload()}>Retry</button></div>}
        {loadState === "ready" && list && <>
          <p>{list.totalCount} saved {list.totalCount === 1 ? "note" : "notes"} for this issuer · {list.totalBytes.toLocaleString()} bytes here. Local desk limit: {MAX_ITEMS} notes / {MAX_TOTAL_BYTES.toLocaleString()} bytes total.</p>
          {!list.analysis.enabled && <p role="status">New GPT-6 Luna private-note analysis is currently blocked: {analysisGateMessage(list.analysis.blockedReason)} Any earlier attempt or saved result remains unchanged.</p>}
          {list.items.length === 0 ? <p>No private notes saved for this issuer.</p> : <ul aria-label="Saved private notes">
            {list.items.map((item) => <li key={item.id}>
              <button type="button" onClick={() => void selectEvidence(item)} disabled={busy} aria-label={`Open private note: ${safeDisclosureText(item.title)} · ${safeDisclosureText(item.sourceLabel)} · ${item.asOfDate ? `as of ${item.asOfDate}` : "date not provided"} · ID ${safeDisclosureText(item.id)}`}>{item.title}</button>
              <span> · {item.sourceLabel} · imported {formatImportedAt(item.importedAt)}{item.asOfDate ? ` · as of ${item.asOfDate}` : ""}</span>
            </li>)}
          </ul>}
        </>}
        {selected && <article aria-label={`Private note: ${selected.title}`}>
          <h3>{selected.title}</h3>
          <p>{selected.savedAnalysis
            ? "Stored locally · a GPT-6 Luna attempt was previously recorded for this item; see its saved outcome below."
            : "Private · stored locally · not sent for model analysis"} · {selected.sourceLabel}{selected.fileName ? ` · ${selected.fileName}` : ""}</p>
          <p>Imported {formatImportedAt(selected.importedAt)}{selected.asOfDate ? ` · user asserted as of ${selected.asOfDate}` : ""}</p>
          <p>Note ID: <code>{selected.id}</code> · SHA-256: <code>{selected.sha256}</code></p>
          <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{selected.content}</pre>
          {!selected.savedAnalysis && list?.analysis.enabled && <button type="button" disabled={busy} onClick={() => void analyzeSelected()}>Analyze this selected note with {list.analysis.model}</button>}
          {selected.savedAnalysis?.status === "in_progress" && <p role="status">A prior analysis attempt has no saved result. The app will not retry it automatically; check OpenAI usage before deciding what to do.</p>}
          {selected.savedAnalysis && selected.savedAnalysis.status !== "complete" && selected.savedAnalysis.status !== "in_progress" && <p role="alert">No analysis was saved ({selected.savedAnalysis.status === "outcome_unknown" ? "OpenAI may have processed the request" : "the request did not produce a usable result"}). The app will not send this note again, to avoid a duplicate charge.</p>}
          {selected.savedAnalysis?.status === "complete" && selected.savedAnalysis.record && <section aria-label="Private GPT-6 Luna note assessment">
            <h4>Private note assessment · {selected.savedAnalysis.record.modelReturned}</h4>
            <p>Direction described by this note: {selected.savedAnalysis.record.analysis.sentiment}. This is analyst-only and is not a public sentiment classification. A note is an owner assertion; Luna cannot authenticate its truth.</p>
            <p>{selected.savedAnalysis.record.analysis.summary}</p>
            {selected.savedAnalysis.record.analysis.evidence.length > 0 && <ul aria-label="Exact supporting excerpts">
              {selected.savedAnalysis.record.analysis.evidence.map((entry, index) => <li key={`${index}-${entry.quote}`}><blockquote>{entry.quote}</blockquote><p>{entry.explanation}</p></li>)}
            </ul>}
            <h5>Uncertainties</h5>
            <ul>{selected.savedAnalysis.record.analysis.uncertainties.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>
            <p><strong>Next analyst question:</strong> {selected.savedAnalysis.record.analysis.nextQuestion}</p>
            <p>Recorded usage: {selected.savedAnalysis.record.usage.inputTokens.toLocaleString()} input / {selected.savedAnalysis.record.usage.outputTokens.toLocaleString()} output tokens · estimated API cost ${selected.savedAnalysis.record.usage.estimatedCostUsd.toFixed(6)}. This private result is not included in any public chart, sentiment count, alert, or Jev history.</p>
          </section>}
          <button type="button" disabled={busy} aria-label={`Delete private note: ${selected.title}`} onClick={() => void remove(selected)}>Delete note</button>
        </article>}
        <form onSubmit={(event) => void save(event)}>
          <h3>Add a private note</h3>
          <label>Title <input required maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
          <label>Source or origin <input required maxLength={120} value={sourceLabel} onChange={(event) => setSourceLabel(event.target.value)} placeholder="For example: my research notes" /></label>
          <label>User-asserted date (optional) <input type="date" value={asOfDate} onChange={(event) => setAsOfDate(event.target.value)} /></label>
          <label>Import UTF-8 text file (.txt, .md, or .csv; optional) <input id={`private-evidence-file-${companyId}`} type="file" accept=".txt,.md,.csv,text/plain,text/markdown,text/csv" onChange={(event) => {
            const file = event.currentTarget.files?.[0]; if (!file) return;
            setFileName(null);
            void validateFile(file).then((value) => { setContent(value); setFileName(file.name); setTitle((current) => current || file.name.replace(/\.(txt|md|csv)$/i, "").slice(0, 120)); setError(null); }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Could not read file."));
          }} /></label>
          <label>Private note content <textarea required maxLength={MAX_CODE_POINTS * 2} value={content} onChange={(event) => { setContent(event.target.value); setFileName(null); }} rows={5} /></label>
          <p>{new TextEncoder().encode(content).length.toLocaleString()} / {MAX_BYTES.toLocaleString()} bytes · {[...content].length.toLocaleString()} / {MAX_CODE_POINTS.toLocaleString()} characters</p>
          <button type="submit" disabled={busy || loadState !== "ready"}>Save locally</button>
        </form>
        {error && <p role="alert">{error}</p>}
      </section>
    </details>
  );
}
