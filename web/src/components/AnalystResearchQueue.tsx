import { useEffect, useState } from "react";
import type { AnalystSourceReview } from "../../../shared/analyst-research.js";
import type { SecFilingResearchTask } from "../../../shared/sec-filings-inbox.js";
import type { AnalystResearchQueueItem, CompanyResearchDecisionQueueItem } from "../lib/api.js";
import { getAnalystResearchQueue, getCompanyResearchDecisionQueue, getSecFilingResearchTasks, removeSecFilingResearchTask, saveSecFilingResearchTask, updateAnalystSourceReview } from "../lib/api.js";
import { AnalystResearchQueueView, CompanyResearchDecisionQueueView, type DecisionQueueState, type QueueState } from "./AnalystResearchQueueView.js";

export function AnalystResearchQueue({
  refreshRevision,
  onReviewChanged,
  onOpenEvidence,
  onOpenResearchDecision,
  onResumeSecTask,
}: {
  refreshRevision: number;
  onReviewChanged: (review: AnalystSourceReview) => void;
  onOpenEvidence: (item: AnalystResearchQueueItem) => void;
  onOpenResearchDecision: (item: CompanyResearchDecisionQueueItem) => void;
  onResumeSecTask: (item: SecFilingResearchTask) => void;
}) {
  const [items, setItems] = useState<AnalystResearchQueueItem[]>([]);
  const [state, setState] = useState<QueueState>("loading");
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [dismissBusyId, setDismissBusyId] = useState<string | null>(null);
  const [decisionItems, setDecisionItems] = useState<CompanyResearchDecisionQueueItem[]>([]);
  const [decisionState, setDecisionState] = useState<DecisionQueueState>("loading");
  const [decisionRevision, setDecisionRevision] = useState(0);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setDecisionState("loading");
    setDecisionError(null);
    void getCompanyResearchDecisionQueue(controller.signal).then((result) => {
      if (!active) return;
      setDecisionItems(result.items);
      setDecisionState("ready");
    }, () => {
      if (!active || controller.signal.aborted) return;
      setDecisionError("The saved company-decision list could not be loaded.");
      setDecisionState("failed");
    });
    return () => { active = false; controller.abort(); };
  }, [refreshRevision, decisionRevision]);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState("loading");
    setError(null);
    void getAnalystResearchQueue(controller.signal).then(
      (result) => {
        if (!active) return;
        setItems(result.items);
        setState("ready");
      },
      () => {
        if (!active || controller.signal.aborted) return;
        setError("The saved research queue could not be loaded.");
        setState("failed");
      },
    );
    return () => { active = false; controller.abort(); };
  }, [refreshRevision, revision]);

  const dismiss = async (item: AnalystResearchQueueItem) => {
    if (dismissBusyId != null) return;
    setDismissBusyId(item.observationId);
    setError(null);
    try {
      const review = await updateAnalystSourceReview(item.observationId, {
        disposition: "dismissed",
        nextQuestion: item.nextQuestion,
      });
      onReviewChanged(review);
      setRevision((current) => current + 1);
    } catch {
      setError("This item remains in your queue. The change did not save; retry when the desk is available.");
    } finally {
      setDismissBusyId(null);
    }
  };

  return <div className="grid min-w-0 gap-3">
    <CompanyResearchDecisionQueueView
      items={decisionItems}
      state={decisionState}
      error={decisionError}
      onRetry={() => setDecisionRevision((current) => current + 1)}
      onOpen={onOpenResearchDecision}
    />
    <AnalystResearchQueueView
      items={items}
      state={state}
      error={error}
      dismissBusyId={dismissBusyId}
      onOpenEvidence={onOpenEvidence}
      onDismiss={(item) => void dismiss(item)}
      onRetry={() => setRevision((current) => current + 1)}
    />
    <SavedSecResearchTasks refreshRevision={revision} onResume={onResumeSecTask} />
  </div>;
}

export function SavedSecTaskResumeAction({ task, onResume }: { task: SecFilingResearchTask; onResume: (task: SecFilingResearchTask) => void }) {
  return <button type="button" onClick={() => onResume(task)} aria-label={`Resume SEC filing task for ${task.issuer}, CIK ${task.cik}, accession ${task.triggeringAccession} in Sentiment Desk`}
    className="text-xs text-emerald-200/80 underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300">Resume in Desk</button>;
}

export function SavedSecResearchTaskCard({
  item, value, busy, onChange, onResume, onSave, onRemove,
}: {
  item: SecFilingResearchTask;
  value: string;
  busy: boolean;
  onChange: (value: string) => void;
  onResume: (task: SecFilingResearchTask) => void;
  onSave: () => void;
  onRemove: () => void;
}) {
  return <li className="grid min-w-0 gap-2 px-3 py-3 sm:px-4">
    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      <span className="min-w-0 break-words text-xs text-white/80">{item.issuer}</span>
      <span className="font-mono text-[10px] text-white/45">CIK {item.cik}</span>
      <span className="break-all font-mono text-[10px] text-white/45">Accession {item.triggeringAccession}</span>
    </div>
    <p className="break-all text-[10px] text-white/35">Feed receipt {item.feedReceiptId} · observed {item.feedUpdatedAt ?? "unknown"} · retrieved {item.retrievedAt ?? "unknown"}</p>
    <label className="grid min-w-0 gap-1 text-[11px] text-white/50" htmlFor={`saved-sec-question-${item.cik}-${item.triggeringAccession}`}>Next research question (optional)
      <textarea id={`saved-sec-question-${item.cik}-${item.triggeringAccession}`} rows={2} maxLength={500} value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
        className="w-full min-w-0 resize-y rounded border border-white/10 bg-black/25 px-2.5 py-2 text-xs text-white/80 focus:border-emerald-300/40 focus:outline-none" />
    </label>
    <div className="flex flex-wrap items-center gap-3">
      <SavedSecTaskResumeAction task={item} onResume={onResume} />
      <a href={item.filingUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="text-xs text-emerald-200/80 underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300">Resume at exact SEC filing</a>
      <button type="button" onClick={onSave} disabled={busy || value.length > 500} className="rounded border border-white/15 px-2.5 py-1.5 text-[11px] text-white/75 hover:bg-white/[0.05] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:opacity-45">{busy ? "Saving…" : "Save question"}</button>
      <button type="button" onClick={onRemove} disabled={busy} className="text-xs text-white/45 underline-offset-2 hover:text-white/75 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:opacity-45">{busy ? "Working…" : "Remove task"}</button>
    </div>
  </li>;
}

function SavedSecResearchTasks({ refreshRevision, onResume }: { refreshRevision: number; onResume: (task: SecFilingResearchTask) => void }) {
  const [items, setItems] = useState<SecFilingResearchTask[]>([]);
  const [load, setLoad] = useState<"loading" | "ready" | "failed">("loading");
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [reloadRevision, setReloadRevision] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoad("loading");
    void getSecFilingResearchTasks(controller.signal).then((saved) => {
      if (!active) return;
      setItems(saved);
      setLoad("ready");
    }, () => {
      if (!active || controller.signal.aborted) return;
      setLoad("failed");
    });
    return () => { active = false; controller.abort(); };
  }, [refreshRevision, reloadRevision]);

  const identity = (item: SecFilingResearchTask) => `${item.cik}:${item.triggeringAccession}`;
  const save = async (item: SecFilingResearchTask) => {
    const key = identity(item);
    setBusy(key); setError(null);
    try {
      const saved = await saveSecFilingResearchTask(item.cik, item.triggeringAccession, drafts[key] ?? item.nextQuestion);
      setItems((current) => current.map((entry) => identity(entry) === key ? saved : entry));
      setDrafts((current) => { const next = { ...current }; delete next[key]; return next; });
    } catch {
      setError(`The question for SEC filing ${item.triggeringAccession} did not save. Your draft remains available; retry.`);
    } finally { setBusy(null); }
  };
  const remove = async (item: SecFilingResearchTask) => {
    const key = identity(item);
    setBusy(key); setError(null);
    try { setItems(await removeSecFilingResearchTask(item.cik, item.triggeringAccession)); }
    catch { setError(`Could not remove SEC filing ${item.triggeringAccession}. The saved task remains; retry.`); }
    finally { setBusy(null); }
  };

  return <section className="panel min-w-0" aria-labelledby="saved-sec-research-heading">
    <div className="panel-head flex-wrap gap-y-1">
      <div className="min-w-0">
        <h2 id="saved-sec-research-heading" className="micro m-0 p-0">SEC FILING TASKS</h2>
        <p className="mt-1 text-[11px] normal-case tracking-normal text-white/45">Exact accession, source page, and feed receipt clocks stay attached when the filing leaves the current feed.</p>
      </div>
      {load === "ready" && <span className="tabnum text-[10px] text-white/45">{items.length} saved</span>}
    </div>
    {error && <p className="mx-3 mt-3 rounded border border-amber-300/20 bg-amber-200/[0.04] px-3 py-2 text-[11px] text-amber-100/80" role="alert">{error}</p>}
    {load === "loading" && <p className="px-3 py-4 text-xs text-white/50" role="status">Loading saved SEC filing tasks…</p>}
    {load === "failed" && <div className="px-3 py-4 text-xs text-white/55" role="alert">
      <p>Saved SEC filing tasks could not be loaded. Check Desk storage status; after writable startup, retry to open this task list. Existing work has not been changed.</p>
      <button type="button" onClick={() => setReloadRevision((revision) => revision + 1)} className="mt-2 rounded border border-white/15 px-2.5 py-1.5 text-[11px] text-white/75 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300">Retry loading SEC tasks</button>
    </div>}
    {load === "ready" && items.length === 0 && <p className="px-3 py-5 text-xs text-white/50">No SEC filing tasks saved. Add one from a filing in Recent 8-K filings.</p>}
    {load === "ready" && items.length > 0 && <ol className="divide-y divide-white/[0.07]">
      {items.map((item) => {
        const key = identity(item);
        const value = drafts[key] ?? item.nextQuestion;
        return <SavedSecResearchTaskCard key={key} item={item} value={value} busy={busy === key}
          onChange={(nextValue) => setDrafts((current) => ({ ...current, [key]: nextValue }))}
          onResume={onResume} onSave={() => void save(item)} onRemove={() => void remove(item)} />;
      })}
    </ol>}
  </section>;
}
