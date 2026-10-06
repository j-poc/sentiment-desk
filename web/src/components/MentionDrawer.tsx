import { useEffect, useRef, useState } from "react";
import type { JevAttemptSummary, Mention, MentionStatus } from "../lib/api.js";
import { getAnalystSourceReview, getJSON, retryMention, updateAnalystSourceReview } from "../lib/api.js";
import { MAX_ANALYST_RESEARCH_QUESTION_CHARS, type AnalystSourceReview } from "../../../shared/analyst-research.js";
import type { RetryAvailability } from "../lib/retryAvailability.js";
import { TAKEAWAY_LABEL } from "./MentionCard.js";
import { CategoricalJudgment } from "./CategoricalJudgment.js";
import { NEU, dayTime, fmtIndex, sentimentColor, timeAgo } from "../lib/format.js";
import { sourceClockForMention } from "../lib/source-clock.js";
import { differentPossessiveHeadlineSubject, otherExplicitTickerSymbols, sourceLinkPathNamesCompany } from "../lib/issuer-symbols.js";

function ScoreBar({ label, value, color }: { label: string; value: number; color: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <div className="flex items-center gap-2 py-[3px]">
      <span className="w-24 shrink-0 text-[10px] text-white/40">{label}</span>
      <span className="min-w-0 flex-1">
        <span className="block h-[5px] overflow-hidden rounded-full bg-white/[0.07]">
          <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
        </span>
      </span>
      <span className="tabnum w-9 shrink-0 text-right text-[10px] text-white/60">{pct}%</span>
    </div>
  );
}

type ScoreKey = "about" | "investorRelevant" | "material" | "novel" | "magnitude" | "surprise" | "credible";

const RUBRIC_ROWS: Array<{ key: ScoreKey; label: string }> = [
  { key: "about", label: "About company" },
  { key: "investorRelevant", label: "Investor relevant" },
  { key: "material", label: "Materiality" },
  { key: "novel", label: "Novelty" },
  { key: "magnitude", label: "Magnitude" },
  { key: "surprise", label: "Surprise" },
  { key: "credible", label: "Source credibility" },
];

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function linkHost(url: string): string {
  try {
    return new URL(url).hostname.toLocaleLowerCase("en-US").replace(/^www\./, "");
  } catch {
    return "host unavailable";
  }
}

function collectorLabel(collector: string): string {
  return collector === "google_news_rss" ? "Google News RSS" : collector;
}

function exactTimestamp(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(ms));
}

function mentionStatusLabel(status: MentionStatus): string {
  switch (status) {
    case "pending": return "Judgment pending";
    case "scoring": return "Classification in progress";
    case "retrying": return "Retry queued";
    case "scored": return "Historical Jev judgment";
    case "classified": return "Luna classification available";
    case "excluded": return "Excluded by classifier";
    case "review_required": return "Operator review required";
    case "off_target": return "Outside selected company";
    case "failed": return "Classification failed";
    case "corrupt": return "Saved judgment needs attention";
  }
}

type RetryState =
  | { type: "idle" }
  | { type: "confirming"; chargeConfirmed: boolean; usageReviewed: boolean }
  | { type: "submitting" }
  | { type: "accepted" }
  | { type: "failed"; message: string };

/**
 * The detail sidebar: everything the desk knows about one judgment, opened
 * from any mention row instead of demanding scroll space on the main screen.
 */
export function MentionDrawer({
  mention,
  onClose,
  retryAvailability,
  refreshWarning = false,
  onRetryRefresh,
  onOpenOperations,
  onReviewChanged,
  onOpenResearchQueue,
  tickerOf,
  knownTickers = [],
  companyNameOf,
}: {
  mention: Mention | null;
  onClose: () => void;
  retryAvailability: RetryAvailability;
  refreshWarning?: boolean;
  onRetryRefresh?: () => void;
  onOpenOperations?: () => void;
  onReviewChanged?: (review: AnalystSourceReview) => void;
  onOpenResearchQueue?: () => void;
  tickerOf?: (companyId: string) => string;
  knownTickers?: readonly string[];
  companyNameOf?: (companyId: string) => string;
}) {
  const providerLabel = retryAvailability.kind === "available" ? retryAvailability.providerLabel ?? "Jev" : "classifier";
  const providerName = retryAvailability.kind === "available" ? retryAvailability.providerName ?? "TypeSafe" : "provider";
  const dialogRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const [retryState, setRetryState] = useState<RetryState>({ type: "idle" });
  const [jevAttempts, setJevAttempts] = useState<JevAttemptSummary[] | null>(null);
  const [jevAttemptsFailed, setJevAttemptsFailed] = useState(false);
  const [analystReview, setAnalystReview] = useState<AnalystSourceReview | null>(null);
  const [analystQuestion, setAnalystQuestion] = useState("");
  const [analystReviewState, setAnalystReviewState] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [analystReviewSaving, setAnalystReviewSaving] = useState(false);
  const [analystReviewError, setAnalystReviewError] = useState<string | null>(null);
  const [analystReviewReload, setAnalystReviewReload] = useState(0);
  const currentMentionIdRef = useRef<string | null>(mention?.id ?? null);
  currentMentionIdRef.current = mention?.id ?? null;
  const otherTickers = mention && tickerOf
    ? otherExplicitTickerSymbols(`${mention.title} ${mention.snippet}`, tickerOf(mention.companyId), knownTickers)
    : [];
  const differentHeadlineSubject = mention && tickerOf && companyNameOf
    ? differentPossessiveHeadlineSubject(
      mention.title,
      mention.snippet,
      companyNameOf(mention.companyId),
      tickerOf(mention.companyId),
    )
    : null;
  const titleLinkConflict = mention && companyNameOf && differentHeadlineSubject
    ? sourceLinkPathNamesCompany(mention.source.url, companyNameOf(mention.companyId))
    : false;

  useEffect(() => {
    if (!mention) return;
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusFrame = requestAnimationFrame(() => closeButtonRef.current?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;

      const dialog = dialogRef.current;
      const focusable = [...(dialog?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter(
        (element) => !element.hasAttribute("hidden") && element.getAttribute("aria-hidden") !== "true",
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        e.preventDefault();
        dialog?.focus();
      } else if (e.shiftKey && (document.activeElement === first || !dialog?.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !dialog?.contains(document.activeElement))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", onKey, true);
      const target = returnFocusRef.current;
      if (target?.isConnected) requestAnimationFrame(() => target.focus());
    };
  }, [mention?.id, onClose]);

  useEffect(() => {
    setRetryState({ type: "idle" });
  }, [mention?.id, mention?.status, retryAvailability.kind]);

  useEffect(() => {
    if (!mention) {
      setAnalystReview(null);
      setAnalystQuestion("");
      setAnalystReviewState("idle");
      setAnalystReviewError(null);
      return;
    }
    const observationId = mention.id;
    const controller = new AbortController();
    let active = true;
    setAnalystReview(null);
    setAnalystQuestion("");
    setAnalystReviewSaving(false);
    setAnalystReviewState("loading");
    setAnalystReviewError(null);
    void getAnalystSourceReview(observationId, controller.signal).then(
      (review) => {
        if (!active || currentMentionIdRef.current !== observationId) return;
        setAnalystReview(review);
        setAnalystQuestion(review?.nextQuestion ?? "");
        setAnalystReviewState("ready");
      },
      () => {
        if (!active || controller.signal.aborted || currentMentionIdRef.current !== observationId) return;
        setAnalystReviewError("Your research note could not be loaded. It has not been changed.");
        setAnalystReviewState("failed");
      },
    );
    return () => { active = false; controller.abort(); };
  }, [mention?.id, mention?.analystResearchDispositionUpdatedAt, analystReviewReload]);

  const saveAnalystReview = async (disposition: "investigate" | "dismissed") => {
    if (!mention || analystReviewSaving) return;
    const observationId = mention.id;
    setAnalystReviewSaving(true);
    setAnalystReviewError(null);
    try {
      const review = await updateAnalystSourceReview(observationId, { disposition, nextQuestion: analystQuestion });
      if (currentMentionIdRef.current !== observationId) return;
      setAnalystReview(review);
      setAnalystQuestion(review.nextQuestion);
      setAnalystReviewState("ready");
      onReviewChanged?.(review);
    } catch {
      if (currentMentionIdRef.current === observationId) {
        setAnalystReviewError("Your changes did not save. Your question is still here; retry when the desk is available.");
      }
    } finally {
      if (currentMentionIdRef.current === observationId) setAnalystReviewSaving(false);
    }
  };

  useEffect(() => {
    if (!mention) return;
    let active = true;
    setJevAttempts(null);
    setJevAttemptsFailed(false);
    void getJSON<JevAttemptSummary[]>(`/api/mentions/${encodeURIComponent(mention.id)}/jev-attempts`).then(
      (attempts) => { if (active) setJevAttempts(attempts); },
      () => { if (active) setJevAttemptsFailed(true); },
    );
    return () => { active = false; };
  }, [mention?.id]);

  if (!mention) return null;
  const s = mention.score;
  const dir = s ? sentimentColor(s.sentiment) : NEU;
  const impactColor = s ? (s.impact > 0 ? "#34d399" : s.impact < 0 ? "#f87171" : NEU) : NEU;
  const sourceClock = sourceClockForMention(mention);

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" aria-hidden="true" onClick={onClose} />
      <aside
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mention-dialog-label"
        tabIndex={-1}
        className="fixed inset-y-0 right-0 z-50 flex w-[440px] max-w-[92vw] flex-col border-l border-desk-line bg-[#0b0d13] shadow-2xl"
        style={{ animation: "rise-in 0.18s ease-out" }}
      >
        <div className="panel-head shrink-0">
          <span id="mention-dialog-label" className="micro">Mention detail</span>
          <button
            ref={closeButtonRef}
            onClick={onClose}
            aria-label="Close mention details"
            className="tabnum rounded border border-white/10 px-2 py-[1px] text-[10px] text-white/50 hover:bg-white/[0.05]"
          >
            esc
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
          {refreshWarning && (
            <p className="mb-3 rounded border border-amber-300/20 bg-amber-200/[0.04] px-2.5 py-2 text-[11px] text-amber-100/80" role="alert">
              Some saved records could not be refreshed after reconnect. This detail may be out of date.{" "}
              <button type="button" className="underline underline-offset-2" onClick={onRetryRefresh}>Retry refresh</button>
            </p>
          )}
          <div className="flex items-center gap-2 text-[11px] text-desk-dim">
            <span
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{ background: dir }}
            />
            <span className="truncate">{mention.source.name}</span>
            <span className="text-white/20">·</span>
            {sourceClock.at == null
              ? <span className="tabnum">{sourceClock.label}</span>
              : <time className="tabnum" dateTime={new Date(sourceClock.at).toISOString()} title={`${sourceClock.context} ${new Date(sourceClock.at).toISOString()}`}>
                  {sourceClock.label} · {exactTimestamp(sourceClock.at)}
                </time>}
            <span className="text-white/20">·</span>
            <time dateTime={new Date(mention.retrievedAt).toISOString()} title={`Retrieved ${new Date(mention.retrievedAt).toISOString()}`}>collected {timeAgo(mention.retrievedAt)}</time>
          </div>
          <div className="mt-1 text-[10px] text-white/35">
            {mention.secDocumentContext ? "filing-evidence operation" : "source request receipt"} · {mention.source.deliveryId == null ? "unlinked · historical record" : mention.source.deliveryId.slice(0, 12)}
          </div>
          {mention.issuerIdentityStrong === false && (
            <div className="mt-2 rounded border border-amber-300/20 bg-amber-200/[0.04] px-2.5 py-2 text-[10.5px] leading-relaxed text-amber-100/80" role="note">
              Issuer identity is uncertain under the current text rule. This item matched a company name without enough distinctive issuer context; that does not prove it is unrelated. The original source remains saved and is available in Held matches and History.
            </div>
          )}
          {otherTickers.length > 0 && (
            <div className="mt-2 rounded border border-amber-300/20 bg-amber-200/[0.04] px-2.5 py-2 text-[10.5px] leading-relaxed text-amber-100/80" role="note">
              This record is filed under {tickerOf?.(mention.companyId)} and also names {otherTickers.join(", ")}. Confirm which company the source is about before treating it as issuer-specific evidence.
            </div>
          )}
          {differentHeadlineSubject && (
            <div className="mt-2 rounded border border-amber-300/20 bg-amber-200/[0.04] px-2.5 py-2 text-[10.5px] leading-relaxed text-amber-100/80" role="note">
              {titleLinkConflict
                ? `The headline leads with ${differentHeadlineSubject}, while the saved excerpt and URL path name ${companyNameOf?.(mention.companyId)}. Check that the headline and link belong together; the URL path does not verify page contents.`
                : `The headline leads with ${differentHeadlineSubject}, while the saved excerpt names ${companyNameOf?.(mention.companyId)}. Confirm the connection before treating it as issuer-specific evidence; this cue does not determine whether the article is relevant.`}
            </div>
          )}
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1.5 rounded-md border border-white/[0.07] bg-white/[0.02] px-2.5 py-2" role="group" aria-label="Source attribution">
            <div className="min-w-0">
              <div className="micro">reported publisher</div>
              <div className="truncate text-[10.5px] text-white/75" title={mention.publisherName || mention.source.publisher || mention.source.name}>
                {mention.publisherName || mention.source.publisher || mention.source.name}
              </div>
            </div>
            <div className="min-w-0">
              <div className="micro">reported domain</div>
              <div className="truncate text-[10.5px] text-white/75" title={mention.publisherDomain || mention.source.publisherDomain || "domain unavailable"}>
                {mention.publisherDomain || mention.source.publisherDomain || "domain unavailable"}
              </div>
            </div>
            <div className="min-w-0">
              <div className="micro">collector</div>
              <div className="truncate text-[10.5px] text-white/75" title={mention.collector}>{collectorLabel(mention.collector)}</div>
            </div>
            <div className="min-w-0">
              <div className="micro">saved link host</div>
              <div className="truncate text-[10.5px] text-white/75" title={mention.source.url}>{linkHost(mention.source.url)}</div>
            </div>
            <p className="col-span-2 text-[9.5px] leading-relaxed text-white/35">
              Publisher details are stored feed/provider attribution, not independent verification. The saved link may route through the collector.
            </p>
          </div>

          {s && s.takeaway !== "routine" && (
            <div className="mt-2 text-[12px] font-semibold uppercase tracking-wide" style={{ color: dir }}>
              {TAKEAWAY_LABEL[s.takeaway] ?? s.takeaway}
            </div>
          )}
          <h2 className={`font-semibold leading-snug text-desk-bright ${s && s.takeaway !== "routine" ? "mt-1 text-[13px] text-white/60" : "mt-2 text-[15px]"}`}>
            {mention.title}
          </h2>
          {mention.secDocumentContext && (() => {
            const context = mention.secDocumentContext!;
            const parent = context.documents.find((doc) => doc.role === "8k_primary");
            const selected = context.documents.find((doc) => doc.role === context.selectedRole && doc.url === context.selectedUrl);
            const selectionSummary = context.classificationInputStatus !== "ready"
              ? "No filing text selected"
              : context.selectedRole === "earnings_exhibit_99_1"
                ? "Earnings release selected from Item 2.02"
                : "Primary 8-K text selected";
            return <>
              <section className="mt-3 rounded-md border border-white/[0.09] bg-white/[0.025] px-3 py-2.5" aria-label="SEC filing status and selected documents">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="micro">Judgment status</span>
                  <span role="status" className="text-[11px] font-medium text-amber-100/85">{mentionStatusLabel(mention.status)}</span>
                  <span className="ml-auto text-[9.5px] text-white/40">{context.classificationInputStatus === "ready" ? "source input ready" : "source input incomplete"}</span>
                </div>
                <p className="mt-1.5 break-words text-[10.5px] text-white/55">8-K · accession {context.accessionNo}</p>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10.5px]">
                  {selected && <a className="underline underline-offset-2" href={selected.url} target="_blank" rel="noreferrer">Open selected {selected.role === "earnings_exhibit_99_1" ? "Exhibit 99.1" : "primary 8-K"}</a>}
                  {parent && <a className="underline underline-offset-2 text-white/65" href={parent.url} target="_blank" rel="noreferrer">Parent 8-K filing</a>}
                </div>
                {context.item202Link?.kind === "linked" && <p className="mt-1.5 text-[10px] leading-relaxed text-white/45">Item 2.02 identifies the selected results attachment: {context.item202Link.supportingText}</p>}
                <div className="mt-1.5 space-y-0.5 text-[10px] text-white/45">
                  <div>Filed {context.filedAt == null ? "unknown" : <time dateTime={new Date(context.filedAt).toISOString()}>{exactTimestamp(context.filedAt)}</time>}</div>
                  <div>SEC accepted <time dateTime={new Date(context.acceptedAt).toISOString()}>{exactTimestamp(context.acceptedAt)}</time></div>
                  {selected?.retrievedAt != null && <div>Retrieved <time dateTime={new Date(selected.retrievedAt).toISOString()}>{exactTimestamp(selected.retrievedAt)}</time></div>}
                </div>
                {mention.status === "pending" && onOpenOperations && (
                  <button
                    type="button"
                    aria-controls="desk-operations"
                    title="Open current source, classifier, and usage gates"
                    onClick={onOpenOperations}
                    className="mt-2 min-h-8 rounded border border-white/10 bg-white/[0.035] px-2.5 py-1 text-left text-[10.5px] text-white/70 hover:bg-white/[0.07] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300"
                  >
                    See why judgment is pending
                  </button>
                )}
              </section>
              {mention.snippet && mention.snippet !== mention.title && <details className="sec-document-excerpt mt-2 rounded-md border border-white/[0.08] px-3 py-2 text-[10.5px] text-white/60">
                <summary className="cursor-pointer select-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300">Read the selected SEC excerpt · {mention.snippet.length.toLocaleString()} characters</summary>
                <p className="mt-2 whitespace-pre-wrap break-words leading-relaxed">{mention.snippet}</p>
              </details>}
              <details className="mt-2 rounded-md border border-white/[0.08] px-3 py-2 text-[10.5px] text-white/60">
                <summary className="cursor-pointer select-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300">More filing evidence</summary>
                <div className="mt-2 space-y-2">
                  {context.item202Link?.kind === "linked" && <div>Item 2.02 attachment statement: <span className="text-white/75">{context.item202Link.supportingText}</span></div>}
                  {selected && <div><a className="underline" href={selected.url} target="_blank" rel="noreferrer">Text source: {selected.role === "earnings_exhibit_99_1" ? "Exhibit 99.1" : "Primary 8-K"}</a> · retrieved {selected.retrievedAt == null ? "unknown" : <time dateTime={new Date(selected.retrievedAt).toISOString()}>{exactTimestamp(selected.retrievedAt)}</time>}<div className="mt-1 break-words">body SHA-256 {selected.bodySha256 ?? "unavailable"}</div><p className="mt-1 whitespace-pre-wrap break-words">{selected.excerpt || mention.snippet || "No selected excerpt retained."}</p></div>}
                  {parent && <div><a className="underline" href={parent.url} target="_blank" rel="noreferrer">Parent 8-K filing</a> · retrieved {parent.retrievedAt == null ? "unknown" : <time dateTime={new Date(parent.retrievedAt).toISOString()}>{exactTimestamp(parent.retrievedAt)}</time>}<p className="mt-1 whitespace-pre-wrap break-words">{parent.excerpt || "No usable parent excerpt retained."}</p><div className="break-words">body SHA-256 {parent.bodySha256 ?? "unavailable"}</div></div>}
                  <div>{selectionSummary}</div>
                </div>
              </details>
            </>;
          })()}
          {!mention.secDocumentContext && mention.snippet && mention.snippet !== mention.title && (
            <p className="mt-2 text-[12px] leading-relaxed text-white/55">{mention.snippet}</p>
          )}

          <section className="mt-4 rounded-md border border-emerald-200/10 bg-emerald-100/[0.025] p-3" aria-label="Your research note">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="micro">Your research note</div>
              {analystReview?.disposition === "investigate" && <span className="text-[9.5px] text-emerald-200/70">In your queue</span>}
              {analystReview?.disposition === "dismissed" && <span className="text-[9.5px] text-white/40">Set aside from My Research and the default scan</span>}
            </div>
            <p className="mt-1 text-[10.5px] leading-relaxed text-white/45">
              Save this exact source record and your next check. This stays local and is never sent to a model or source.
            </p>
            {analystReviewState === "loading" && <p className="mt-2 text-[10.5px] text-white/40" role="status">Loading your saved note…</p>}
            {analystReviewState === "failed" && (
              <div className="mt-2" role="status">
                <p className="text-[10.5px] text-amber-100/75">{analystReviewError ?? "Your saved note could not be loaded."}</p>
                <button type="button" onClick={() => setAnalystReviewReload((current) => current + 1)} className="mt-1 rounded border border-white/15 px-2 py-1 text-[10px] text-white/65 hover:bg-white/[0.05]">Retry</button>
              </div>
            )}
            {analystReviewState === "ready" && (
              <>
                <label htmlFor="analyst-next-question" className="mt-2 block text-[10px] text-white/60">Next verification question <span className="text-white/35">(your words)</span></label>
                <textarea
                  id="analyst-next-question"
                  value={analystQuestion}
                  onChange={(event) => setAnalystQuestion(event.currentTarget.value)}
                  maxLength={MAX_ANALYST_RESEARCH_QUESTION_CHARS}
                  disabled={analystReviewSaving}
                  rows={3}
                  placeholder="What should you verify in the original source or another independent source?"
                  className="mt-1 min-h-20 w-full resize-y rounded border border-white/10 bg-black/20 px-2.5 py-2 text-[11px] leading-relaxed text-white/80 placeholder:text-white/25 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:opacity-60"
                />
                <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-[9.5px] text-white/35">
                  <span>{analystQuestion.length}/{MAX_ANALYST_RESEARCH_QUESTION_CHARS} characters</span>
                  <span>Not a verified finding or materiality judgment.</span>
                </div>
                {analystReviewError && <p className="mt-2 text-[10.5px] text-amber-100/80" role="alert">{analystReviewError}</p>}
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    disabled={analystReviewSaving}
                    onClick={() => void saveAnalystReview(analystReview?.disposition ?? "investigate")}
                    className="rounded border border-emerald-200/20 bg-emerald-100/[0.06] px-2.5 py-1.5 text-[10.5px] text-emerald-100/85 hover:bg-emerald-100/[0.1] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:cursor-wait disabled:opacity-50"
                  >
                    {analystReviewSaving ? "Saving…" : analystReview ? "Save note" : "Save to my research queue"}
                  </button>
                  {!analystReview && (
                    <button
                      type="button"
                      disabled={analystReviewSaving}
                      onClick={() => void saveAnalystReview("dismissed")}
                      className="rounded px-2 py-1.5 text-[10px] text-white/45 underline underline-offset-2 hover:text-white/70 disabled:opacity-50"
                      title="Sets this record aside from My Research and the default source scan; it does not change or delete the saved source."
                    >
                      {analystReviewSaving ? "Saving…" : "Set aside from my research and scan"}
                    </button>
                  )}
                  {analystReview?.disposition === "investigate" && (
                    <button type="button" disabled={analystReviewSaving} onClick={() => void saveAnalystReview("dismissed")} className="rounded px-2 py-1.5 text-[10px] text-white/45 underline underline-offset-2 hover:text-white/70 disabled:opacity-50">Set aside from My Research and scan</button>
                  )}
                  {analystReview?.disposition === "dismissed" && (
                    <button type="button" disabled={analystReviewSaving} onClick={() => void saveAnalystReview("investigate")} className="rounded px-2 py-1.5 text-[10px] text-white/60 underline underline-offset-2 hover:text-white/85 disabled:opacity-50">Restore to My Research and scan</button>
                  )}
                  {analystReview && onOpenResearchQueue && (
                    <button type="button" onClick={onOpenResearchQueue} className="ml-auto rounded px-2 py-1.5 text-[10px] text-white/50 underline underline-offset-2 hover:text-white/75">Open My Research</button>
                  )}
                </div>
              </>
            )}
          </section>

          {s ? (
            <>
              <div className="mt-4 flex items-center gap-3">
                <div>
                  <div className="micro">directional impact</div>
                  <div className="tabnum text-[26px] font-semibold" style={{ color: impactColor }}>
                    {fmtIndex(s.impact)}
                  </div>
                </div>
                <div className="text-[11px] leading-tight text-white/45">
                  <div style={{ color: dir }}>most likely class · {s.sentiment.toUpperCase()}</div>
                  <div>
                    event strength <span className="tabnum text-white/70">{Math.round(s.eventScore)}</span>
                  </div>
                </div>
                <div className="ml-auto text-right text-[10px] text-white/35">
                  <div className="tabnum">{s.latencyMs}ms Jev response</div>
                  <div className="tabnum">est. input ${s.estimatedInputCostUsd.toFixed(5)}</div>
                </div>
              </div>
              <p className="mt-2 text-[10.5px] leading-relaxed text-white/40">
                Impact is 100 × [P(positive) − P(negative)] impact points; the class is the most likely category. A neutral class can still carry directional impact.
              </p>
              <p className="mt-2 rounded border border-amber-200/10 bg-amber-100/[0.025] px-2.5 py-2 text-[10px] leading-relaxed text-amber-100/55" role="note">
                One historical model output, not a share-price move or an independent investor opinion. Jev quality and confidence calibration are unverified{mention.source.deliveryId == null ? "; this source has no linked delivery receipt." : "."}
              </p>

              <div className="mt-3 border-t border-white/[0.05] pt-2">
                {RUBRIC_ROWS.map((r) => {
                  const v = s[r.key as keyof typeof s];
                  const num = typeof v === "number" ? v : 0;
                  return <ScoreBar key={r.key} label={r.label} value={num} color={dir} />;
                })}
                <ScoreBar label="Confidence" value={s.confidence} color="#94a3b8" />
                <div className="mt-1 flex items-center justify-between text-[10px] text-white/35">
                  <span>
                    P(pos) <span className="tabnum">{Math.round(s.pPos * 100)}%</span> · P(neu){" "}
                    <span className="tabnum">{Math.round(s.pNeu * 100)}%</span> · P(neg){" "}
                    <span className="tabnum">{Math.round(s.pNeg * 100)}%</span>
                  </span>
                </div>
              </div>

              <div className="mt-3 border-t border-white/[0.05] pt-2 text-[10.5px] text-white/45">
                <div className="flex justify-between py-[2px]">
                  <span>engine</span>
                  <span className="tabnum text-white/70">{s.engine}</span>
                </div>
                <div className="flex justify-between py-[2px]">
                  <span>rubric</span>
                  <span className="tabnum text-white/70">{s.rubricSha.slice(0, 12)}…</span>
                </div>
                {mention.source.kind === "sec" && (
                  <div className="flex justify-between py-[2px]">
                    <span>filed (EDGAR)</span>
                    <span className="tabnum text-white/70">{mention.filedAt == null ? "unknown" : dayTime(mention.filedAt)}</span>
                  </div>
                )}
                <div className="flex justify-between py-[2px]">
                  <span>{mention.source.kind === "sec" ? "accepted (EDGAR)" : "publisher time"}</span>
                  <span className="tabnum text-white/70">{mention.publishedAt == null ? "unknown" : dayTime(mention.publishedAt)}</span>
                </div>
                {mention.providerObservedAt != null && (
                  <div className="flex justify-between py-[2px]">
                    <span>provider observed</span>
                    <span className="tabnum text-white/70">{dayTime(mention.providerObservedAt)}</span>
                  </div>
                )}
                <div className="flex justify-between py-[2px]">
                  <span>collected by desk</span>
                  <span className="tabnum text-white/70">{dayTime(mention.retrievedAt)}</span>
                </div>
                {mention.status === "off_target" && (
                  <div className="py-[2px] text-amber-400/80">excluded from every index (off-target)</div>
                )}
              </div>
            </>
          ) : mention.classification ? (
            <CategoricalJudgment judgment={mention.classification} detail />
          ) : (
            <div className="mt-4 text-[11.5px] text-white/40">
              {mention.status === "failed" || mention.status === "corrupt"
                ? `Scoring failed: ${mention.error ?? "unknown error"}`
                : mention.status === "retrying"
                  ? `Rate-limited; retry scheduled${mention.scoreRetryAt == null ? "" : ` for ${dayTime(mention.scoreRetryAt)}`}.`
                  : mention.status === "scoring"
                    ? "Classifying this item…"
                    : "Awaiting judgment…"}
            </div>
          )}

          <section className="mt-4 border-t border-white/[0.06] pt-2.5" aria-label="Classifier request history">
            <div className="micro">Classifier request history</div>
            <p className="mt-1 text-[9.5px] text-white/30">Exact request fingerprints and outcomes are saved; raw request bodies are not retained.</p>
            {jevAttemptsFailed && <div role="status" className="mt-2 text-[10.5px] text-amber-200/75">Request history could not be loaded. Refresh the desk and try again.</div>}
            {!jevAttemptsFailed && jevAttempts == null && <div role="status" className="mt-2 text-[10.5px] text-white/35">Loading request history…</div>}
            {jevAttempts?.length === 0 && (
              <div className="mt-2 text-[10.5px] text-white/40">
                {mention.status === "pending" ? "No classification request has been sent for this item." : "No request trace is stored for this item."}
              </div>
            )}
            {jevAttempts?.map((attempt) => {
              const outcome = attempt.outcome === "response" ? "response received"
                : attempt.outcome === "rejected" ? "request rejected"
                  : attempt.outcome === "unknown" ? "outcome unknown"
                    : attempt.outcome === "not_sent" ? "not sent"
                      : attempt.outcome === "dispatch_intent" ? "dispatch started"
                        : "prepared";
              return (
                <div key={attempt.attemptId} className="mt-2 rounded-md border border-white/[0.06] bg-white/[0.015] px-2.5 py-2 text-[10px]">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-white/50">attempt {attempt.attemptNumber}</span>
                    <span className={attempt.outcome === "response" ? "text-emerald-300/75" : attempt.outcome === "unknown" ? "text-amber-200/80" : "text-white/55"}>{outcome}</span>
                  </div>
                  <div className="mt-1 grid grid-cols-[6rem_1fr] gap-x-2 gap-y-0.5 text-white/35">
                    <span>requested model</span><span className="truncate text-right text-white/60">{attempt.requestedModel}</span>
                    <span>resolved model</span><span className="truncate text-right text-white/60">{attempt.resolvedModel ?? "unknown"}</span>
                    <span>request size</span><span className="tabnum text-right text-white/60">{attempt.requestBytes.toLocaleString()} bytes</span>
                    <span>HTTP result</span><span className="tabnum text-right text-white/60">{attempt.httpStatus == null ? "unknown" : attempt.httpStatus}</span>
                    <span>tokens</span><span className="tabnum text-right text-white/60">{attempt.inputTokens == null ? "unknown" : `${attempt.inputTokens} in / ${attempt.outputTokens ?? "?"} out`}</span>
                    {attempt.provider === "openai_luna" && <>
                      <span>service tier</span><span className="truncate text-right text-white/60">{attempt.serviceTier ?? "unknown"} · requested {attempt.serviceTierRequested ?? "unknown"}</span>
                      <span>cached / reasoning</span><span className="tabnum text-right text-white/60">{attempt.cachedInputTokens ?? "?"} / {attempt.reasoningTokens ?? "?"}</span>
                      <span>cache write</span><span className="tabnum text-right text-white/60">{attempt.cacheWriteInputTokens ?? "unknown"}</span>
                      <span>cost estimate</span><span className="tabnum text-right text-white/60">{attempt.estimatedCostUsd == null ? "unknown" : `$${attempt.estimatedCostUsd.toFixed(6)}`}</span>
                      <span>reserved cost</span><span className="tabnum text-right text-white/60">{attempt.reservedCostUsd == null ? "unknown" : `$${attempt.reservedCostUsd.toFixed(6)}`}</span>
                      <span>response ID</span><span className="truncate text-right text-white/60" title={attempt.responseId ?? undefined}>{attempt.responseId ?? "not recorded"}</span>
                      <span>schema SHA</span><code className="truncate text-right text-white/55" title={attempt.schemaSha256 ?? undefined}>{attempt.schemaSha256 ?? "not recorded"}</code>
                      <span>response SHA</span><code className="truncate text-right text-white/55" title={attempt.responseSha256 ?? undefined}>{attempt.responseSha256 ?? "not recorded"}</code>
                    </>}
                    <span>rubric SHA</span><code className="truncate text-right text-white/55" title={attempt.rubricSha256}>{attempt.rubricSha256}</code>
                    <span>request SHA</span><code className="truncate text-right text-white/55" title={attempt.requestSha256}>{attempt.requestSha256}</code>
                    {attempt.errorCategory && <><span>outcome detail</span><span className="truncate text-right text-amber-200/65">{attempt.errorCategory}</span></>}
                  </div>
                </div>
              );
            })}
          </section>

          {mention.status === "failed" && (
            <section className="mt-4 rounded-lg border border-amber-300/20 bg-amber-300/[0.05] p-3" aria-label={`Retry ${providerLabel} judgment`}>
              {retryAvailability.kind === "unavailable" && <p className="text-[11px] leading-relaxed text-amber-100/80">{retryAvailability.reason}</p>}
              {retryAvailability.kind === "available" && retryState.type === "idle" && (
                <button
                  type="button"
                  onClick={() => setRetryState({ type: "confirming", chargeConfirmed: false, usageReviewed: false })}
                  className="w-full rounded-md border border-amber-200/25 bg-amber-200/[0.08] px-3 py-2 text-[11px] font-medium text-amber-100 hover:bg-amber-200/[0.13] focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-200"
                >
                  Retry {providerLabel}
                </button>
              )}

              {retryAvailability.kind === "available" && retryState.type === "confirming" && (
                <div>
                  <p className="text-[11px] leading-relaxed text-amber-100/90">
                    This sends a new {providerLabel} request. {providerName} charges for model use, so another attempt may consume more credits.
                  </p>
                  {mention.usageCheckRequired && (
                    <p className="mt-2 text-[11px] leading-relaxed text-amber-200/80">
                      The earlier provider request did not produce a saved judgment. Check the account used for the earlier request before authorizing another attempt. The request history identifies its provider and model.
                    </p>
                  )}
                  <label className="mt-3 flex cursor-pointer items-start gap-2 text-[10.5px] leading-relaxed text-white/65">
                    <input
                      type="checkbox"
                      checked={retryState.chargeConfirmed}
                      onChange={(event) => setRetryState({ ...retryState, chargeConfirmed: event.currentTarget.checked })}
                      className="mt-0.5 accent-amber-300"
                    />
                    I understand this is a new request and may consume additional provider credits.
                  </label>
                  {mention.usageCheckRequired && (
                    <label className="mt-2 flex cursor-pointer items-start gap-2 text-[10.5px] leading-relaxed text-white/65">
                      <input
                        type="checkbox"
                        checked={retryState.usageReviewed}
                        onChange={(event) => setRetryState({ ...retryState, usageReviewed: event.currentTarget.checked })}
                        className="mt-0.5 accent-amber-300"
                      />
                      I checked provider usage for the earlier request.
                    </label>
                  )}
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={() => setRetryState({ type: "idle" })}
                      className="flex-1 rounded-md border border-white/10 px-2 py-1.5 text-[10.5px] text-white/55 hover:bg-white/[0.05]"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      disabled={!retryState.chargeConfirmed || (mention.usageCheckRequired && !retryState.usageReviewed)}
                      onClick={() => {
                        setRetryState({ type: "submitting" });
                        void retryMention(mention.id, {
                          confirmNewCharge: true,
                          reviewedProviderUsage: retryState.usageReviewed,
                        }).then(
                          () => setRetryState({ type: "accepted" }),
                          (error: unknown) => setRetryState({
                            type: "failed",
                            message: error instanceof Error ? error.message : "Classification retry failed. Refresh the desk and check provider usage before trying again.",
                          }),
                        );
                      }}
                      className="flex-1 rounded-md bg-amber-200/15 px-2 py-1.5 text-[10.5px] font-medium text-amber-100 enabled:hover:bg-amber-200/25 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      Send new {providerLabel} request
                    </button>
                  </div>
                </div>
              )}

              {retryAvailability.kind === "available" && retryState.type === "submitting" && <p role="status" className="text-[11px] text-amber-100/80">Sending the authorized request…</p>}
              {retryAvailability.kind === "available" && retryState.type === "accepted" && <p role="status" className="text-[11px] text-amber-100/80">Retry requested. Waiting for {providerLabel} to update this item.</p>}
              {retryAvailability.kind === "available" && retryState.type === "failed" && (
                <div role="alert" className="text-[11px] leading-relaxed text-amber-100/90">
                  <p>{retryState.message}</p>
                  <button type="button" onClick={() => setRetryState({ type: "idle" })} className="mt-2 underline underline-offset-2">Dismiss</button>
                </div>
              )}
            </section>
          )}
        </div>

        <div className="shrink-0 border-t border-desk-line p-3">
          <a
            href={mention.source.url}
            target="_blank"
            rel="noreferrer"
            className="block rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-center text-[11.5px] font-medium text-white/80 hover:bg-white/[0.07]"
          >
            {mention.collector === "google_news_rss" ? "Open Google News result ↗" : "Open saved source link ↗"}
          </a>
        </div>
      </aside>
    </>
  );
}
