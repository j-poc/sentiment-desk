import { useEffect, useMemo, useRef, useState } from "react";
import type { CompanyFundamentalsView } from "../../../shared/company-fundamentals.js";
import type { SecIssuerDirectoryEntry, SecIssuerDirectoryView, SecIssuerResearchSubject } from "../../../shared/sec-issuer-directory.js";
import type { CompanySnapshot } from "../lib/api.js";
import { CompanyFundamentals } from "./CompanyFundamentals.js";
import { CompanyResearchBriefPanel } from "./CompanyResearchBriefPanel.js";
import { SecVerifiedTradingViewChart } from "./SecVerifiedTradingViewChart.js";
import { getCompanyFundamentals, getSecIssuerDirectory, getSecIssuerResearchSubjects, refreshCompanyFundamentals, refreshCompanyUpdates, refreshSecIssuerDirectory, saveSecIssuerResearchSubject } from "../lib/api.js";

function utcClock(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "time unavailable";
  return new Date(value).toISOString().replace("T", " ").replace(/\.\d{3}Z$/, " UTC");
}

function DirectoryResearchDetail({ subject }: { subject: SecIssuerResearchSubject }) {
  const [fundamentals, setFundamentals] = useState<CompanyFundamentalsView | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshLock = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError(null);
    void getCompanyFundamentals(subject.companyId, controller.signal).then((view) => {
      if (active) setFundamentals(view);
    }).catch(() => {
      if (active) setError("Saved SEC fundamentals could not be read. Retry the read or reopen this saved issuer.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [subject.companyId]);

  const refresh = async (): Promise<CompanyFundamentalsView | null> => {
    if (refreshLock.current) return null;
    refreshLock.current = true;
    setRefreshing(true);
    setError(null);
    try {
      const view = await refreshCompanyFundamentals(subject.companyId, crypto.randomUUID());
      setFundamentals(view);
      if (view.lastRefreshError) setError("SEC fundamentals could not be refreshed. Previously saved facts remain available.");
      return view;
    } catch {
      setError("SEC fundamentals refresh failed. Previously saved facts remain available.");
      return null;
    } finally {
      refreshLock.current = false;
      setRefreshing(false);
    }
  };

  return <section className="mt-4 space-y-3" aria-labelledby="sec-issuer-research-heading">
    <div className="rounded-lg border border-sky-300/15 bg-sky-300/[0.035] p-3">
      <h2 id="sec-issuer-research-heading" className="text-sm font-semibold text-white/85">{subject.name} <span className="font-mono text-white/50">{subject.ticker}</span></h2>
      <p className="mt-1 text-[10px] text-white/45">{subject.exchange ? `SEC directory lists ${subject.exchange}` : "Exchange not listed in SEC directory"}</p>
      <p className="mt-2 text-[11px] leading-5 text-white/55">This company match is a research lead, not confirmation of a current listing. SEC does not provide a separate update time for this list. Checked {utcClock(subject.identityReceipt.retrievedAt)}.</p>
    </div>
    {error && <p className="rounded border border-amber-300/20 bg-amber-200/[0.04] p-3 text-xs text-amber-100/75" role="alert">{error}</p>}
    {loading && <p className="text-xs text-white/45" role="status">Reading saved SEC fundamentals…</p>}
    <CompanyFundamentals
      companyId={subject.companyId}
      snapshotId={fundamentals?.snapshotId ?? null}
      companyName={subject.name}
      ticker={subject.ticker}
      state={fundamentals?.state ?? "idle"}
      facts={fundamentals?.facts ?? []}
      comparisons={fundamentals?.comparisons ?? []}
      points={fundamentals?.points ?? []}
      coverage={fundamentals?.coverage ?? []}
      refreshAllowed={fundamentals?.refreshAllowed ?? false}
      refreshBlockedReason={fundamentals?.refreshBlockedReason ?? (loading ? "Loading saved fundamentals." : null)}
      lastRefreshError={fundamentals?.lastRefreshError}
      staleReason={fundamentals?.staleReason}
      onRefresh={() => void refresh()}
    />
    <SecVerifiedTradingViewChart
      key={`${subject.companyId}:${fundamentals?.facts[0]?.cik ?? subject.cik}`}
      companyId={subject.companyId}
      companyName={subject.name}
      ticker={subject.ticker}
      cik={fundamentals?.facts[0]?.cik ?? subject.cik}
      onRefreshFacts={async () => fundamentals ?? await refresh()}
    />
    {refreshing && <p className="text-[11px] text-white/45" role="status">Refreshing company filings and reported financials…</p>}
    <CompanyResearchBriefPanel companyId={subject.companyId} companyName={subject.name} ticker={subject.ticker} />
  </section>;
}

export function SecIssuerDirectory({ companies = [], onOpenCompany }: {
  companies?: readonly Pick<CompanySnapshot, "id" | "name" | "ticker">[];
  onOpenCompany?: (companyId: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [directoryReloadRevision, setDirectoryReloadRevision] = useState(0);
  const [searching, setSearching] = useState(false);
  const [view, setView] = useState<SecIssuerDirectoryView | null>(null);
  const [subjects, setSubjects] = useState<SecIssuerResearchSubject[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<"directory" | string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [directoryLoadError, setDirectoryLoadError] = useState<string | null>(null);
  const [subjectsLoadError, setSubjectsLoadError] = useState<string | null>(null);
  const autoRefreshAttempted = useRef(false);
  const mountedRef = useRef(false);
  const savedIds = useMemo(() => new Set(subjects.map((item) => item.cik)), [subjects]);
  const selected = subjects.find((item) => item.companyId === selectedId) ?? null;

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const reloadSubjects = async () => {
    try {
      const nextSubjects = await getSecIssuerResearchSubjects();
      if (!mountedRef.current) return;
      setSubjects(nextSubjects);
      setSubjectsLoadError(null);
    } catch {
      if (mountedRef.current) setSubjectsLoadError("Saved research could not be read. Retry the Desk view.");
    }
  };

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    setLoading(true);
    void getSecIssuerResearchSubjects(controller.signal).then((items) => { if (active) { setSubjects(items); setSubjectsLoadError(null); } })
      .catch(() => { if (active) setSubjectsLoadError("Saved research could not be read. Retry the Desk view."); });
    return () => { active = false; controller.abort(); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setView((current) => current ? { ...current, rows: [] } : current);
    if (query.trim().length >= 2) setSearching(true);
    else setSearching(false);
    const timer = setTimeout(() => {
      void getSecIssuerDirectory(query, controller.signal).then((current) => {
        if (!active) return;
        setView(current);
        setDirectoryLoadError(null);
        setSearching(false);
        if (query.trim().length === 0 && !current.receipt && current.canRefresh && !autoRefreshAttempted.current) {
          autoRefreshAttempted.current = true;
          setWorking("directory");
          void refreshSecIssuerDirectory()
            .then(() => { if (mountedRef.current) setDirectoryReloadRevision((revision) => revision + 1); })
            .catch(() => { if (mountedRef.current) setMessage("Company search is temporarily unavailable. Saved research is unchanged."); })
            .finally(() => { if (mountedRef.current) setWorking((value) => value === "directory" ? null : value); });
        }
      }).catch(() => {
        if (active && !controller.signal.aborted) { setDirectoryLoadError("Company search could not be read."); setSearching(false); }
      }).finally(() => { if (active) setLoading(false); });
    }, 160);
    return () => { active = false; clearTimeout(timer); controller.abort(); };
  }, [query, directoryReloadRevision]);

  const checkDirectory = async () => {
    if (working) return;
    setWorking("directory");
    setMessage(null);
    try {
      const result = await refreshSecIssuerDirectory();
      setDirectoryReloadRevision((revision) => revision + 1);
      setMessage(result.receipt ? `Company list updated ${utcClock(result.receipt.retrievedAt)}.` : "Company list checked.");
    } catch {
      setMessage("Company list could not be updated. Previously saved companies remain available.");
      setDirectoryReloadRevision((revision) => revision + 1);
    } finally { setWorking(null); }
  };

  const saveSubject = async (entry: SecIssuerDirectoryEntry) => {
    if (working) return;
    setWorking(entry.cik);
    setMessage(null);
    try {
      const result = await saveSecIssuerResearchSubject(entry);
      if (!mountedRef.current) return;
      await reloadSubjects();
      if (!mountedRef.current) return;
      setSelectedId(result.item.companyId);
      setMessage("Loading recent public company updates and price history. No source is sent to a model until you choose one.");
      try { await refreshCompanyUpdates(result.item.companyId); }
      catch { if (mountedRef.current) setMessage("Company saved. Fresh news could not be loaded, but the saved research remains available."); }
      if (mountedRef.current && onOpenCompany) onOpenCompany(result.item.companyId);
    } catch {
      if (mountedRef.current) setMessage("This company match is no longer current. Update the company list before saving it.");
    } finally { if (mountedRef.current) setWorking(null); }
  };

  const openEntry = async (entry: SecIssuerDirectoryEntry, deskCompany: typeof companies[number] | undefined, saved: boolean) => {
    if (working) return;
    if (deskCompany && onOpenCompany) {
      setWorking(entry.cik);
      let identityMatches = false;
      try {
        const fundamentals = await getCompanyFundamentals(deskCompany.id);
        identityMatches = fundamentals.facts.length > 0
          && fundamentals.facts.every((fact) => fact.cik === entry.cik);
      } catch {
        // An unreadable identity is not sufficient to route into the configured company Desk.
      }
      if (mountedRef.current) setWorking(null);
      if (!mountedRef.current) return;
      if (identityMatches) {
        onOpenCompany(deskCompany.id);
        return;
      }
    }
    if (saved) setSelectedId(`sec-${entry.cik}`);
    else await saveSubject(entry);
  };

  return <div className="mx-auto w-full max-w-6xl space-y-4 pb-8">
    <header className="panel px-4 py-4 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="micro">COMPANY RESEARCH</p>
          <h1 className="mt-1 text-lg font-semibold text-white/85">Find a company to research</h1>
          <p className="mt-2 max-w-3xl text-xs leading-5 text-white/55">Find a public company by name or ticker, then save it to My Research. SEC’s mapping can be incomplete and does not by itself verify an active listing or investment merit.</p>
        </div>
        {view?.canRefresh && <button type="button" onClick={() => void checkDirectory()} disabled={working != null} className="rounded-md border border-emerald-300/25 bg-emerald-300/[0.08] px-3 py-2 text-xs font-medium text-emerald-100/85 hover:bg-emerald-300/[0.14] focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 disabled:cursor-not-allowed disabled:opacity-45">
          {working === "directory" ? "Updating company list…" : view?.receipt ? "Update company list" : "Prepare company search"}
        </button>}
      </div>
      <div className="mt-3 rounded border border-white/[0.08] px-3 py-2 text-[10px] leading-4 text-white/45">
        {view?.receipt ? <><span>Source: </span><a className="text-sky-200/75 underline" href={view.receipt.source} target="_blank" rel="noreferrer">SEC company ticker list</a><span> · checked {utcClock(view.receipt.retrievedAt)} · {view.receipt.rowCount.toLocaleString()} companies. SEC does not provide a separate update time here.</span></>
          : <><span>Source: </span><a className="text-sky-200/75 underline" href="https://www.sec.gov/files/company_tickers_exchange.json" target="_blank" rel="noreferrer">SEC company ticker list</a><span> · company search is temporarily unavailable.</span></>}
      </div>
      {(message || directoryLoadError || subjectsLoadError) && <p className="mt-3 text-xs leading-5 text-amber-100/70" role={directoryLoadError || subjectsLoadError ? "alert" : "status"}>{directoryLoadError ?? subjectsLoadError ?? message}</p>}
      {(directoryLoadError || subjectsLoadError) && <button type="button" onClick={() => { setDirectoryReloadRevision((revision) => revision + 1); void reloadSubjects(); }} className="mt-2 rounded border border-white/15 px-2.5 py-1.5 text-[10px] text-white/65 focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300">Retry saved issuer reads</button>}
      {view?.nextRefreshAt && view.state === "rate_limited" && <p className="mt-1 text-[10px] text-white/40">Company list can be checked again at {utcClock(view.nextRefreshAt)}.</p>}
    </header>

    <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.05fr)_minmax(360px,0.95fr)]">
      <section className="panel min-w-0" aria-labelledby="sec-issuer-search-heading">
        <div className="panel-head"><h2 id="sec-issuer-search-heading" className="micro m-0 p-0">COMPANY SEARCH</h2><span className="tabnum text-[10px] text-white/40">{view?.state === "stale" ? "saved · update needed" : view?.receipt ? "available" : loading ? "checking" : "unavailable"}</span></div>
        <div className="space-y-3 p-3 sm:p-4">
          <label className="block text-[11px] text-white/55">Company name or ticker
            <input type="search" value={query} disabled={!view?.receipt} maxLength={100} onChange={(event) => setQuery(event.target.value)} placeholder="For example: semiconductor or NVDA" className="mt-1.5 w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm text-white/85 outline-none focus-visible:border-emerald-300/50 focus-visible:ring-2 focus-visible:ring-emerald-300/25 disabled:cursor-not-allowed disabled:opacity-45" aria-describedby="sec-issuer-search-help" />
          </label>
          <p id="sec-issuer-search-help" className="text-[10px] leading-4 text-white/40">Enter at least two characters. Up to 50 matches are shown. The list does not rank companies by size.</p>
          {loading && <p role="status" className="py-4 text-xs text-white/45">Checking the company list…</p>}
          {!loading && !view?.receipt && <p className="py-4 text-xs text-white/45">Company search is temporarily unavailable. No issuer results are shown.</p>}
          {!loading && view?.receipt && query.trim().length < 2 && <p className="py-4 text-xs text-white/45">Enter a company name or ticker to search.</p>}
          {!loading && view?.receipt && query.trim().length >= 2 && searching && <p role="status" className="py-4 text-xs text-white/45">Searching the SEC company list…</p>}
          {!loading && view?.receipt && query.trim().length >= 2 && !searching && directoryLoadError && <p role="alert" className="py-4 text-xs text-amber-100/70">Company search could not finish. Check the saved company list and try again.</p>}
          {!loading && view?.receipt && query.trim().length >= 2 && !searching && !directoryLoadError && view.rows.length === 0 && <p className="py-4 text-xs text-white/45">No matching company was found. A missing result does not prove that the company is not public.</p>}
          {view?.rows.length ? <ul className="divide-y divide-white/[0.06] rounded border border-white/[0.06]">
            {view.rows.map((entry, index) => {
              const saved = savedIds.has(entry.cik);
              const deskCompany = companies.find((company) => company.ticker.toUpperCase() === entry.ticker.toUpperCase());
              return <li key={`${entry.cik}:${entry.ticker}:${entry.exchange ?? ""}:${index}`} className="flex min-w-0 flex-wrap items-center justify-between gap-2 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="break-words text-xs font-medium text-white/80">{entry.name} <span className="font-mono text-white/45">{entry.ticker}</span></p>
                  <p className="mt-0.5 text-[10px] text-white/40">{entry.exchange ?? "Exchange not listed"}</p>
                </div>
                <button type="button" disabled={working != null || (!saved && view.freshness !== "current") || (deskCompany != null && onOpenCompany == null)} onClick={() => void openEntry(entry, deskCompany, saved)} className="shrink-0 rounded border border-white/15 px-2.5 py-1.5 text-[10px] text-white/70 hover:bg-white/[0.05] focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-200 disabled:cursor-not-allowed disabled:opacity-40">
                  {working === entry.cik ? "Checking issuer identity…" : deskCompany ? "Open company research" : saved ? "Open SEC research" : "Load company Desk"}
                </button>
              </li>;
            })}
          </ul> : null}
        </div>
      </section>

      <section className="panel min-w-0" aria-labelledby="saved-sec-issuers-heading">
        <div className="panel-head"><h2 id="saved-sec-issuers-heading" className="micro m-0 p-0">MY RESEARCH</h2><span className="tabnum text-[10px] text-white/40">{subjects.length}</span></div>
        {subjects.length === 0 ? <p className="px-4 py-5 text-xs leading-5 text-white/45">Companies with Desk coverage open directly to recent updates, price context, and saved model assessments. Other SEC matches can be saved for fundamentals and filings.</p>
          : <ul className="max-h-52 divide-y divide-white/[0.055] overflow-y-auto">
            {subjects.map((item) => <li key={item.cik}>
              <button type="button" aria-pressed={selectedId === item.companyId} onClick={() => setSelectedId(item.companyId)} className={`w-full px-4 py-3 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-inset focus-visible:outline-sky-200 ${selectedId === item.companyId ? "bg-sky-300/[0.06]" : "hover:bg-white/[0.025]"}`}>
                <span className="block break-words text-xs font-medium text-white/80">{item.name} <span className="font-mono text-white/45">{item.ticker}</span></span>
                <span className="mt-1 block text-[10px] text-white/40">Added from the SEC company list · {utcClock(item.identityReceipt.retrievedAt)}</span>
              </button>
            </li>)}
          </ul>}
        {selected && <DirectoryResearchDetail key={selected.companyId} subject={selected} />}
      </section>
    </div>
  </div>;
}
