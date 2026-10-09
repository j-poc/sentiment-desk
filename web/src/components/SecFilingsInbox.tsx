import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { activateSecFilingsInbox, getSecFilingsInbox, getSecFilingResearchTasks, inspectSecFiling, removeSecFilingResearchTask, saveSecFilingResearchTask } from "../lib/api.js";
import { secFilingResumeActionId, type SecFilingResumeTarget } from "../lib/sec-filing-resume.js";
import { secFilingIdentity, secFilingsFreshnessNextCheckMs, secFilingsSourceFreshness, secIssuerDisplayName, type SecFilingDetail, type SecFilingInboxRow, type SecFilingsInboxView, type SecFilingResearchTask } from "../../../shared/sec-filings-inbox.js";

function utc(value: string | null, dateOnly = false): string {
  if (!value) return dateOnly ? "Filing date not supplied" : "Not supplied";
  if (dateOnly) return value;
  return `${new Date(value).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC")}`;
}

function age(value: string | null, now: number): string {
  if (!value) return "time unavailable";
  const elapsed = Math.max(0, now - Date.parse(value));
  if (!Number.isFinite(elapsed)) return "time unavailable";
  if (elapsed < 60_000) return "just now";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m ago`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h ago`;
  return `${Math.floor(elapsed / 86_400_000)}d ago`;
}

function isFilingRow(value: SecFilingInboxRow): boolean { return value.form === "8-K"; }

const stateLabel: Record<SecFilingsInboxView["state"], string> = {
  ready: "Saved feed available",
  stale: "Saved snapshot is old",
  empty: "Verified empty feed",
  pending: "Collection in progress",
  rate_limited: "Refresh is rate-limited",
  failed: "Refresh failed",
  not_configured: "Feed not enabled",
  unsupported: "Feed not supported by this Hub",
  unavailable: "Hub unavailable",
  listing_unverified: "Issuer listing needs verification",
};

export function secFreshnessLabel(freshness: SecFilingsInboxView["freshness"]): string {
  return freshness === "current" ? "Source freshness current"
    : freshness === "stale" ? "Source update is stale" : "Source freshness unknown";
}

export function secListingVerificationSummary(view: SecFilingsInboxView): string | null {
  if (!view.listingVerificationGap || (view.rows.length === 0 && (view.withheldCount ?? 0) === 0)) return null;
  const clocks = view.listingDirectories?.map((directory) => `${directory.source.split("/").at(-1)} created ${utc(directory.createdAt)} / retrieved ${utc(directory.retrievedAt)}`).join(" · ");
  const aggregate = view.listingDirectoryCreatedAt ? `Directory created ${utc(view.listingDirectoryCreatedAt)}; retrieved ${utc(view.listingDirectoryRetrievedAt ?? null)}.` : "";
  return `Current exchange-listing verification · ${view.withheldCount ?? 0} withheld. ${view.listingVerificationGap}${aggregate ? ` ${aggregate}` : ""}${clocks ? ` ${clocks}` : ""}`;
}

export function secInboxStatusLabel(view: SecFilingsInboxView, now = Date.now()): string {
  return `${stateLabel[view.state]} · ${secFreshnessLabel(secFilingsSourceFreshness(view.feedUpdatedAt, now))}`;
}

export function shouldShowDeskFallback(
  state: SecFilingsInboxView["state"] | null,
  rowCount: number,
  loadFailed: boolean,
  refreshPaused = false,
): boolean {
  return loadFailed
    || (rowCount === 0 && (state === "not_configured" || state === "unsupported" || state === "unavailable" || state === "failed" || state === "listing_unverified"))
    || (rowCount > 0 && (state === "unavailable" || state === "unsupported" || state === "not_configured" || (refreshPaused && (state === "stale" || state === "failed"))));
}

export function secInboxEmptyMessage(query: string, state: SecFilingsInboxView["state"] | undefined, savedRowCount: number): string {
  if (savedRowCount > 0) return query.trim() ? "No filings in this saved SEC snapshot match your filter." : "No filings are available in this snapshot.";
  if (query.trim()) return "Load a saved SEC filing snapshot before filtering it.";
  if (state === "empty") return "The SEC feed returned no Form 8-K filings in its latest 40-item window. Form 8-K/A amendments are not included.";
  if (state === "not_configured") return "Enable the SEC 8-K feed to load current filings.";
  if (state === "unsupported") return "This Public Data Hub does not support the SEC 8-K feed yet.";
  if (state === "unavailable") return "Reconnect the local Public Data Hub to load SEC filings.";
  if (state === "listing_unverified") return "No SEC rows are shown because the app could not confirm a unique current listed-security match. Read the verification notice for the available next step.";
  if (state === "failed") return "The latest SEC collection failed and there is no accepted snapshot to show. Retry the feed to try again.";
  if (state === "pending") return "The first SEC filing collection is in progress.";
  return "No saved SEC filing snapshot is available yet.";
}

export function deskFallbackMessage(
  state: SecFilingsInboxView["state"] | null,
  loadFailed: boolean,
  detail?: string | null,
  archiveStatus: "available" | "empty" | "unknown" = "unknown",
): string {
  const archiveNextStep = archiveStatus === "available"
    ? "Search the saved archive for historical leads; those results are not current coverage."
    : archiveStatus === "empty"
      ? "This Desk has no eligible saved evidence to search yet."
      : "Saved archive availability has not been confirmed, so no archive search is offered.";
  if (loadFailed || (state === "unavailable" && !detail)) {
    return `${loadFailed ? "The Desk could not confirm" : "The Desk cannot reach"} its registered local Public Data Hub status. Check that Hub service, then choose Check Hub again. ${archiveNextStep}`;
  }
  if (state === "unsupported") {
    return `${detail || "The filing feed is not supported by the current Hub configuration."} Configure the SEC 8-K feed in the Hub, then check again. ${archiveNextStep}`;
  }
  if (state === "stale") {
    return `${detail || "The saved SEC snapshot is stale."} Refresh is paused for this Desk. Open Sources & operations to check the source gate and recovery step.`;
  }
  if (state === "not_configured") {
    return `The SEC 8-K feed is not enabled for this Desk. ${archiveNextStep}`;
  }
  if (state === "failed") {
    return `The last SEC filing collection failed. Retry the SEC feed after checking Hub status. ${archiveNextStep}`;
  }
  if (state === "unavailable" && detail) {
    return `${detail} ${archiveNextStep}`;
  }
  if (state === "listing_unverified") {
    return `${detail || "SEC rows are withheld until a unique current listed-security match is confirmed."} ${archiveNextStep}`;
  }
  return `The no-ticker filing feed is unavailable. ${archiveNextStep}`;
}

export function shouldStartSecFilingsPoll(activationInFlight: boolean): boolean {
  return !activationInFlight;
}

export function shouldOfferSecFilingsActivation(view: SecFilingsInboxView | null): boolean {
  return view?.canActivate === true
    && ["not_configured", "ready", "stale", "empty", "failed", "rate_limited", "listing_unverified"].includes(view.state);
}

export function isSecFilingsActivationCoolingDown(view: SecFilingsInboxView | null, now = Date.now()): boolean {
  if (!view || view.state === "listing_unverified" || !view.nextRefreshAt) return false;
  const nextRefreshAt = Date.parse(view.nextRefreshAt);
  return Number.isFinite(nextRefreshAt) && nextRefreshAt > now;
}

export function shouldOfferSavedArchiveSearch(archiveStatus: "available" | "empty" | "unknown", hasAction: boolean): boolean {
  return archiveStatus === "available" && hasAction;
}

export function SecFilingsRecoveryActions({ archiveStatus, onBrowseSavedSources, onOpenOperations, showOperations = false }: {
  archiveStatus: "available" | "empty" | "unknown";
  onBrowseSavedSources?: () => void;
  onOpenOperations?: () => void;
  showOperations?: boolean;
}) {
  return <div className="flex shrink-0 flex-wrap gap-2">
    {shouldOfferSavedArchiveSearch(archiveStatus, onBrowseSavedSources != null) && (
      <button type="button" onClick={onBrowseSavedSources} className="w-fit rounded-md border border-white/15 px-3 py-2 text-sm font-medium text-white/75 hover:bg-white/[0.05] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300">
        Search saved archive
      </button>
    )}
    {(showOperations || archiveStatus !== "available") && onOpenOperations && (
      <button type="button" onClick={onOpenOperations} className="w-fit rounded-md border border-white/15 px-3 py-2 text-sm font-medium text-white/75 hover:bg-white/[0.05] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300">
        Open Sources &amp; operations
      </button>
    )}
  </div>;
}

export function retainLastAcceptedFilings(
  current: SecFilingsInboxView | null,
  next: SecFilingsInboxView,
  now = Date.now(),
): SecFilingsInboxView {
  if (!current?.rows.length || next.rows.length > 0
    || !["pending", "rate_limited", "failed", "unavailable", "unsupported", "not_configured"].includes(next.state)) return next;
  if (!hasFreshListingEvidence(current, now)) return next;
  return {
    ...next,
    rows: current.rows,
    receiptId: current.receiptId,
    retrievedAt: current.retrievedAt,
    feedUpdatedAt: current.feedUpdatedAt,
    freshness: secFilingsSourceFreshness(current.feedUpdatedAt, now),
  };
}

function hasFreshListingEvidence(view: SecFilingsInboxView, now: number): boolean {
  const createdAt = view.listingDirectoryCreatedAt ? Date.parse(view.listingDirectoryCreatedAt) : NaN;
  const validSources = (sources: NonNullable<SecFilingsInboxView["listingDirectories"]>) => {
    if (sources.length !== 2) return false;
    const names = new Set<string>();
    return sources.every((source) => {
        try {
          const url = new URL(source.source);
          const retrieved = Date.parse(source.retrievedAt);
          const name = url.pathname.split("/").at(-1);
          if (url.protocol !== "https:" || url.hostname !== "www.nasdaqtrader.com" || !["nasdaqlisted.txt", "otherlisted.txt"].includes(name ?? "")
            || !Number.isFinite(retrieved) || retrieved > now || now - retrieved > 24 * 60 * 60 * 1000 || names.has(name!)) return false;
          names.add(name!);
          return true;
        } catch { return false; }
      }) && names.has("nasdaqlisted.txt") && names.has("otherlisted.txt");
  };
  return Number.isFinite(createdAt) && now >= createdAt && now - createdAt <= 24 * 60 * 60 * 1000 && validSources(view.listingDirectories ?? [])
    && view.rows.every((row) => row.listing && row.listing.directoryCreatedAt === view.listingDirectoryCreatedAt
      && validSources(row.listing.directories));
}

export function markSecFilingsRequestFailure(
  current: SecFilingsInboxView | null,
  message: string,
  now = Date.now(),
): SecFilingsInboxView | null {
  if (!current) return current;
  if (current.rows.length === 0 && (current.withheldCount ?? 0) === 0) {
    return { ...current, listingVerificationGap: null, freshness: secFilingsSourceFreshness(current.feedUpdatedAt, now), message };
  }
  if (!hasFreshListingEvidence(current, now)) {
    const withheldCount = current.rows.length + (current.withheldCount ?? 0);
    return { ...current, state: "listing_unverified", rows: [], withheldCount,
    listingVerificationGap: `${withheldCount} SEC filing${withheldCount === 1 ? " remains" : "s remain"} withheld because fresh current exchange-listing evidence is unavailable. ${current.canActivate ? "Retry the explicit listing check." : "Enable external requests and approve both SEC 8-K and Nasdaq directory sources in both source lists."}`,
    freshness: secFilingsSourceFreshness(current.feedUpdatedAt, now), message };
  }
  return {
    ...current,
    state: "failed",
    freshness: secFilingsSourceFreshness(current.feedUpdatedAt, now),
    message,
  };
}

type InboxViewUpdate = (
  value: SecFilingsInboxView | null | ((current: SecFilingsInboxView | null) => SecFilingsInboxView | null),
) => void;
type InboxBooleanUpdate = (value: boolean | ((current: boolean) => boolean)) => void;

export async function reloadSecFilingsInbox(
  fetch: (signal?: AbortSignal) => Promise<SecFilingsInboxView>,
  setView: InboxViewUpdate,
  setLoadFailed: InboxBooleanUpdate,
  setLoading: InboxBooleanUpdate,
  signal?: AbortSignal,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  try {
    const result = await fetch(signal);
    if (!isCurrent()) return;
    setView((current) => isCurrent() ? retainLastAcceptedFilings(current, result) : current);
    setLoadFailed((current) => isCurrent() ? false : current);
  } catch {
    if (!isCurrent()) return;
    setView((current) => {
      return isCurrent() ? markSecFilingsRequestFailure(current,
        "Could not confirm the latest saved SEC feed status. Showing the last accepted snapshot, if available.") : current;
    });
    setLoadFailed((current) => isCurrent() ? true : current);
  } finally {
    setLoading((current) => isCurrent() ? false : current);
  }
}

export function secIssuerRowAction(row: SecFilingInboxRow, saved: SecFilingResearchTask | undefined): "save" | "remove" {
  if (!saved) return "save";
  return saved.cik === row.cik && saved.triggeringAccession === row.accession ? "remove" : "save";
}

export function SavedFilingTasksRetry({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
  return <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-300/20 bg-amber-300/[0.05] px-4 py-3" role="alert">
    <p className="text-sm text-amber-100/80">Saved SEC filing tasks could not be loaded. Check Desk storage status, then retry after writable startup; saved work is unchanged.</p>
    <button type="button" onClick={onRetry} disabled={retrying} className="rounded border border-amber-100/20 px-3 py-1.5 text-xs font-medium text-amber-50 hover:bg-amber-100/[0.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-200 disabled:opacity-45">{retrying ? "Retrying…" : "Retry saved tasks"}</button>
  </div>;
}

export type SecFilingResumeState = "wait" | "open" | "rolled_out" | "stale" | "unavailable";

export function SavedSecFilingResumeCard({ target, detail, loading, failed, onInspect }: {
  target: SecFilingResumeTarget;
  detail: SecFilingDetail | null;
  loading: boolean;
  failed: boolean;
  onInspect: () => void;
}) {
  const row: SecFilingInboxRow = {
    cik: target.cik, accession: target.accession, issuer: target.issuer, form: "8-K",
    filedOn: null, acceptedAt: null, feedPublishedAt: null, feedUpdatedAt: null, filingUrl: target.filingUrl,
  };
  const matchingDetail = detail?.cik === row.cik && detail.accession === row.accession ? detail : null;
  return <section className="grid gap-3 rounded-md border border-white/10 bg-black/20 px-4 py-3" aria-labelledby="saved-sec-resume-heading">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 id="saved-sec-resume-heading" className="text-sm font-medium text-white/80">{secIssuerDisplayName(target.issuer)} · saved filing</h2>
        <p className="mt-1 break-all font-mono text-[11px] text-white/45">CIK {target.cik} · accession {target.accession}</p>
        {target.nextQuestion && <p className="mt-2 break-words text-xs leading-5 text-white/70"><span className="text-white/45">Research question: </span>{target.nextQuestion}</p>}
        <p className="mt-1 break-words text-[10px] text-white/35">Saved feed receipt {target.feedReceiptId} · observed {target.feedUpdatedAt ?? "unknown"} · retrieved {target.retrievedAt ?? "unknown"}</p>
      </div>
      <button id={secFilingResumeActionId(target, "rolled_out")} type="button" onClick={onInspect} disabled={loading} aria-controls="saved-sec-resume-evidence"
        className="inline-flex w-fit items-center rounded-md border border-emerald-300/25 bg-emerald-300/[0.055] px-3 py-2 text-xs font-medium text-emerald-100/85 hover:bg-emerald-300/[0.11] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:cursor-wait disabled:opacity-50">
        {loading ? "Loading SEC evidence…" : failed ? "Retry SEC evidence in Desk" : "Inspect saved filing in Desk"}
      </button>
    </div>
    {failed && <p className="text-sm text-amber-100/80" role="alert">The Desk could not load this exact filing. Your saved task and question are unchanged; retry or open the exact SEC source link above.</p>}
    <div id="saved-sec-resume-evidence" aria-live="polite">
      {loading && <p className="text-sm text-white/60" role="status">Checking this exact accession with SEC EDGAR…</p>}
      {!loading && matchingDetail && <SecFilingDetailPanel detail={matchingDetail} onRetry={onInspect} />}
    </div>
  </section>;
}

export function SecFilingInFeedResumeContext({ target, onInspect }: {
  target: SecFilingResumeTarget;
  onInspect: () => void;
}) {
  return <div className="grid gap-2">
    <p className="text-sm text-white/60">Exact filing selected from My Research. SEC document text has not been requested.</p>
    {target.nextQuestion
      ? <p className="break-words text-xs leading-5 text-white/70"><span className="text-white/45">Saved research question: </span>{target.nextQuestion}</p>
      : <p className="text-xs text-white/45">No research question was saved for this filing.</p>}
    <button id={secFilingResumeActionId(target, "open")} type="button" onClick={onInspect}
      className="mt-1 w-fit rounded-md border border-emerald-300/25 px-3 py-2 text-xs font-medium text-emerald-100/85 hover:bg-emerald-300/[0.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300">
      Inspect in Desk
    </button>
  </div>;
}

export function secFilingResumeState(target: SecFilingResumeTarget, view: SecFilingsInboxView | null, loading: boolean, loadFailed: boolean, now = Date.now()): SecFilingResumeState {
  if (view === null) return loading ? "wait" : loadFailed ? "unavailable" : "wait";
  if (view.state === "unavailable" || view.state === "unsupported" || loadFailed) return "unavailable";
  if (view.state !== "ready" || view.freshness !== "current" || secFilingsSourceFreshness(view.feedUpdatedAt, now) !== "current") return "stale";
  return view.rows.some((row) => row.cik === target.cik && row.accession === target.accession && isFilingRow(row)) ? "open" : "rolled_out";
}

export function secFilingQuestionValue(draft: string | undefined, saved: SecFilingResearchTask | undefined): string {
  return draft ?? saved?.nextQuestion ?? "";
}

export function SecFilingsInbox({ onBrowseSavedSources, onOpenOperations, archiveStatus = "unknown", resumeTarget = null, onResumeHandled }: {
  onBrowseSavedSources?: () => void;
  onOpenOperations?: () => void;
  archiveStatus?: "available" | "empty" | "unknown";
  resumeTarget?: SecFilingResumeTarget | null;
  onResumeHandled?: (requestId: number) => void;
}) {
  const [view, setView] = useState<SecFilingsInboxView | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(Date.now());
  const [followups, setFollowups] = useState<SecFilingResearchTask[]>([]);
  const [followupWorking, setFollowupWorking] = useState<string | null>(null);
  const [followupError, setFollowupError] = useState<string | null>(null);
  const [followupsLoadFailed, setFollowupsLoadFailed] = useState(false);
  const [followupsLoading, setFollowupsLoading] = useState(false);
  const [leadDrafts, setLeadDrafts] = useState<Record<string, string>>({});
  const [expandedFiling, setExpandedFiling] = useState<string | null>(null);
  const [detail, setDetail] = useState<SecFilingDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailLoadFailed, setDetailLoadFailed] = useState(false);
  const [resumeNotice, setResumeNotice] = useState<{ target: SecFilingResumeTarget; state: Exclude<SecFilingResumeState, "wait"> } | null>(null);
  const [pendingResumeFocusId, setPendingResumeFocusId] = useState<string | null>(null);
  const handledResumeRequest = useRef<number | null>(null);
  const latestInboxRequest = useRef(0);
  const activationInFlight = useRef(false);
  const mounted = useRef(true);

  const reload = useCallback(async (signal?: AbortSignal) => {
    const request = ++latestInboxRequest.current;
    await reloadSecFilingsInbox(getSecFilingsInbox, setView, setLoadFailed, setLoading, signal,
      () => request === latestInboxRequest.current);
  }, []);

  const reloadFollowups = useCallback(async (signal?: AbortSignal) => {
    setFollowupsLoading(true);
    try {
      setFollowups(await getSecFilingResearchTasks(signal));
      setFollowupsLoadFailed(false);
      setFollowupError(null);
    } catch {
      setFollowupsLoadFailed(true);
    } finally {
      setFollowupsLoading(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void reload(controller.signal);
    void reloadFollowups(controller.signal);
    const poll = window.setInterval(() => {
      if (shouldStartSecFilingsPoll(activationInFlight.current)) void reload();
    }, 30_000);
    const clock = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => { mounted.current = false; latestInboxRequest.current += 1; controller.abort(); window.clearInterval(poll); window.clearInterval(clock); };
  }, [reload, reloadFollowups]);

  useEffect(() => {
    if (!resumeTarget || handledResumeRequest.current === resumeTarget.requestId) return;
    const result = secFilingResumeState(resumeTarget, view, loading, loadFailed, now);
    if (result === "wait") return;
    handledResumeRequest.current = resumeTarget.requestId;
    setResumeNotice({ target: resumeTarget, state: result });
    setPendingResumeFocusId(secFilingResumeActionId(resumeTarget, result));
    setDetail(null);
    setDetailLoading(false);
    setDetailLoadFailed(false);
    if (result === "open") {
      setQuery("");
      setExpandedFiling(secFilingIdentity(resumeTarget));
      requestAnimationFrame(() => document.getElementById(`sec-filing-detail-${secFilingIdentity(resumeTarget)}`)?.scrollIntoView({ block: "nearest" }));
    } else {
      setExpandedFiling(null);
    }
    onResumeHandled?.(resumeTarget.requestId);
  }, [resumeTarget, view, loading, loadFailed, now, onResumeHandled]);

  useEffect(() => {
    if (!pendingResumeFocusId) return;
    const action = document.getElementById(pendingResumeFocusId);
    if (!action) return;
    action.focus({ preventScroll: true });
    action.scrollIntoView({ block: "nearest" });
    setPendingResumeFocusId(null);
  }, [pendingResumeFocusId, expandedFiling, resumeNotice]);

  useEffect(() => {
    const delay = secFilingsFreshnessNextCheckMs(view?.feedUpdatedAt ?? null, now);
    if (delay === null) return;
    const timer = window.setTimeout(() => setNow(Date.now()), delay);
    return () => window.clearTimeout(timer);
  }, [now, view?.feedUpdatedAt]);

  const saveIssuer = async (row: SecFilingInboxRow) => {
    const identity = `${row.cik}:${row.accession}`;
    setFollowupWorking(identity); setFollowupError(null);
    try {
      const existing = followups.find((item) => item.cik === row.cik && item.triggeringAccession === row.accession);
      const saved = await saveSecFilingResearchTask(row.cik, row.accession, secFilingQuestionValue(leadDrafts[identity], existing));
      setFollowups((current) => [saved, ...current.filter((item) => item.cik !== saved.cik || item.triggeringAccession !== saved.triggeringAccession)]);
    } catch { setFollowupError(`Could not save ${row.issuer} filing ${row.accession}. It may have left the current SEC feed, or local storage failed. Your question remains in this field.`); }
    finally { setFollowupWorking(null); }
  };

  const removeIssuer = async (cik: string, accession: string) => {
    const identity = `${cik}:${accession}`;
    setFollowupWorking(identity); setFollowupError(null);
    try { setFollowups(await removeSecFilingResearchTask(cik, accession)); }
    catch { setFollowupError("Could not remove the saved issuer lead. Reload and try again."); }
    finally { setFollowupWorking(null); }
  };

  const loadDetail = async (row: SecFilingInboxRow) => {
    setDetailLoading(true);
    setDetailLoadFailed(false);
    try {
      setDetail(await inspectSecFiling(row.cik, row.accession));
    } catch {
      setDetail(null);
      setDetailLoadFailed(true);
    } finally {
      setDetailLoading(false);
    }
  };

  const resumeSavedRow: SecFilingInboxRow | null = resumeNotice && resumeNotice.state !== "open" ? {
    cik: resumeNotice.target.cik, accession: resumeNotice.target.accession, issuer: resumeNotice.target.issuer, form: "8-K",
    filedOn: null, acceptedAt: null, feedPublishedAt: null, feedUpdatedAt: null, filingUrl: resumeNotice.target.filingUrl,
  } : null;

  const toggleDetail = (row: SecFilingInboxRow) => {
    const identity = secFilingIdentity(row);
    if (expandedFiling === identity) {
      setExpandedFiling(null);
      return;
    }
    setExpandedFiling(identity);
    if (detail?.accession !== row.accession || detail.cik !== row.cik) void loadDetail(row);
  };

  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return (view?.rows ?? []).filter(isFilingRow).filter((row) => !needle
      || secIssuerDisplayName(row.issuer).toLocaleLowerCase().includes(needle)
      || row.cik.includes(needle)
      || row.accession.includes(needle));
  }, [query, view?.rows]);

  const activate = async () => {
    const request = ++latestInboxRequest.current;
    const isCurrent = () => request === latestInboxRequest.current;
    activationInFlight.current = true;
    setWorking(true);
    try {
      const result = await activateSecFilingsInbox();
      if (!isCurrent()) return;
      setView((current) => isCurrent() ? retainLastAcceptedFilings(current, result) : current);
      setLoadFailed((current) => isCurrent() ? false : current);
      if (result.state === "pending") window.setTimeout(() => { if (isCurrent()) void reload(); }, 3000);
    } catch {
      setView((current) => isCurrent() ? markSecFilingsRequestFailure(current,
        "Could not start SEC filing refresh. Showing the last accepted snapshot, if available.") : current);
      setLoadFailed((current) => isCurrent() ? true : current);
    } finally {
      activationInFlight.current = false;
      if (mounted.current) setWorking(false);
    }
  };

  const cooldown = view?.nextRefreshAt ? Math.max(0, Date.parse(view.nextRefreshAt) - now) : 0;
  const activationCoolingDown = isSecFilingsActivationCoolingDown(view, now);
  const showActivate = shouldOfferSecFilingsActivation(view);
  const showDeskFallback = shouldShowDeskFallback(view?.state ?? null, view?.rows.length ?? 0, loadFailed, view?.canActivate === false);
  const actionLabel = view?.state === "not_configured" ? "Enable real SEC feed"
    : view?.state === "listing_unverified" ? "Verify current listings"
      : view?.state === "failed" ? "Retry SEC feed"
      : view?.state === "rate_limited" || cooldown > 0 ? "Refresh available later" : "Refresh filings";

  return (
    <section className="mx-auto flex w-full max-w-5xl flex-col gap-4 pb-10" aria-labelledby="sec-filings-title">
      <header className="panel flex flex-col gap-4 px-4 py-4 sm:flex-row sm:items-end sm:justify-between sm:px-6">
        <div className="min-w-0">
          <p className="micro text-emerald-300/75">REAL SEC DISCLOSURES · NO TICKER REQUIRED</p>
          <h1 id="sec-filings-title" className="mt-1 text-xl font-semibold text-white/90 sm:text-2xl">Recent 8-K filings</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-white/55">
            Browse up to the SEC feed’s latest 40 Form 8-K filings. Inspect a selected disclosure here, with its exact SEC source text and filing clocks; Form 8-K/A amendments are not included. This is not a complete issuer universe, a small-cap screen, or a ranked opportunity list.
          </p>
          <p className="mt-2 text-xs leading-5 text-white/40">Inspecting fetches one issuer metadata record and at most two linked SEC documents for the filing you choose. No text is sent to Luna or saved by this view.</p>
        </div>
        <div className="flex shrink-0 flex-col items-start gap-2 sm:items-end">
          {(loadFailed || view?.state === "unavailable" || view?.state === "unsupported") && (
            <button type="button" disabled={loading || working} onClick={() => { setLoading(true); void reload(); }} className="rounded border border-white/15 px-2.5 py-1.5 text-xs text-white/65 hover:bg-white/[0.05] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:cursor-wait disabled:opacity-50">
              {view?.state === "unsupported" ? "Check Hub configuration again" : "Check Hub again"}
            </button>
          )}
          {showActivate && (
            <button type="button" onClick={() => void activate()} disabled={working || loading || activationCoolingDown}
              className="rounded-md border border-emerald-300/30 bg-emerald-300/[0.09] px-3 py-2 text-sm font-medium text-emerald-100 hover:bg-emerald-300/[0.15] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:cursor-not-allowed disabled:opacity-45">
              {working ? "Contacting local Hub…" : actionLabel}
            </button>
          )}
          <span className="text-xs text-white/45" role="status" aria-live="polite">
            {loading ? "Checking saved feed…" : loadFailed ? "Desk could not read the feed status" : view ? secInboxStatusLabel(view) : "Feed status unavailable"}
          </span>
        </div>
      </header>

      {view?.message && <p className={`rounded-md border px-4 py-3 text-sm ${view.state === "failed" || view.state === "unavailable" || view.state === "unsupported" ? "border-amber-300/20 bg-amber-300/[0.05] text-amber-100/80" : "border-white/10 bg-white/[0.025] text-white/60"}`} role="status">{view.message}</p>}
      {view && secListingVerificationSummary(view) && <p className="rounded-md border border-amber-300/20 bg-amber-300/[0.045] px-4 py-3 text-xs leading-5 text-amber-100/75" role="status">{secListingVerificationSummary(view)}</p>}
      {resumeNotice && <div className={`rounded-md border px-4 py-3 text-sm ${resumeNotice.state === "open" ? "border-emerald-300/20 bg-emerald-300/[0.04] text-emerald-100/80" : "border-amber-300/20 bg-amber-300/[0.04] text-amber-100/80"}`} role="status" aria-live="polite">
        {resumeNotice.state === "open" ? <>Opened the exact filing from your saved task: CIK {resumeNotice.target.cik}, accession {resumeNotice.target.accession}. Your saved question is shown with the filing below. Choose “Inspect in Desk” to request SEC document evidence.</>
          : resumeNotice.state === "rolled_out" ? <>CIK {resumeNotice.target.cik}, accession {resumeNotice.target.accession} is no longer in the current SEC feed. Your saved question and receipt lineage remain in My Research.</>
            : resumeNotice.state === "stale" ? <>The SEC filing feed is stale or not ready, so the current feed cannot confirm CIK {resumeNotice.target.cik}, accession {resumeNotice.target.accession}. Your saved task is unchanged.</>
              : <>The SEC filing feed is unavailable, so the Desk cannot confirm CIK {resumeNotice.target.cik}, accession {resumeNotice.target.accession}. Your saved task is unchanged.</>}
        {resumeNotice.state !== "open" && <> <a href={resumeNotice.target.filingUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="underline underline-offset-2">Open this exact SEC filing</a></>}
      </div>}
      {resumeNotice && resumeNotice.state !== "open" && resumeSavedRow && <SavedSecFilingResumeCard target={resumeNotice.target} detail={detail}
        loading={detailLoading} failed={detailLoadFailed} onInspect={() => void loadDetail(resumeSavedRow)} />}
      {followupError && <p className="rounded-md border border-amber-300/20 bg-amber-300/[0.05] px-4 py-3 text-sm text-amber-100/80" role="alert">{followupError}</p>}
      {followupsLoadFailed && <SavedFilingTasksRetry retrying={followupsLoading} onRetry={() => void reloadFollowups()} />}
      <section className="panel px-4 py-4 sm:px-5" aria-labelledby="sec-followups-title">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="sec-followups-title" className="text-sm font-medium text-white/80">Saved filing tasks</h2>
          <span className="text-xs text-white/40">{followups.length} saved filings</span>
        </div>
        <p className="mt-1 text-xs leading-5 text-white/45">Save each filing with its own research question. A task does not imply a listed security, investment merit, or ongoing monitoring.</p>
        {followups.length > 0 && <ul className="mt-3 flex flex-col divide-y divide-white/[0.055]" aria-label="Saved SEC filing research tasks">
          {followups.map((item) => <li key={`${item.cik}:${item.triggeringAccession}`} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
            <span className="min-w-0"><span className="text-white/80">{secIssuerDisplayName(item.issuer)}</span><span className="ml-2 font-mono text-xs text-white/40">CIK {item.cik}</span>
              <span className="ml-2 break-all font-mono text-xs text-white/35">Accession {item.triggeringAccession}</span>
              {item.nextQuestion && <span className="mt-1 block break-words text-xs text-white/65">Next question: {item.nextQuestion}</span>}
              <span className="mt-1 block break-words text-[10px] text-white/35">Feed receipt {item.feedReceiptId} · observed {item.feedUpdatedAt ?? "unknown"} · retrieved {item.retrievedAt ?? "unknown"}</span>
            </span>
            <div className="flex flex-wrap items-center gap-3"><a href={item.filingUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="text-xs text-emerald-200/80 underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300">Resume at SEC filing</a>
              <button type="button" onClick={() => void removeIssuer(item.cik, item.triggeringAccession)} disabled={followupWorking === `${item.cik}:${item.triggeringAccession}`} className="text-xs text-white/55 underline-offset-2 hover:text-white hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:opacity-40">{followupWorking === `${item.cik}:${item.triggeringAccession}` ? "Removing…" : "Remove"}</button></div>
          </li>)}
        </ul>}
      </section>
      {showDeskFallback && (
        <div className="flex flex-col gap-3 rounded-md border border-white/10 bg-white/[0.025] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-white/60">{view?.state === "not_configured"
            ? deskFallbackMessage(view.state, false, null, archiveStatus)
            : deskFallbackMessage(view?.state ?? null, loadFailed, view?.message, archiveStatus)}</p>
          <SecFilingsRecoveryActions archiveStatus={archiveStatus} onBrowseSavedSources={onBrowseSavedSources} onOpenOperations={onOpenOperations}
            showOperations={view?.state === "stale" || view?.state === "unavailable" || view?.state === "unsupported" || view?.state === "not_configured"} />
        </div>
      )}
      {view && (view.retrievedAt || view.nextRefreshAt) && (
        <div className="flex flex-wrap gap-x-5 gap-y-1 px-1 text-xs text-white/45">
          {view.feedUpdatedAt && <span>SEC source updated {age(view.feedUpdatedAt, now)} · {utc(view.feedUpdatedAt)} · not a filing time</span>}
          {!view.feedUpdatedAt && <span>SEC source update time: not supplied</span>}
          {view.retrievedAt && <span>Hub retrieved this saved snapshot {age(view.retrievedAt, now)} · {utc(view.retrievedAt)}</span>}
          {view.nextRefreshAt && Date.parse(view.nextRefreshAt) > now && <span>Next manual refresh after {utc(view.nextRefreshAt)}</span>}
        </div>
      )}

      <div className="panel overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-desk-line px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div>
            <h2 className="text-sm font-medium text-white/80">Filing inbox</h2>
            <p className="mt-1 text-xs text-white/45">The saved feed does not always supply filing dates or EDGAR acceptance times. Inspect a filing to fetch the official metadata and document text.</p>
          </div>
          <label className="flex items-center gap-2">
            <span className="sr-only">Filter filings by issuer, CIK, or accession</span>
            <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} type="search" maxLength={120}
              placeholder="Filter issuer, CIK, accession" className="w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/80 placeholder:text-white/30 focus:border-emerald-300/40 focus:outline-none sm:w-64" />
          </label>
          <span className="text-xs text-white/40" aria-live="polite">Showing {rows.length} of {view?.rows.length ?? 0} filings</span>
        </div>

        {loading && !view ? <p className="px-5 py-10 text-center text-sm text-white/45" role="status">Reading the saved SEC feed…</p>
          : rows.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-white/50" role="status">
              {secInboxEmptyMessage(query, view?.state, view?.rows.length ?? 0)}
            </p>
          ) : (
            <ol className="divide-y divide-white/[0.055]" aria-label="Recent SEC filings">
              {rows.map((row) => (
                <li key={secFilingIdentity(row)} className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-5">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-medium text-white/85">{secIssuerDisplayName(row.issuer)}</h3>
                      <span className="rounded border border-white/10 px-1.5 py-0.5 font-mono text-[10px] text-white/55">{row.form}</span>
                    </div>
                    <p className="mt-1 break-all font-mono text-[11px] text-white/40">Issuer CIK {row.cik} · Accession {row.accession}</p>
                    {row.accessionCik && row.accessionCik !== row.cik && (
                      <p className="mt-1 text-[11px] text-white/35">EDGAR login CIK {row.accessionCik}{row.filingCikPath ? ` · Archive path CIK ${row.filingCikPath}` : ""}</p>
                    )}
                    <p className="mt-1 text-xs text-white/50">{row.filedOn ? `Filed ${utc(row.filedOn, true)}` : "Filing date not in feed"} · {row.acceptedAt ? `Accepted ${utc(row.acceptedAt)}` : "Acceptance time not in feed"}</p>
                    {row.listing && <p className="mt-1 text-[11px] text-emerald-200/65">Listed security {row.listing.symbol} · {row.listing.exchange} · {row.listing.securityName}</p>}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" aria-expanded={expandedFiling === secFilingIdentity(row)}
                      aria-controls={`sec-filing-detail-${secFilingIdentity(row)}`} onClick={() => toggleDetail(row)}
                      disabled={detailLoading && expandedFiling !== secFilingIdentity(row)}
                      className="inline-flex w-fit items-center rounded-md border border-emerald-300/25 bg-emerald-300/[0.055] px-3 py-2 text-xs font-medium text-emerald-100/85 hover:bg-emerald-300/[0.11] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:cursor-wait disabled:opacity-50">
                      {detailLoading && expandedFiling === secFilingIdentity(row) ? "Loading SEC evidence…" : expandedFiling === secFilingIdentity(row) ? "Hide disclosure" : "Inspect in Desk"}
                    </button>
                    <div className="grid min-w-0 gap-2 sm:col-span-2">
                      <label className="grid min-w-0 gap-1 text-[11px] text-white/50" htmlFor={`sec-next-question-${secFilingIdentity(row)}`}>Optional next research question
                        <textarea id={`sec-next-question-${secFilingIdentity(row)}`} rows={2} maxLength={500} value={secFilingQuestionValue(leadDrafts[`${row.cik}:${row.accession}`], followups.find((item) => item.cik === row.cik && item.triggeringAccession === row.accession))}
                          onChange={(event) => setLeadDrafts((current) => ({ ...current, [`${row.cik}:${row.accession}`]: event.currentTarget.value }))}
                          className="w-full min-w-0 resize-y rounded border border-white/10 bg-black/25 px-2.5 py-2 text-xs text-white/80 placeholder:text-white/30 focus:border-emerald-300/40 focus:outline-none" placeholder="What should I verify next?" />
                      </label>
                      <button type="button" onClick={() => void saveIssuer(row)} disabled={followupWorking !== null || (leadDrafts[`${row.cik}:${row.accession}`]?.length ?? 0) > 500} className="inline-flex w-fit items-center rounded-md border border-white/10 px-3 py-2 text-xs font-medium text-white/70 hover:border-emerald-300/30 hover:text-emerald-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:cursor-wait disabled:opacity-40">
                        {followupWorking === `${row.cik}:${row.accession}` ? "Saving filing task…" : followups.some((item) => item.cik === row.cik && item.triggeringAccession === row.accession) ? "Update saved research task" : "Save filing to My Research"}
                      </button>
                    </div>
                    <a href={row.filingUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="inline-flex w-fit items-center rounded-md border border-white/10 px-3 py-2 text-xs font-medium text-white/70 hover:border-emerald-300/30 hover:text-emerald-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300">Open SEC filing page <span className="sr-only"> for {row.issuer}, accession {row.accession}</span></a>
                  </div>
                  {expandedFiling === secFilingIdentity(row) && <div id={`sec-filing-detail-${secFilingIdentity(row)}`} className="min-w-0 rounded-md border border-white/10 bg-black/20 px-3 py-4 sm:col-span-2 sm:px-4" aria-live="polite">
                    {resumeNotice?.state === "open" && resumeNotice.target.cik === row.cik && resumeNotice.target.accession === row.accession && !detailLoading && !detailLoadFailed && !(detail?.accession === row.accession && detail.cik === row.cik) && <SecFilingInFeedResumeContext
                      target={resumeNotice.target} onInspect={() => void loadDetail(row)} />}
                    {detailLoading && <p className="text-sm text-white/60" role="status">Checking this exact accession with SEC EDGAR…</p>}
                    {detailLoadFailed && <div className="flex flex-wrap items-center justify-between gap-3" role="alert"><p className="text-sm text-amber-100/80">The Desk could not load SEC evidence. Retry or open the SEC filing page.</p><button type="button" onClick={() => void loadDetail(row)} className="rounded border border-white/15 px-3 py-2 text-xs text-white/75 hover:bg-white/[0.05] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300">Retry SEC evidence</button></div>}
                    {!detailLoading && !detailLoadFailed && detail?.accession === row.accession && detail.cik === row.cik && <SecFilingDetailPanel detail={detail} onRetry={() => void loadDetail(row)} />}
                  </div>}
                </li>
              ))}
            </ol>
          )}
      </div>
      <p className="px-1 text-[11px] leading-5 text-white/35">Unranked source browsing only. Issuer size, filing materiality, investment merit, and exhaustiveness are not inferred here.</p>
    </section>
  );
}

export function SecFilingDetailPanel({ detail, onRetry }: { detail: SecFilingDetail; onRetry: () => void }) {
  const date = (value: string | null, dateOnly = false) => value
    ? dateOnly ? value : utc(value)
    : "Not supplied by SEC";
  const outcomeText = (value: SecFilingDetail["state"]) => value === "ready" ? "Source text available"
    : value === "partial" ? "Partial source text" : value === "not_found" ? "Exact filing not found"
      : value === "paused" ? "SEC requests paused" : value === "rate_limited" ? "SEC rate limited this request" : "SEC request failed";
  return <div className="flex flex-col gap-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h4 className="text-sm font-semibold text-white/85">Disclosure evidence</h4><p className="mt-1 text-xs text-white/45">{outcomeText(detail.state)} · CIK {detail.cik} · accession {detail.accession}</p></div>
      {detail.state !== "ready" && <button type="button" onClick={onRetry} className="rounded border border-white/15 px-3 py-2 text-xs text-white/75 hover:bg-white/[0.05] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300">Retry SEC evidence</button>}
    </div>
    {detail.message && <p className="rounded border border-amber-300/15 bg-amber-300/[0.04] px-3 py-2 text-sm text-amber-50/75" role="status">{detail.message}</p>}
    <dl className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-2 text-xs sm:grid-cols-2">
      <div><dt className="text-white/40">Filed</dt><dd className="mt-0.5 text-white/75">{date(detail.filingDate, true)}</dd></div>
      <div><dt className="text-white/40">Accepted by EDGAR</dt><dd className="mt-0.5 break-words text-white/75">{date(detail.acceptedAt)}</dd></div>
      <div><dt className="text-white/40">Period of report · not an event date</dt><dd className="mt-0.5 text-white/75">{date(detail.reportDate, true)}</dd></div>
      <div><dt className="text-white/40">EDGAR metadata retrieved</dt><dd className="mt-0.5 break-words text-white/75">{date(detail.metadataRetrievedAt)}</dd></div>
    </dl>
    <div>
      <h5 className="text-xs font-semibold uppercase tracking-wide text-white/50">Reported 8-K items</h5>
      {detail.items.length ? <ul className="mt-2 flex flex-wrap gap-2">{detail.items.map((item, index) => <li key={`${item.code}-${index}`} className="rounded border border-white/10 px-2 py-1 text-xs text-white/70"><span className="font-mono">Item {item.code}</span>{item.label && <span className="ml-2">{item.label}</span>}</li>)}</ul>
        : <p className="mt-1 text-sm text-white/50">The SEC submissions record supplied no item codes.</p>}
    </div>
    <div className="flex flex-col gap-3">
      <h5 className="text-xs font-semibold uppercase tracking-wide text-white/50">SEC document text · source excerpts</h5>
      {detail.documents.length === 0 && <p className="text-sm text-white/50">No SEC document was retrieved. The filing page remains available below.</p>}
      {detail.documents.map((document, index) => <article key={`${document.role}-${document.url}-${index}`} className="min-w-0 rounded border border-white/[0.08] bg-white/[0.02] p-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2"><h6 className="text-sm font-medium text-white/80">{document.role === "8k_primary" ? "8-K primary document" : "Linked Exhibit 99.1"}</h6><span className="text-[11px] text-white/40">{document.outcome}{document.retrievedAt ? ` · retrieved ${date(document.retrievedAt)}` : " · retrieval time unavailable"}</span></div>
        {document.excerpt ? <blockquote className="mt-2 whitespace-pre-wrap break-words text-sm leading-6 text-white/70">{document.excerpt}</blockquote> : <p className="mt-2 text-sm text-white/45">No readable excerpt was returned for this document.</p>}
        {document.bodySha256 && <p className="mt-2 break-all font-mono text-[10px] text-white/35">SHA-256 {document.bodySha256}</p>}
        <a href={document.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="mt-2 inline-block text-xs text-emerald-200/80 underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300">Open exact SEC document</a>
      </article>)}
    </div>
    <a href={detail.filingUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="w-fit text-xs text-emerald-200/80 underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300">Open official filing index on SEC.gov</a>
  </div>;
}
