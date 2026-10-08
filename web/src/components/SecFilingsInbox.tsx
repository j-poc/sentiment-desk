import { useCallback, useEffect, useMemo, useState } from "react";
import { activateSecFilingsInbox, getSecFilingsInbox, getSecIssuerFollowups, inspectSecFiling, removeSecIssuerFollowup, saveSecIssuerFollowup } from "../lib/api.js";
import { secFilingIdentity, secIssuerDisplayName, type SecFilingDetail, type SecFilingInboxRow, type SecFilingsInboxView, type SecIssuerFollowup } from "../../../shared/sec-filings-inbox.js";

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
};

export function secFreshnessLabel(freshness: SecFilingsInboxView["freshness"]): string {
  return freshness === "current" ? "Source freshness current"
    : freshness === "stale" ? "Source update is stale" : "Source freshness unknown";
}

export function secInboxStatusLabel(view: SecFilingsInboxView): string {
  return `${stateLabel[view.state]} · ${secFreshnessLabel(view.freshness)}`;
}

export function shouldShowDeskFallback(
  state: SecFilingsInboxView["state"] | null,
  rowCount: number,
  loadFailed: boolean,
  refreshPaused = false,
): boolean {
  return loadFailed
    || (rowCount === 0 && (state === "not_configured" || state === "unsupported" || state === "unavailable" || state === "failed"))
    || (rowCount > 0 && (state === "unavailable" || state === "unsupported" || (refreshPaused && (state === "stale" || state === "failed"))));
}

export function secInboxEmptyMessage(query: string, state: SecFilingsInboxView["state"] | undefined, savedRowCount: number): string {
  if (savedRowCount > 0) return query.trim() ? "No filings in this saved SEC snapshot match your filter." : "No filings are available in this snapshot.";
  if (query.trim()) return "Load a saved SEC filing snapshot before filtering it.";
  if (state === "empty") return "The SEC feed returned no Form 8-K filings in its latest 40-item window. Form 8-K/A amendments are not included.";
  if (state === "not_configured") return "Enable the SEC 8-K feed to load current filings.";
  if (state === "unsupported") return "This Public Data Hub does not support the SEC 8-K feed yet.";
  if (state === "unavailable") return "Reconnect the local Public Data Hub to load SEC filings.";
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
    return `The Desk cannot reach its registered local Public Data Hub. Start that Hub service, then choose Check Hub again. ${archiveNextStep}`;
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
  return `The no-ticker filing feed is unavailable. ${archiveNextStep}`;
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
): SecFilingsInboxView {
  if (!current?.rows.length || next.rows.length > 0
    || !["pending", "rate_limited", "failed", "unavailable", "unsupported", "not_configured"].includes(next.state)) return next;
  return {
    ...next,
    rows: current.rows,
    receiptId: current.receiptId,
    retrievedAt: current.retrievedAt,
    feedUpdatedAt: current.feedUpdatedAt,
    freshness: current.freshness,
  };
}

export function secIssuerRowAction(row: SecFilingInboxRow, saved: SecIssuerFollowup | undefined): "save" | "update" | "remove" {
  if (!saved) return "save";
  return saved.triggeringAccession === row.accession ? "remove" : "update";
}

export function SavedIssuerLeadsRetry({ retrying, onRetry }: { retrying: boolean; onRetry: () => void }) {
  return <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-amber-300/20 bg-amber-300/[0.05] px-4 py-3" role="alert">
    <p className="text-sm text-amber-100/80">Saved issuer leads could not be loaded.</p>
    <button type="button" onClick={onRetry} disabled={retrying} className="rounded border border-amber-100/20 px-3 py-1.5 text-xs font-medium text-amber-50 hover:bg-amber-100/[0.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-200 disabled:opacity-45">{retrying ? "Retrying…" : "Retry saved leads"}</button>
  </div>;
}

export function SecFilingsInbox({ onBrowseSavedSources, onOpenOperations, archiveStatus = "unknown" }: {
  onBrowseSavedSources?: () => void;
  onOpenOperations?: () => void;
  archiveStatus?: "available" | "empty" | "unknown";
}) {
  const [view, setView] = useState<SecFilingsInboxView | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(Date.now());
  const [followups, setFollowups] = useState<SecIssuerFollowup[]>([]);
  const [followupWorking, setFollowupWorking] = useState<string | null>(null);
  const [followupError, setFollowupError] = useState<string | null>(null);
  const [followupsLoadFailed, setFollowupsLoadFailed] = useState(false);
  const [followupsLoading, setFollowupsLoading] = useState(false);
  const [expandedFiling, setExpandedFiling] = useState<string | null>(null);
  const [detail, setDetail] = useState<SecFilingDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailLoadFailed, setDetailLoadFailed] = useState(false);

  const reload = useCallback(async (signal?: AbortSignal) => {
    try {
      const result = await getSecFilingsInbox(signal);
      setView(result);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    } finally {
      setLoading(false);
    }
  }, []);

  const reloadFollowups = useCallback(async (signal?: AbortSignal) => {
    setFollowupsLoading(true);
    try {
      setFollowups(await getSecIssuerFollowups(signal));
      setFollowupsLoadFailed(false);
      setFollowupError(null);
    } catch {
      setFollowupsLoadFailed(true);
    } finally {
      setFollowupsLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    void reloadFollowups(controller.signal);
    const poll = window.setInterval(() => { void reload(); }, 30_000);
    const clock = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => { controller.abort(); window.clearInterval(poll); window.clearInterval(clock); };
  }, [reload, reloadFollowups]);

  const saveIssuer = async (row: SecFilingInboxRow) => {
    setFollowupWorking(row.cik); setFollowupError(null);
    try {
      const saved = await saveSecIssuerFollowup(row.cik, row.accession);
      setFollowups((current) => [saved, ...current.filter((item) => item.cik !== saved.cik)]);
    } catch { setFollowupError(`Could not save ${row.issuer}. Confirm the filing is still in the current SEC inbox, then retry.`); }
    finally { setFollowupWorking(null); }
  };

  const removeIssuer = async (cik: string) => {
    setFollowupWorking(cik); setFollowupError(null);
    try { setFollowups(await removeSecIssuerFollowup(cik)); }
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
    setWorking(true);
    try {
      const result = await activateSecFilingsInbox();
      setView((current) => retainLastAcceptedFilings(current, result));
      setLoadFailed(false);
      if (result.state === "pending") window.setTimeout(() => { void reload(); }, 3000);
    } catch {
      setLoadFailed(true);
    } finally {
      setWorking(false);
    }
  };

  const cooldown = view?.nextRefreshAt ? Math.max(0, Date.parse(view.nextRefreshAt) - now) : 0;
  const showActivate = view?.canActivate === true
    && ["not_configured", "ready", "stale", "empty", "failed", "rate_limited"].includes(view.state);
  const showDeskFallback = shouldShowDeskFallback(view?.state ?? null, view?.rows.length ?? 0, loadFailed, view?.canActivate === false);
  const actionLabel = view?.state === "not_configured" ? "Enable real SEC feed"
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
            <button type="button" onClick={() => void activate()} disabled={working || loading || cooldown > 0}
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
      {followupError && <p className="rounded-md border border-amber-300/20 bg-amber-300/[0.05] px-4 py-3 text-sm text-amber-100/80" role="alert">{followupError}</p>}
      {followupsLoadFailed && <SavedIssuerLeadsRetry retrying={followupsLoading} onRetry={() => void reloadFollowups()} />}
      <section className="panel px-4 py-4 sm:px-5" aria-labelledby="sec-followups-title">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="sec-followups-title" className="text-sm font-medium text-white/80">Issuer research leads</h2>
          <span className="text-xs text-white/40">{followups.length} saved · CIK-based, not a security watchlist</span>
        </div>
        <p className="mt-1 text-xs leading-5 text-white/45">Save an issuer to revisit its filing. This shortlist does not imply a listed security, investment merit, or ongoing monitoring.</p>
        {followups.length > 0 && <ul className="mt-3 flex flex-col divide-y divide-white/[0.055]" aria-label="Saved issuer research leads">
          {followups.map((item) => <li key={item.cik} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
            <span className="min-w-0"><span className="text-white/80">{secIssuerDisplayName(item.issuer)}</span><span className="ml-2 font-mono text-xs text-white/40">CIK {item.cik}</span>
              <span className="ml-2 text-xs text-white/35">from {item.triggeringAccession}</span></span>
            <div className="flex items-center gap-3"><a href={item.filingUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="text-xs text-emerald-200/80 underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300">Open saved SEC filing page</a>
              <button type="button" onClick={() => void removeIssuer(item.cik)} disabled={followupWorking === item.cik} className="text-xs text-white/55 underline-offset-2 hover:text-white hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:opacity-40">{followupWorking === item.cik ? "Removing…" : "Remove"}</button></div>
          </li>)}
        </ul>}
      </section>
      {showDeskFallback && (
        <div className="flex flex-col gap-3 rounded-md border border-white/10 bg-white/[0.025] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-white/60">{view?.state === "not_configured"
            ? deskFallbackMessage(view.state, false, null, archiveStatus)
            : deskFallbackMessage(view?.state ?? null, loadFailed, view?.message, archiveStatus)}</p>
          <SecFilingsRecoveryActions archiveStatus={archiveStatus} onBrowseSavedSources={onBrowseSavedSources} onOpenOperations={onOpenOperations}
            showOperations={view?.state === "stale" || view?.state === "unavailable" || view?.state === "unsupported"} />
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
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <button type="button" aria-expanded={expandedFiling === secFilingIdentity(row)}
                      aria-controls={`sec-filing-detail-${secFilingIdentity(row)}`} onClick={() => toggleDetail(row)}
                      disabled={detailLoading && expandedFiling !== secFilingIdentity(row)}
                      className="inline-flex w-fit items-center rounded-md border border-emerald-300/25 bg-emerald-300/[0.055] px-3 py-2 text-xs font-medium text-emerald-100/85 hover:bg-emerald-300/[0.11] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:cursor-wait disabled:opacity-50">
                      {detailLoading && expandedFiling === secFilingIdentity(row) ? "Loading SEC evidence…" : expandedFiling === secFilingIdentity(row) ? "Hide disclosure" : "Inspect in Desk"}
                    </button>
                    {secIssuerRowAction(row, followups.find((item) => item.cik === row.cik)) === "remove"
                      ? <button type="button" onClick={() => void removeIssuer(row.cik)} disabled={followupWorking === row.cik} className="inline-flex w-fit items-center rounded-md border border-emerald-300/25 px-3 py-2 text-xs font-medium text-emerald-100/80 hover:bg-emerald-300/[0.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:opacity-40">{followupWorking === row.cik ? "Removing issuer…" : "Remove saved lead"}</button>
                      : secIssuerRowAction(row, followups.find((item) => item.cik === row.cik)) === "update"
                        ? <button type="button" onClick={() => void saveIssuer(row)} disabled={followupWorking !== null} className="inline-flex w-fit items-center rounded-md border border-emerald-300/25 px-3 py-2 text-xs font-medium text-emerald-100/80 hover:bg-emerald-300/[0.06] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:opacity-40">{followupWorking === row.cik ? "Updating lead…" : "Update saved filing"}<span className="sr-only"> to {row.accession}</span></button>
                      : <button type="button" onClick={() => void saveIssuer(row)} disabled={followupWorking !== null} className="inline-flex w-fit items-center rounded-md border border-white/10 px-3 py-2 text-xs font-medium text-white/70 hover:border-emerald-300/30 hover:text-emerald-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:cursor-wait disabled:opacity-40">{followupWorking === row.cik ? "Saving issuer…" : "Save issuer lead"}<span className="sr-only"> {secIssuerDisplayName(row.issuer)}, CIK {row.cik}</span></button>}
                    <a href={row.filingUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" className="inline-flex w-fit items-center rounded-md border border-white/10 px-3 py-2 text-xs font-medium text-white/70 hover:border-emerald-300/30 hover:text-emerald-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300">Open SEC filing page <span className="sr-only"> for {row.issuer}, accession {row.accession}</span></a>
                  </div>
                  {expandedFiling === secFilingIdentity(row) && <div id={`sec-filing-detail-${secFilingIdentity(row)}`} className="min-w-0 rounded-md border border-white/10 bg-black/20 px-3 py-4 sm:col-span-2 sm:px-4" aria-live="polite">
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
