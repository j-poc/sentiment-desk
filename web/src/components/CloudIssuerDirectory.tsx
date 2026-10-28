import { useEffect, useMemo, useRef, useState } from "react";
import { cloudSupabase } from "../lib/supabase.js";
import { cloudIssuerDirectoryStatus } from "../lib/cloud-issuer-directory-status.js";
import type { SecIssuerDirectoryEntry } from "../../../shared/sec-issuer-directory.js";

interface DirectorySearchRow extends SecIssuerDirectoryEntry {
  snapshot_id: string;
  retrieved_at: string;
  issuer_name: string;
}

interface SavedIssuer {
  id: string;
  cik: string;
  ticker: string;
  issuer_name: string;
  exchange: string | null;
  selected_snapshot_id: string;
  created_at: string;
}

function timestampLabel(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "time unknown";
  return `${new Date(value).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "")} UTC`;
}

export function CloudIssuerDirectory({ userId, onWorkspaceChanged }: { userId: string; onWorkspaceChanged: (issuer?: SavedIssuer) => Promise<void> }) {
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<DirectorySearchRow[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [searchRevision, setSearchRevision] = useState(0);
  const [saved, setSaved] = useState<SavedIssuer[]>([]);
  const [savedReadError, setSavedReadError] = useState<string | null>(null);
  const [savedLoading, setSavedLoading] = useState(true);
  const [retrievedAt, setRetrievedAt] = useState<string | null>(null);
  const [snapshotId, setSnapshotId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [refreshState, setRefreshState] = useState<"idle" | "ready" | "stale" | "unavailable">("idle");
  const [lastRefreshState, setLastRefreshState] = useState<"idle" | "failed" | "disabled" | "rate_limited">("idle");
  const [nextRefreshAt, setNextRefreshAt] = useState<string | null>(null);
  const automaticRefreshStarted = useRef(false);
  const headReadRevision = useRef(0);
  const savedReadRevision = useRef(0);
  const savedByCik = useMemo(() => new Map(saved.map((issuer) => [issuer.cik, issuer])), [saved]);

  const reloadSaved = async () => {
    if (!cloudSupabase) { setSavedLoading(false); return; }
    const revision = ++savedReadRevision.current;
    setSavedLoading(true);
    try {
      const { data, error: readError } = await cloudSupabase
        .from("user_research_issuers")
        .select("id,cik,ticker,issuer_name,exchange,selected_snapshot_id,created_at")
        .order("created_at", { ascending: false })
        .limit(500);
      if (readError) throw readError;
      if (revision === savedReadRevision.current) {
        setSaved((data ?? []) as SavedIssuer[]);
        setSavedReadError(null);
      }
    } catch (cause) {
      if (revision === savedReadRevision.current) setSavedReadError("My Research could not be loaded. Retry before changing your saved companies.");
      throw cause;
    } finally {
      if (revision === savedReadRevision.current) setSavedLoading(false);
    }
  };

  const reloadHead = async () => {
    if (!cloudSupabase) return;
    const revision = ++headReadRevision.current;
    const { data: head, error: headError } = await cloudSupabase
      .from("sec_issuer_directory_head")
      .select("snapshot_id,updated_at")
      .eq("dataset", "company_tickers_exchange")
      .maybeSingle();
    if (revision !== headReadRevision.current) return;
    if (headError) throw headError;
    if (!head) {
      setSnapshotId(null);
      setRetrievedAt(null);
      setRefreshState("unavailable");
      return;
    }
    const { data: snapshot, error: snapshotError } = await cloudSupabase
      .from("sec_issuer_directory_snapshots")
      .select("id,retrieved_at")
      .eq("id", head.snapshot_id)
      .maybeSingle();
    if (revision !== headReadRevision.current) return;
    if (snapshotError) throw snapshotError;
    if (!snapshot) throw new Error("Company list is unavailable.");
    setSnapshotId(snapshot.id);
    setRetrievedAt(snapshot.retrieved_at);
    setNextRefreshAt(null);
    const ageMs = Date.now() - Date.parse(snapshot.retrieved_at);
    setRefreshState(Number.isFinite(ageMs) && ageMs <= 24 * 60 * 60 * 1000 ? "ready" : "stale");
  };

  const search = async (searchTerm: string, signal?: AbortSignal): Promise<DirectorySearchRow[]> => {
    if (!cloudSupabase || searchTerm.trim().length < 2) {
      return [];
    }
    const { data, error: searchError } = await cloudSupabase.rpc("search_sec_issuer_directory", {
      query_text: searchTerm.trim(),
      max_results: 50,
    }).abortSignal(signal ?? new AbortController().signal);
    if (searchError) throw searchError;
    return ((data ?? []) as Array<Omit<DirectorySearchRow, "name">>).map((row) => ({
      cik: row.cik,
      ticker: row.ticker,
      name: row.issuer_name,
      issuer_name: row.issuer_name,
      exchange: row.exchange,
      snapshot_id: row.snapshot_id,
      retrieved_at: row.retrieved_at,
    }));
  };

  useEffect(() => {
    let active = true;
    setLoading(true);
    void Promise.all([reloadHead(), reloadSaved()]).then(() => {
      if (active) setError(null);
    }).catch(() => {
      if (active) setError("The company list could not be loaded. Try again.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; headReadRevision.current += 1; savedReadRevision.current += 1; };
  }, [userId]);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setRows([]);
    const normalizedQuery = query.trim();
    if (normalizedQuery.length < 2) {
      setSearching(false);
      setSearchError(false);
      return () => { active = false; controller.abort(); };
    }
    setSearchError(false);
    setSearching(true);
    const timer = setTimeout(() => {
      void search(query, controller.signal).then((nextRows) => {
        if (active) { setRows(nextRows); setSearchError(false); setError(null); setSearching(false); }
      }).catch(() => {
        if (active && !controller.signal.aborted) {
          setSearchError(true);
          setError("Company search is temporarily unavailable. Try again.");
          setSearching(false);
        }
      });
    }, 180);
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [query, snapshotId, searchRevision]);

  const refresh = async () => {
    if (!cloudSupabase || working) return;
    setWorking("refresh");
    setNotice(null);
    setError(null);
    setLastRefreshState("idle");
    try {
      const { data, error: invokeError } = await cloudSupabase.functions.invoke("refresh-sec-issuer-directory", {
        body: { requestKey: crypto.randomUUID() },
      });
      if (invokeError) {
        try { await reloadHead(); } catch { /* Keep the previous list status if readback is also unavailable. */ }
        setLastRefreshState("failed");
        setError("The company list could not be updated. Your saved list remains unchanged. Try again later.");
        return;
      }
      if (data?.state === "rate_limited") {
        setLastRefreshState("rate_limited");
        setNextRefreshAt(typeof data.nextAllowedAt === "string" ? data.nextAllowedAt : null);
        setNotice("The company list was updated recently. Try again later.");
      } else if (data?.state === "current") {
        setNotice("Your company list is up to date.");
      } else {
        setNotice("Your company list was updated.");
      }
      try {
        await reloadHead();
        if (data?.state === "rate_limited") {
          setLastRefreshState("rate_limited");
          setNextRefreshAt(typeof data.nextAllowedAt === "string" ? data.nextAllowedAt : null);
        }
      } catch {
        setError("The update finished, but the company list could not be read back. Try again.");
      }
    } catch {
      setLastRefreshState("failed");
      setError("The company list could not be updated. Your saved list remains unchanged. Try again later.");
    } finally {
      setWorking(null);
    }
  };

  useEffect(() => {
    if (loading || automaticRefreshStarted.current || (refreshState !== "unavailable" && refreshState !== "stale")) return;
    automaticRefreshStarted.current = true;
    void refresh();
  }, [loading, refreshState]);

  const save = async (entry: DirectorySearchRow) => {
    if (!cloudSupabase || working) return;
    setWorking(entry.cik);
    setNotice(null);
    setError(null);
    const { data, error: insertError } = await cloudSupabase
      .from("user_research_issuers")
      .insert({
        user_id: userId,
        cik: entry.cik,
        selected_snapshot_id: entry.snapshot_id,
        ticker: entry.ticker,
        issuer_name: entry.issuer_name,
        exchange: entry.exchange,
      })
      .select("id,cik,ticker,issuer_name,exchange,selected_snapshot_id,created_at")
      .maybeSingle();
    if (insertError) {
      if (insertError.code === "23505") setNotice("This company is already in My Research.");
      else setError("The company could not be saved. Refresh the company list and try again.");
    } else if (data) {
      setSaved((current) => [data as SavedIssuer, ...current]);
      setNotice("Company saved to My Research. Updates are not monitored automatically.");
      try { await onWorkspaceChanged(data as SavedIssuer); }
      catch { setError("Company saved, but its research view could not be refreshed. Try again."); }
    } else {
      setError("The company could not be confirmed as saved. Refresh My Research before trying again.");
    }
    setWorking(null);
  };

  const remove = async (issuer: SavedIssuer) => {
    if (!cloudSupabase || working) return;
    setWorking(issuer.cik);
    setNotice(null);
    setError(null);
    const { error: deleteError } = await cloudSupabase.from("user_research_issuers").delete().eq("id", issuer.id);
    if (deleteError?.code === "23503") setError("Issuer has saved research or follow history. Unfollow it first; saved research decisions are retained and cannot be removed here.");
    else if (deleteError) setError("Company could not be removed from My Research. Try again.");
    else {
      setSaved((current) => current.filter((item) => item.id !== issuer.id));
      setNotice("Company removed from My Research. Shared SEC information is unchanged.");
      try { await onWorkspaceChanged(); }
      catch { setError("Company removed, but the research view could not be refreshed. Try again."); }
    }
    setWorking(null);
  };

  const openResearch = async (issuer: SavedIssuer) => {
    setError(null);
    try { await onWorkspaceChanged(issuer); }
    catch { setError("The selected company research could not be opened. Try again."); }
  };

  const resultStatus = cloudIssuerDirectoryStatus({
    snapshotState: refreshState,
    refreshState: lastRefreshState,
    retrievedAt,
    loading,
  });

  const retry = async () => {
    if (loading || working != null) return;
    setLoading(true);
    try {
      await Promise.all([reloadHead(), reloadSaved()]);
      setError(null);
      setSearchRevision((revision) => revision + 1);
    } catch {
      setError("The company list could not be loaded. Try again.");
    } finally {
      setLoading(false);
    }
  };

  const retrySaved = async () => {
    if (working) return;
    setWorking("saved");
    try {
      await reloadSaved();
      setError(null);
    } catch {
      setError("My Research could not be loaded. Try again.");
    } finally {
      setWorking(null);
    }
  };

  return <div className="mx-auto w-full max-w-6xl space-y-4 pb-8 pt-5">
    <header className="panel px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="micro">SEC ISSUER RESEARCH</p>
          <h1 className="mt-1 text-lg font-semibold text-white/85">Find an issuer by name, ticker, or CIK</h1>
          <p className="mt-2 max-w-3xl text-xs leading-5 text-white/55">Search the SEC company ticker and exchange list. These are research leads; the list does not confirm an active listing, company size, or investment merit.</p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={working != null || loading} className="rounded-md border border-emerald-300/25 bg-emerald-300/[0.08] px-3 py-2 text-xs font-medium text-emerald-100/85 hover:bg-emerald-300/[0.14] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:cursor-not-allowed disabled:opacity-45">
          {working === "refresh" ? "Updating company list…" : "Refresh company list"}
        </button>
      </div>
      <div className="mt-3 rounded border border-white/[0.08] px-3 py-2 text-[10px] leading-4 text-white/45">
        Source: <a className="text-sky-200/75 underline" href="https://www.sec.gov/files/company_tickers_exchange.json" target="_blank" rel="noreferrer">SEC company ticker and exchange list</a> · {resultStatus}. The time shown is when the list was retrieved.
      </div>
      {nextRefreshAt && <p className="mt-2 text-[10px] text-white/40">Next refresh available: {timestampLabel(nextRefreshAt)}</p>}
      {(error || notice) && <p className="mt-3 text-xs leading-5 text-amber-100/75" role={error ? "alert" : "status"}>{error ?? notice}</p>}
      {error && <button type="button" disabled={working != null || loading} onClick={() => void retry()} className="mt-2 rounded border border-white/15 px-2.5 py-1.5 text-[10px] text-white/65 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:opacity-45">Try again</button>}
    </header>

    <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)]">
      <section className="panel min-w-0" aria-labelledby="cloud-issuer-search-heading">
        <div className="panel-head"><h2 id="cloud-issuer-search-heading" className="micro m-0 p-0">ISSUER SEARCH</h2><span className="tabnum text-[10px] text-white/40">{lastRefreshState === "idle" ? refreshState : lastRefreshState}</span></div>
        <div className="space-y-3 p-3 sm:p-4">
          <label className="block text-[11px] text-white/55">Issuer name, ticker, or CIK
            <input type="search" value={query} maxLength={120} onChange={(event) => setQuery(event.target.value)} placeholder="For example: semiconductor, NVDA, or 0001045810" className="mt-1.5 w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/85 outline-none focus-visible:border-emerald-300/50 focus-visible:ring-2 focus-visible:ring-emerald-300/25" aria-describedby="cloud-issuer-search-help" />
          </label>
          <p id="cloud-issuer-search-help" className="text-[10px] leading-4 text-white/40">At least two characters · up to 50 matches · no size ranking or recommendation.</p>
          {query.trim().length < 2 ? <p className="text-xs text-white/45">Enter a company name, ticker, or CIK to search.</p>
            : rows.length === 0 ? <p className={`text-xs ${searchError ? "text-amber-100/70" : "text-white/45"}`} role={searching ? "status" : searchError ? "alert" : undefined}>{searching ? "Searching the SEC company list…" : searchError ? "Company search could not finish. Try the company list again." : loading ? "Loading company list…" : refreshState === "unavailable" ? "The company list is temporarily unavailable. Try again later." : "No companies match this search."}</p>
              : <ul className="space-y-2">{rows.map((entry) => <li key={`${entry.cik}:${entry.ticker}`} className="flex flex-wrap items-center justify-between gap-3 rounded border border-white/[0.08] px-3 py-2.5">
                <div className="min-w-0"><p className="truncate text-xs font-medium text-white/80">{entry.name} <span className="font-mono text-white/45">{entry.ticker}</span></p><p className="mt-1 font-mono text-[10px] text-white/40">CIK {entry.cik} · {entry.exchange ?? "exchange not supplied"}</p></div>
                {savedByCik.has(entry.cik)
                  ? <button type="button" disabled={working != null} onClick={() => void openResearch(savedByCik.get(entry.cik)!)} className="rounded border border-emerald-300/20 px-2.5 py-1.5 text-[10px] text-emerald-100/75 hover:bg-emerald-300/[0.05] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:cursor-not-allowed disabled:opacity-40">Open research</button>
                  : <button type="button" disabled={working != null} onClick={() => void save(entry)} className="rounded border border-white/15 px-2.5 py-1.5 text-[10px] text-white/65 hover:bg-white/[0.05] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:cursor-not-allowed disabled:opacity-40">{working === entry.cik ? "Saving…" : "Add to My Research"}</button>}
              </li>)}</ul>}
        </div>
      </section>

      <section className="panel min-w-0" aria-labelledby="cloud-saved-issuers-heading">
        <div className="panel-head"><h2 id="cloud-saved-issuers-heading" className="micro m-0 p-0">MY RESEARCH</h2><span className="tabnum text-[10px] text-white/40">{savedReadError ? "unavailable" : `${saved.length} / 500`}</span></div>
        {savedLoading ? <p className="p-4 text-xs leading-5 text-white/45" role="status">Loading My Research…</p>
          : savedReadError ? <div className="space-y-2 p-4"><p className="text-xs leading-5 text-amber-100/75" role="alert">Saved companies could not be confirmed. They have not been removed.</p><button type="button" disabled={working != null} onClick={() => void retrySaved()} className="rounded border border-white/15 px-2.5 py-1.5 text-[10px] text-white/65 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:opacity-45">{working === "saved" ? "Reloading My Research…" : "Reload My Research"}</button></div>
          : saved.length === 0 ? <p className="p-4 text-xs leading-5 text-white/45">No companies in My Research yet. Adding one saves its public SEC identity and does not start monitoring.</p>
          : <ul className="divide-y divide-white/[0.06]">{saved.map((issuer) => <li key={issuer.id} className="flex items-center justify-between gap-3 p-3">
            <div className="min-w-0"><p className="truncate text-xs font-medium text-white/80">{issuer.issuer_name} <span className="font-mono text-white/45">{issuer.ticker}</span></p><p className="mt-1 font-mono text-[10px] text-white/40">CIK {issuer.cik} · saved {timestampLabel(issuer.created_at)}</p></div>
            <div className="flex shrink-0 gap-2">
              <button type="button" disabled={working != null} onClick={() => void openResearch(issuer)} className="rounded border border-emerald-300/20 px-2.5 py-1.5 text-[10px] text-emerald-100/75 hover:bg-emerald-300/[0.05] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:opacity-40">Open research</button>
              <button type="button" disabled={working != null} onClick={() => void remove(issuer)} className="rounded border border-white/15 px-2.5 py-1.5 text-[10px] text-white/55 hover:bg-white/[0.05] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:opacity-40">Remove</button>
            </div>
          </li>)}</ul>}
      </section>
    </div>
  </div>;
}
