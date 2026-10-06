import { useCallback, useEffect, useMemo, useState } from "react";
import { activateSecFilingsInbox, getSecFilingsInbox } from "../lib/api.js";
import type { SecFilingInboxRow, SecFilingsInboxView } from "../../../shared/sec-filings-inbox.js";

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

function isFilingRow(value: SecFilingInboxRow): boolean { return value.form === "8-K" || value.form === "8-K/A"; }

const stateLabel: Record<SecFilingsInboxView["state"], string> = {
  ready: "Current saved feed",
  stale: "Saved feed is stale",
  empty: "Verified empty feed",
  pending: "Collection in progress",
  rate_limited: "Refresh is rate-limited",
  failed: "Refresh failed",
  not_configured: "Feed not enabled",
  unsupported: "Feed not supported by this Hub",
  unavailable: "Hub unavailable",
};

export function shouldShowDeskFallback(
  state: SecFilingsInboxView["state"] | null,
  rowCount: number,
  loadFailed: boolean,
): boolean {
  return loadFailed || (rowCount === 0
    && (state === "not_configured" || state === "unsupported" || state === "unavailable" || state === "failed"));
}

export function deskFallbackMessage(
  state: SecFilingsInboxView["state"] | null,
  loadFailed: boolean,
  detail?: string | null,
): string {
  if (loadFailed || state === "unavailable") {
    return "The Desk cannot reach its local Public Data Hub. Check the Hub connection again, or search saved headlines and excerpts. The saved archive is historical evidence, not current market coverage.";
  }
  if (state === "unsupported") {
    return `${detail || "The filing feed is not supported by the current Hub configuration."} Configure the SEC 8-K feed in the Hub, then check again. Meanwhile, search saved headlines and excerpts; archive matches are historical leads, not current coverage.`;
  }
  if (state === "not_configured") {
    return "The SEC 8-K feed is not enabled for this Desk. Search saved headlines and excerpts while the feed is unavailable; archive matches are historical leads, not current coverage.";
  }
  if (state === "failed") {
    return "The last SEC filing collection failed. Search saved headlines and excerpts while the feed recovers; archive matches are historical leads, not current coverage.";
  }
  return "The no-ticker filing feed is unavailable. Search saved headlines and excerpts; archive matches are historical leads, not current coverage.";
}

export function retainLastAcceptedFilings(
  current: SecFilingsInboxView | null,
  next: SecFilingsInboxView,
): SecFilingsInboxView {
  if (!current?.rows.length || next.rows.length > 0
    || (next.state !== "pending" && next.state !== "rate_limited" && next.state !== "failed")) return next;
  return {
    ...next,
    rows: current.rows,
    receiptId: current.receiptId,
    retrievedAt: current.retrievedAt,
    feedUpdatedAt: current.feedUpdatedAt,
  };
}

export function SecFilingsInbox({ onBrowseSavedSources }: { onBrowseSavedSources?: () => void }) {
  const [view, setView] = useState<SecFilingsInboxView | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [query, setQuery] = useState("");
  const [now, setNow] = useState(Date.now());

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

  useEffect(() => {
    const controller = new AbortController();
    void reload(controller.signal);
    const poll = window.setInterval(() => { void reload(); }, 30_000);
    const clock = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => { controller.abort(); window.clearInterval(poll); window.clearInterval(clock); };
  }, [reload]);

  const rows = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    return (view?.rows ?? []).filter(isFilingRow).filter((row) => !needle
      || row.issuer.toLocaleLowerCase().includes(needle)
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
  const showDeskFallback = shouldShowDeskFallback(view?.state ?? null, view?.rows.length ?? 0, loadFailed);
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
            Browse the newest page of Form 8-K filings across issuers, then inspect the original SEC filing. This is at most 40 recent filings, not a complete universe, small-cap screen, or ranked opportunity list.
          </p>
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
            {loading ? "Checking saved feed…" : loadFailed ? "Desk could not read the feed status" : view ? stateLabel[view.state] : "Feed status unavailable"}
          </span>
        </div>
      </header>

      {view?.message && <p className={`rounded-md border px-4 py-3 text-sm ${view.state === "failed" || view.state === "unavailable" || view.state === "unsupported" ? "border-amber-300/20 bg-amber-300/[0.05] text-amber-100/80" : "border-white/10 bg-white/[0.025] text-white/60"}`} role="status">{view.message}</p>}
      {onBrowseSavedSources && showDeskFallback && (
        <div className="flex flex-col gap-3 rounded-md border border-white/10 bg-white/[0.025] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-white/60">{view?.state === "not_configured"
            ? deskFallbackMessage(view.state, false)
            : deskFallbackMessage(view?.state ?? null, loadFailed, view?.message)}</p>
          <button type="button" onClick={onBrowseSavedSources} className="w-fit shrink-0 rounded-md border border-white/15 px-3 py-2 text-sm font-medium text-white/75 hover:bg-white/[0.05] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300">
            Search saved archive
          </button>
        </div>
      )}
      {view?.state === "unavailable" && !view.canActivate && (
        <p className="rounded-md border border-white/10 bg-white/[0.025] px-4 py-3 text-xs leading-5 text-white/50">
          To enable this source, configure <code>EXTERNAL_REQUESTS_ENABLED=true</code> and add <code>sec_latest_filings_8k</code> to both source allowlists. Collection starts only after you activate it here.
        </p>
      )}

      {view && (view.retrievedAt || view.nextRefreshAt) && (
        <div className="flex flex-wrap gap-x-5 gap-y-1 px-1 text-xs text-white/45">
          {view.retrievedAt && <span>Hub retrieved this snapshot {age(view.retrievedAt, now)} · {utc(view.retrievedAt)}</span>}
          <span>Latest SEC Atom entry update: {view.feedUpdatedAt ? utc(view.feedUpdatedAt) : "not supplied"} · not a filing time</span>
          {view.nextRefreshAt && Date.parse(view.nextRefreshAt) > now && <span>Next manual refresh after {utc(view.nextRefreshAt)}</span>}
        </div>
      )}

      <div className="panel overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-desk-line px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div>
            <h2 className="text-sm font-medium text-white/80">Filing inbox</h2>
            <p className="mt-1 text-xs text-white/45">SEC dates and acceptance times are shown only when the feed explicitly supplies them. Feed update time is not a filing time.</p>
          </div>
          <label className="flex items-center gap-2">
            <span className="sr-only">Filter filings by issuer, CIK, or accession</span>
            <input value={query} onChange={(event) => setQuery(event.currentTarget.value)} type="search" maxLength={120}
              placeholder="Filter issuer, CIK, accession" className="w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/80 placeholder:text-white/30 focus:border-emerald-300/40 focus:outline-none sm:w-64" />
          </label>
          <span className="text-xs text-white/40" aria-live="polite">Showing {rows.length} of {view?.rows.length ?? 0}</span>
        </div>

        {loading && !view ? <p className="px-5 py-10 text-center text-sm text-white/45" role="status">Reading the saved SEC feed…</p>
          : rows.length === 0 ? (
            <p className="px-5 py-10 text-center text-sm text-white/50" role="status">
              {query.trim() ? "No filings match this filter." : view?.rows.length ? "No filings match this filter." : view?.state === "empty" ? "The verified feed contains no filings in its current window." : "No saved filing rows are available yet."}
            </p>
          ) : (
            <ol className="divide-y divide-white/[0.055]" aria-label="Recent SEC filings">
              {rows.map((row) => (
                <li key={row.accession} className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center sm:px-5">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="font-medium text-white/85">{row.issuer}</h3>
                      <span className="rounded border border-white/10 px-1.5 py-0.5 font-mono text-[10px] text-white/55">{row.form}</span>
                    </div>
                    <p className="mt-1 break-all font-mono text-[11px] text-white/40">Issuer CIK {row.cik} · Accession {row.accession}</p>
                    {row.accessionCik && row.accessionCik !== row.cik && (
                      <p className="mt-1 text-[11px] text-white/35">EDGAR login CIK {row.accessionCik}{row.filingCikPath ? ` · Archive path CIK ${row.filingCikPath}` : ""}</p>
                    )}
                    <p className="mt-1 text-xs text-white/50">Filed {utc(row.filedOn, true)} · Acceptance {row.acceptedAt ? utc(row.acceptedAt) : "time not supplied"}</p>
                  </div>
                  <a href={row.filingUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"
                    className="inline-flex w-fit items-center rounded-md border border-white/10 px-3 py-2 text-xs font-medium text-white/70 hover:border-emerald-300/30 hover:text-emerald-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300">
                    Open original SEC filing <span className="sr-only"> for {row.issuer}, accession {row.accession}</span>
                  </a>
                </li>
              ))}
            </ol>
          )}
      </div>
      <p className="px-1 text-[11px] leading-5 text-white/35">Unranked source browsing only. Issuer size, filing materiality, investment merit, and exhaustiveness are not inferred here.</p>
    </section>
  );
}
