import type { AnalystResearchQueueItem } from "../lib/api.js";
import { timeAgo } from "../lib/format.js";
import { sourceClockForMention } from "../lib/source-clock.js";

export type QueueState = "loading" | "ready" | "failed";

function judgmentLabel(item: AnalystResearchQueueItem): string {
  switch (item.mention.status) {
    case "classified": return "Luna classification";
    case "scored": return "Historical Jev judgment";
    case "off_target": return "Historical Jev · off-target";
    case "excluded": return "Luna · excluded";
    case "review_required": return "Luna review required";
    case "failed": return "Classification failed";
    case "corrupt": return "Judgment withheld";
    case "retrying": return "Retry queued";
    case "scoring": return "Classification in progress";
    case "pending": return "Judgment pending";
  }
}

function reportedTime(item: AnalystResearchQueueItem): string {
  const clock = sourceClockForMention(item.mention);
  return clock.at == null ? clock.label : `${clock.label} ${timeAgo(clock.at)}`;
}

function safeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function AnalystResearchQueueView({
  items,
  state,
  error,
  dismissBusyId,
  onOpenEvidence,
  onDismiss,
  onRetry,
}: {
  items: readonly AnalystResearchQueueItem[];
  state: QueueState;
  error: string | null;
  dismissBusyId: string | null;
  onOpenEvidence: (item: AnalystResearchQueueItem) => void;
  onDismiss: (item: AnalystResearchQueueItem) => void;
  onRetry: () => void;
}) {
  return (
    <section className="panel min-w-0" aria-labelledby="analyst-research-queue-heading">
      <div className="panel-head flex-wrap gap-y-1">
        <div className="min-w-0">
          <h1 id="analyst-research-queue-heading" className="micro m-0 p-0">MY RESEARCH QUEUE</h1>
          <p className="mt-1 text-[11px] normal-case tracking-normal text-white/45">
            Source records you chose to investigate. Ordered by your latest edit, not by company merit.
          </p>
        </div>
        {state === "ready" && <span className="tabnum text-[10px] text-white/45">{items.length} saved</span>}
      </div>

      {error && <p className="mx-3 mt-3 rounded border border-amber-300/20 bg-amber-200/[0.04] px-3 py-2 text-[11px] text-amber-100/80" role="alert">{error}</p>}

      {state === "loading" && <p className="px-3 py-5 text-[12px] text-white/50" role="status">Loading your saved research…</p>}
      {state === "failed" && (
        <div className="px-3 py-5 text-[12px] text-white/55" role="status">
          <p>The queue is unavailable. Your saved source records have not been changed.</p>
          <button type="button" onClick={onRetry} className="mt-2 rounded border border-white/15 px-2.5 py-1.5 text-[11px] text-white/75 hover:bg-white/[0.05]">
            Retry loading queue
          </button>
        </div>
      )}
      {state === "ready" && items.length === 0 && (
        <div className="px-3 py-6 text-[12px] text-white/55" role="status">
          <p>Your queue is empty. Open a saved source record in Desk to add an investigation question.</p>
          <p className="mt-1 text-[10.5px] text-white/35">No demo records are added. Saving a source creates no provider or model request.</p>
        </div>
      )}
      {state === "ready" && items.length > 0 && (
        <ol className="divide-y divide-white/[0.07]">
          {items.map((item) => (
            <li key={item.observationId} className="min-w-0 px-3 py-3 sm:px-4">
              <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10px] font-semibold text-white/75">{item.ticker}</span>
                <span className="min-w-0 break-words text-[11px] text-white/65">{item.companyName}</span>
                <span className="rounded border border-amber-200/15 px-1.5 py-0.5 text-[9px] text-amber-100/65">Analyst-selected</span>
                <span className="ml-auto text-[9.5px] text-white/35">saved {timeAgo(item.updatedAt)}</span>
              </div>

              <h2 className="mt-2 break-words text-[13px] font-medium leading-snug text-white/85">{item.mention.title}</h2>
              <div className="mt-1 flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-[10px] text-white/45">
                <span className="break-words">{item.mention.publisherName || item.mention.source.publisher || item.mention.source.name}</span>
                <span aria-hidden="true">·</span>
                <span>{judgmentLabel(item)}</span>
                <span aria-hidden="true">·</span>
                <span>{reportedTime(item)}</span>
                <span aria-hidden="true">·</span>
                <span>retrieved {timeAgo(item.mention.retrievedAt)}</span>
                <span aria-hidden="true">·</span>
                <span>{item.mention.source.deliveryId ? "receipt linked" : "receipt not linked"}</span>
              </div>

              <p className="mt-2 whitespace-pre-wrap break-words rounded border border-white/[0.06] bg-white/[0.02] px-2.5 py-2 text-[11px] leading-relaxed text-white/65">
                <span className="mr-1 font-medium text-white/40">Your next check:</span>
                {item.nextQuestion || <span className="italic text-white/35">No question saved.</span>}
              </p>

              <div className="mt-2 flex flex-wrap items-center gap-2">
                <button type="button" onClick={() => onOpenEvidence(item)} className="rounded border border-white/15 px-2.5 py-1.5 text-[10.5px] text-white/75 hover:bg-white/[0.05] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300">
                  Review source record
                </button>
                {safeHttpUrl(item.mention.source.url) && (
                  <a href={item.mention.source.url} target="_blank" rel="noreferrer" className="rounded px-2 py-1.5 text-[10.5px] text-white/50 underline underline-offset-2 hover:text-white/75">
                    Open saved source link
                  </a>
                )}
                <button type="button" onClick={() => onDismiss(item)} disabled={dismissBusyId != null} className="ml-auto rounded px-2 py-1.5 text-[10px] text-white/40 underline underline-offset-2 hover:text-white/65 disabled:opacity-40">
                  {dismissBusyId === item.observationId ? "Saving…" : "Set aside from queue"}
                </button>
              </div>
            </li>
          ))}
        </ol>
      )}

      <p className="border-t border-white/[0.07] px-3 py-2 text-[9.5px] leading-relaxed text-white/35 sm:px-4">
        These are your research notes, not verified findings, rankings, materiality judgments, or investment recommendations. Historical Jev and Luna statuses retain their original meanings.
      </p>
    </section>
  );
}
