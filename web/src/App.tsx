import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getJSON,
  openStream,
  type CompanySnapshot,
  type HealthDTO,
  type MarketSnapshot,
  type Mention,
  type PricePoint,
  type PriceSeriesDTO,
  type SeriesPoint,
} from "./lib/api.js";
import { sessionInfo, type SessionInfo } from "./lib/marketHours.js";
import { Header } from "./components/Header.js";
import { TickerTape } from "./components/TickerTape.js";
import { Watchlist, DeltaChip } from "./components/Watchlist.js";
import { Gauge } from "./components/Gauge.js";
import { SeriesChart } from "./components/SeriesChart.js";
import { MentionCard } from "./components/MentionCard.js";
import { OutcomeCheck } from "./components/OutcomeCheck.js";
import { ValidationPanel } from "./components/ValidationPanel.js";
import { MentionDrawer } from "./components/MentionDrawer.js";
import { Tape } from "./components/Tape.js";
import { HealthPanel } from "./components/HealthPanel.js";
import { SourceCoverageDisclosure } from "./components/SourceCoverageDisclosure.js";
import { TopMovers } from "./components/TopMovers.js";
import { StatusBar } from "./components/StatusBar.js";
import { OpportunityRadar } from "./components/OpportunityRadar.js";
import { quoteSourceAgeLabel, timeAgo } from "./lib/format.js";
import { retryAvailabilityFor } from "./lib/retryAvailability.js";
import { hasComparableDeltas, orderWatchlistCompanies } from "./lib/watchlist-order.js";

const WINDOWS = [
  { h: 6, label: "6H" },
  { h: 24, label: "24H" },
  { h: 72, label: "3D" },
  { h: 168, label: "7D" },
];

const FILTERS = [
  { key: "all", label: "All" },
  { key: "bull", label: "Bullish" },
  { key: "bear", label: "Bearish" },
  { key: "material", label: "Material" },
  { key: "offtarget", label: "Off-target" },
  { key: "failed", label: "Unscored" },
] as const;
type FilterKey = (typeof FILTERS)[number]["key"];
type ResearchView = "desk" | "radar";

function applyFilter(ms: Mention[], f: FilterKey): Mention[] {
  switch (f) {
    case "all":
      // The default view is the investor feed: off-target judgments exist in
      // the database and behind the explicit filter, not in your face.
      return ms.filter((m) => m.status !== "off_target");
    case "bull":
      return ms.filter((m) => m.score?.sentiment === "positive");
    case "bear":
      return ms.filter((m) => m.score?.sentiment === "negative");
    case "material":
      return ms.filter((m) => (m.score?.material ?? 0) >= 0.6);
    case "offtarget":
      return ms.filter((m) => m.status === "off_target");
    case "failed":
      return ms.filter((m) => ["failed", "pending", "retrying", "scoring", "corrupt"].includes(m.status));
  }
}

export default function App() {
  const [companies, setCompanies] = useState<CompanySnapshot[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [researchView, setResearchView] = useState<ResearchView>("desk");
  const [tape, setTape] = useState<Mention[]>([]);
  const [mentionsByCompany, setMentionsByCompany] = useState<Record<string, Mention[]>>({});
  const [mentionsLoadedByCompany, setMentionsLoadedByCompany] = useState<Record<string, boolean>>({});
  const [mentionsErrorByCompany, setMentionsErrorByCompany] = useState<Record<string, boolean>>({});
  const [series, setSeries] = useState<SeriesPoint[]>([]);
  const [seriesKey, setSeriesKey] = useState<string | null>(null);
  const [seriesLoadErrorKey, setSeriesLoadErrorKey] = useState<string | null>(null);
  const [sparks, setSparks] = useState<Record<string, SeriesPoint[]>>({});
  const [market, setMarket] = useState<MarketSnapshot | null>(null);
  const [price, setPrice] = useState<PricePoint[]>([]);
  const [priceResultKey, setPriceResultKey] = useState<string | null>(null);
  const [priceLoadErrorKey, setPriceLoadErrorKey] = useState<string | null>(null);
  const [priceSource, setPriceSource] = useState<PriceSeriesDTO | null>(null);
  const [health, setHealth] = useState<HealthDTO | null>(null);
  const [connected, setConnected] = useState(false);
  const [snapshotRevision, setSnapshotRevision] = useState(0);
  const [windowHours, setWindowHours] = useState(24);
  const [chartMode, setChartMode] = useState<"sentiment" | "overlay">("overlay");
  const [feedFilter, setFeedFilter] = useState<FilterKey>("all");
  const [sortMode, setSortMode] = useState<"delta" | "alpha">("delta");
  const [clock, setClock] = useState(Date.now());
  const [session, setSession] = useState<SessionInfo>(() => sessionInfo());
  const [drawerMention, setDrawerMention] = useState<Mention | null>(null);
  const closeDrawer = useCallback(() => setDrawerMention(null), []);

  const selectedIdRef = useRef<string | null>(null);
  const windowRef = useRef(24);
  const chartModeRef = useRef<"sentiment" | "overlay">("overlay");
  const seriesRequestSeq = useRef(0);
  const priceKeyRef = useRef<string | null>(null);
  const priceRequestSeq = useRef(0);
  const mentionStreamSequence = useRef(0);
  const latestStreamedMention = useRef(new Map<string, { sequence: number; mention: Mention }>());
  const runtimeIdRef = useRef<string | null>(null);
  const healthRef = useRef<HealthDTO | null>(null);
  const snapshotRequestSeq = useRef(0);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);
  useEffect(() => {
    windowRef.current = windowHours;
  }, [windowHours]);
  useEffect(() => {
    priceKeyRef.current = `${selectedId ?? ""}:${windowHours}`;
    priceRequestSeq.current += 1;
    setPrice([]);
    setPriceSource(null);
    setPriceResultKey(null);
    setPriceLoadErrorKey(null);
  }, [selectedId, windowHours]);
  useEffect(() => {
    chartModeRef.current = chartMode;
  }, [chartMode]);

  const selected = useMemo(
    () => companies.find((c) => c.id === selectedId) ?? null,
    [companies, selectedId],
  );
  const selectedSeriesKey = selectedId == null ? null : `${selectedId}:${windowHours}`;
  const selectedSeriesReady = selectedSeriesKey != null && seriesKey === selectedSeriesKey;
  const selectedSeries = selectedSeriesReady ? series : [];
  const selectedSeriesError = selectedSeriesKey != null && seriesLoadErrorKey === selectedSeriesKey;
  const selectedSeriesHasSentiment = selectedSeries.some((point) => point.v != null && Number.isFinite(point.v));
  const selectedPriceReady = selectedSeriesKey != null && priceResultKey === selectedSeriesKey;
  const selectedPrice = selectedPriceReady ? price : [];
  const selectedPriceSource = selectedPriceReady ? priceSource : null;
  const selectedPriceError = selectedSeriesKey != null && priceLoadErrorKey === selectedSeriesKey;
  const selectedPricePending = chartMode === "overlay" && selectedSeriesKey != null && !selectedPriceReady && !selectedPriceError;
  const chartHasPrice = chartMode === "overlay" && selectedPrice.length >= 2;
  const chartLoading = selectedSeriesKey != null && (
    (!selectedSeriesReady && !selectedSeriesError)
    || (selectedPricePending && !chartHasPrice && !selectedSeriesHasSentiment)
  );

  const refreshSeries = useCallback(async (companyId?: string) => {
    const id = companyId ?? selectedIdRef.current;
    if (!id) return;
    const hours = windowRef.current;
    const requestKey = `${id}:${hours}`;
    const requestSeq = ++seriesRequestSeq.current;
    try {
      const result = await getJSON<SeriesPoint[]>(`/api/companies/${id}/series?hours=${hours}`);
      if (seriesRequestSeq.current === requestSeq && selectedIdRef.current === id && windowRef.current === hours) {
        setSeries(result);
        setSeriesKey(requestKey);
        setSeriesLoadErrorKey(null);
      }
    } catch {
      if (seriesRequestSeq.current === requestSeq && selectedIdRef.current === id && windowRef.current === hours) {
        setSeriesLoadErrorKey(requestKey);
      }
    }
  }, []);

  const refreshPrice = useCallback(async () => {
    if (chartModeRef.current !== "overlay") return;
    const id = selectedIdRef.current;
    if (!id) return;
    const hours = windowRef.current;
    const requestKey = `${id}:${hours}`;
    const requestSeq = ++priceRequestSeq.current;
    if (priceKeyRef.current !== requestKey) {
      priceKeyRef.current = requestKey;
      setPrice([]);
      setPriceSource(null);
      setPriceResultKey(null);
      setPriceLoadErrorKey(null);
    }
    try {
      const all = await getJSON<CompanySnapshot[]>("/api/companies");
      const c = all.find((x) => x.id === id);
      if (!c) {
        if (priceKeyRef.current === requestKey && priceRequestSeq.current === requestSeq) setPriceLoadErrorKey(requestKey);
        return;
      }
      const result = await getJSON<PriceSeriesDTO>(
        `/api/companies/${id}/price?ticker=${encodeURIComponent(c.ticker)}&hours=${hours}`,
      );
      if (priceKeyRef.current !== requestKey || priceRequestSeq.current !== requestSeq) return;
      setPrice(result.points);
      setPriceSource(result);
      setPriceResultKey(requestKey);
      setPriceLoadErrorKey(null);
    } catch {
      if (priceKeyRef.current === requestKey && priceRequestSeq.current === requestSeq) setPriceLoadErrorKey(requestKey);
    }
  }, []);

  const applyHealth = useCallback((snapshot: HealthDTO) => {
    if (runtimeIdRef.current && runtimeIdRef.current !== snapshot.runtimeId) return;
    runtimeIdRef.current = snapshot.runtimeId;
    healthRef.current = snapshot;
    setHealth(snapshot);
  }, []);

  const refreshBackendSnapshot = useCallback(async (reset = false, expectedRuntimeId?: string) => {
    const requestSeq = ++snapshotRequestSeq.current;
    const streamSequenceAtStart = mentionStreamSequence.current;
    const [cs, tapeSnapshot, quoteSnapshot, healthSnapshot] = await Promise.all([
      getJSON<CompanySnapshot[]>("/api/companies").catch(() => null),
      getJSON<Mention[]>("/api/tape?limit=60").catch(() => null),
      getJSON<MarketSnapshot>("/api/quotes").catch(() => null),
      getJSON<HealthDTO>("/api/health").catch(() => null),
    ]);
    if (requestSeq !== snapshotRequestSeq.current || !healthSnapshot) return;
    if (expectedRuntimeId && healthSnapshot.runtimeId !== expectedRuntimeId) return;
    if (runtimeIdRef.current && healthSnapshot.runtimeId !== runtimeIdRef.current) return;
    runtimeIdRef.current = healthSnapshot.runtimeId;
    healthRef.current = healthSnapshot;
    setHealth(healthSnapshot);

    if (cs) {
      setCompanies(cs);
      setSelectedId((current) => current && cs.some((company) => company.id === current)
        ? current
        : cs[0]?.id ?? null);
    }
    if (tapeSnapshot) {
      const realTape = tapeSnapshot.filter(isApplicationMention);
      setTape((current) => mergeSnapshotWithLive(
        realTape,
        current,
        latestStreamedMention.current,
        streamSequenceAtStart,
        60,
        !reset,
      ));
      setDrawerMention((current) => {
        if (!current) return null;
        return realTape.find((mention) => mention.id === current.id) ?? null;
      });
    }
    if (quoteSnapshot) setMarket(quoteSnapshot);
    if (cs && tapeSnapshot) {
      setMentionsByCompany({});
      setMentionsLoadedByCompany({});
      setMentionsErrorByCompany({});
      setSnapshotRevision((revision) => revision + 1);
    }
    setSparks({});
    void refreshSeries();
    void refreshPrice();
  }, [refreshPrice, refreshSeries]);

  useEffect(() => {
    if (chartMode === "overlay") void refreshPrice();
  }, [chartMode, refreshPrice]);

  // Initial load: refresh authoritative server snapshots.
  useEffect(() => {
    void refreshBackendSnapshot();
  }, [refreshBackendSnapshot]);

  // Live stream: one EventSource, native reconnect.
  useEffect(() => {
    let lastSeriesRefresh = 0;
    const close = openStream({
      onHello: (d) => {
        const previousRuntimeId = runtimeIdRef.current ?? healthRef.current?.runtimeId ?? null;
        const runtimeChanged = previousRuntimeId != null && previousRuntimeId !== d.runtimeId;
        runtimeIdRef.current = d.runtimeId;
        if (runtimeChanged) {
          snapshotRequestSeq.current += 1;
          mentionStreamSequence.current += 1;
          latestStreamedMention.current.clear();
        setCompanies([]);
          setTape([]);
          setMarket(null);
          setSparks({});
          setMentionsByCompany({});
          setMentionsLoadedByCompany({});
          setMentionsErrorByCompany({});
          setDrawerMention(null);
          setHealth(null);
          healthRef.current = null;
          seriesRequestSeq.current += 1;
          priceRequestSeq.current += 1;
          setSeries([]);
          setSeriesKey(null);
          setSeriesLoadErrorKey(null);
          setPrice([]);
          setPriceSource(null);
          setPriceResultKey(null);
          setPriceLoadErrorKey(null);
        }
        void refreshBackendSnapshot(runtimeChanged, d.runtimeId);
        setConnected(true);
      },
      onState: setConnected,
      onMention: (m) => {
        if (!isApplicationMention(m)) return;
        const sequence = ++mentionStreamSequence.current;
        latestStreamedMention.current.delete(m.id);
        latestStreamedMention.current.set(m.id, { sequence, mention: m });
        if (latestStreamedMention.current.size > 500) {
          const oldestId = latestStreamedMention.current.keys().next().value;
          if (oldestId !== undefined) latestStreamedMention.current.delete(oldestId);
        }
        setTape((prev) => upsertMention(prev, m, 60));
        setMentionsByCompany((prev) => {
          const cached = prev[m.companyId];
          if (!cached && m.companyId !== selectedIdRef.current) return prev;
          const current = cached ?? [];
          return { ...prev, [m.companyId]: upsertMention(current, m, 100) };
        });
        setDrawerMention((current) => current?.id === m.id ? m : current);
        const now = Date.now();
        if (now - lastSeriesRefresh > 8_000) {
          lastSeriesRefresh = now;
          void refreshSeries();
          void refreshPrice();
        }
      },
      onCompany: (s) => setCompanies((prev) => prev.map((c) => (c.id === s.id ? s : c))),
      onQuotes: (s) =>
        setMarket((prev) => ({ quotes: { ...prev?.quotes, ...s.quotes }, updatedAt: s.updatedAt })),
    });
    return close;
  }, [refreshBackendSnapshot, refreshSeries, refreshPrice]);

  // Series + price for the selected company: on select/window change and on timers.
  useEffect(() => {
    if (!selectedId) return;
    void refreshSeries(selectedId);
    void refreshPrice();
    const t = setInterval(() => {
      void refreshSeries(selectedId);
      void refreshPrice();
    }, 30_000);
    return () => clearInterval(t);
  }, [selectedId, windowHours, refreshSeries, refreshPrice]);

  // Mentions for the selected company.
  useEffect(() => {
    if (!selectedId) return;
    let alive = true;
    const streamSequenceAtStart = mentionStreamSequence.current;
    setMentionsErrorByCompany((prev) => ({ ...prev, [selectedId]: false }));
    (async () => {
      try {
        const ms = await getJSON<Mention[]>(`/api/companies/${selectedId}/mentions?hours=168&limit=100`);
        if (alive) {
          setMentionsByCompany((prev) => {
            const live = prev[selectedId] ?? [];
            return {
              ...prev,
            [selectedId]: mergeSnapshotWithLive(
              ms.filter(isApplicationMention),
              live,
              latestStreamedMention.current,
              streamSequenceAtStart,
              100,
            ),
            };
          });
          setMentionsLoadedByCompany((prev) => ({ ...prev, [selectedId]: true }));
          setMentionsErrorByCompany((prev) => ({ ...prev, [selectedId]: false }));
        }
      } catch {
        if (alive) setMentionsErrorByCompany((prev) => ({ ...prev, [selectedId]: true }));
      }
    })();
    return () => {
      alive = false;
    };
  }, [selectedId, snapshotRevision]);

  // Health poll.
  useEffect(() => {
    const load = async () => {
      try {
        const h = await getJSON<HealthDTO>("/api/health");
        applyHealth(h);
      } catch {
        /* ignore */
      }
    };
    void load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, [applyHealth]);

  // Sparklines for every watchlist row.
  const companyCount = companies.length;
  useEffect(() => {
    if (companyCount === 0) return;
    let alive = true;
    const load = async () => {
      const ids = (
        await getJSON<CompanySnapshot[]>("/api/companies").catch(() => [] as CompanySnapshot[])
      ).map((c) => c.id);
      const entries = await Promise.all(
        ids.map(async (id) => {
          try {
            return [id, await getJSON<SeriesPoint[]>(`/api/companies/${id}/series?hours=24`)] as const;
          } catch {
            return [id, [] as SeriesPoint[]] as const;
          }
        }),
      );
      if (alive) setSparks(Object.fromEntries(entries));
    };
    void load();
    const t = setInterval(load, 90_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [companyCount, snapshotRevision]);

  // Clock + market session.
  useEffect(() => {
    const t = setInterval(() => {
      setClock(Date.now());
      setSession(sessionInfo());
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // Ordering for display and keyboard navigation.
  const deltaSortAvailable = hasComparableDeltas(companies);
  const ordered = useMemo(
    () => orderWatchlistCompanies(companies, sortMode),
    [companies, sortMode],
  );
  const orderRef = useRef<string[]>([]);
  useEffect(() => {
    orderRef.current = ordered.map((c) => c.id);
  }, [ordered]);

  // Keyboard: j/k or arrows move, 1-4 windows, f cycles filter, c toggles chart mode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (drawerMention) return;
      if (e.target instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName)) return;
      const move = (dir: number) => {
        const ids = orderRef.current;
        if (ids.length === 0) return;
        const idx = ids.indexOf(selectedIdRef.current ?? "");
        const next = ids[(idx + dir + ids.length) % ids.length];
        if (next != null) setSelectedId(next);
        e.preventDefault();
      };
      if (e.key === "j" || e.key === "ArrowDown") move(1);
      else if (e.key === "k" || e.key === "ArrowUp") move(-1);
      else if (["1", "2", "3", "4"].includes(e.key)) setWindowHours(WINDOWS[Number(e.key) - 1]?.h ?? 24);
      else if (e.key === "f") {
        const i = FILTERS.findIndex((f) => f.key === feedFilter);
        setFeedFilter(FILTERS[(i + 1) % FILTERS.length]?.key ?? "all");
      } else if (e.key === "c") setChartMode((m) => (m === "overlay" ? "sentiment" : "overlay"));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerMention, feedFilter]);

  // Fresh, high-strength events across the whole watchlist: the speed lane.
  const breaking = useMemo(
    () =>
      tape.filter(
        (m) => m.score && m.publishedAt != null && m.score.eventScore >= 60 && Date.now() - m.publishedAt < 45 * 60_000,
      ).slice(0, 6),
    [tape],
  );

  const tickerOf = useCallback(
    (id: string) => companies.find((c) => c.id === id)?.ticker ?? id.slice(0, 4).toUpperCase(),
    [companies],
  );
  const totalMentions = companies.reduce((acc, c) => acc + c.mentions24h, 0);
  const selectedMentions = selectedId && mentionsLoadedByCompany[selectedId]
    ? mentionsByCompany[selectedId] ?? []
    : [];
  const filteredMentions = useMemo(() => applyFilter(selectedMentions, feedFilter), [selectedMentions, feedFilter]);
  const mentionsPending = selectedId != null && !mentionsLoadedByCompany[selectedId] && !mentionsErrorByCompany[selectedId];
  const mentionsFailed = selectedId != null && mentionsErrorByCompany[selectedId];
  const retryAvailability = retryAvailabilityFor(health);

  return (
    <>
    <div className="flex h-full flex-col overflow-hidden" inert={drawerMention !== null}>
      <Header connected={connected} health={health} totalMentions={totalMentions} clock={clock} />
      <TickerTape
        market={market}
        companies={companies}
        selectedId={selectedId}
        onSelect={setSelectedId}
        indices={["SPY", "QQQ", "^VIX"]}
      />

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[312px_minmax(0,1fr)] xl:grid-cols-[312px_minmax(0,1fr)_330px]">
        <aside className="hidden min-h-0 overflow-y-auto border-r border-desk-line lg:block">
          <div className="panel-head sticky top-0 z-10 bg-[#0a0c11]/95 backdrop-blur">
            <span className="micro">Watchlist</span>
            <button
              onClick={() => setSortMode((m) => (m === "delta" ? "alpha" : "delta"))}
              disabled={!deltaSortAvailable}
              className="tabnum flex items-center gap-1 rounded border border-white/10 px-1.5 py-[1px] text-[9.5px] text-white/50 hover:bg-white/[0.05] disabled:cursor-not-allowed disabled:opacity-35"
              title={deltaSortAvailable
                ? "toggle sort (delta movement vs alphabetical)"
                : "No prior sentiment comparison is available; companies are sorted alphabetically."}
            >
              {sortMode === "delta" && deltaSortAvailable ? "Δ MOVE" : "A-Z"}
              <kbd>j/k</kbd>
            </button>
          </div>
          <Watchlist
            companies={ordered}
            selectedId={selectedId}
            sparks={sparks}
            quotes={market?.quotes ?? {}}
            onSelect={setSelectedId}
          />
        </aside>

        <main className="flex min-h-0 flex-col px-3 py-2 sm:px-4 sm:py-3">
          <div className="mb-2 flex shrink-0 items-center gap-1" role="group" aria-label="Research view">
            {([
              ["desk", "Desk"],
              ["radar", "Opportunity Radar"],
            ] as const).map(([view, label]) => (
              <button
                key={view}
                type="button"
                aria-pressed={researchView === view}
                onClick={() => setResearchView(view)}
                className={`rounded-md border px-2.5 py-1.5 text-[10.5px] font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-emerald-300 ${researchView === view ? "border-white/15 bg-white/[0.08] text-white/85" : "border-transparent text-white/40 hover:bg-white/[0.04] hover:text-white/70"}`}
              >
                {label}
              </button>
            ))}
          </div>
          {researchView === "desk" && <SourceCoverageDisclosure externalRequestsEnabled={health?.externalRequestsEnabled ?? true} />}
          {selected ? (
            researchView === "radar" ? (
              <OpportunityRadar
                key={selected.id}
                companyId={selected.id}
                ticker={selected.ticker}
                hours={windowHours}
                onHours={setWindowHours}
              />
            ) : (
            <>
              <div className="panel grid shrink-0 grid-cols-[88px_minmax(0,1fr)] items-center gap-x-3 gap-y-2 px-3 py-2 sm:flex sm:gap-4 sm:px-4">
                <Gauge value={selected.index} size={88} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h1 className="text-[18px] font-semibold">{selected.name}</h1>
                    <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10.5px] font-medium text-white/60">
                      {selected.ticker}
                    </span>
                    {(() => {
                      const q = market?.quotes[selected.ticker];
                      if (!q) return null;
                      const c = q.changePct;
                      return (
                        <>
                          <span
                            className="tabnum rounded px-1.5 py-0.5 text-[10.5px] font-medium"
                            title={`${q.delivery === "cache" ? "Last-known cached quote" : "Yahoo Finance quote"}; ${q.currency}; source time ${q.at == null ? "unknown" : new Date(q.at).toISOString()}; retrieved ${timeAgo(q.retrievedAt)}`}
                            style={{
                              color: q.delivery === "cache" ? "#fbbf24" : c > 0.001 ? "#34d399" : c < -0.001 ? "#f87171" : "#94a3b8",
                              background: "rgba(255,255,255,0.04)",
                            }}
                          >
                            {q.currency} {q.price.toFixed(2)} {c > 0 ? "+" : ""}{c.toFixed(2)}%
                            {q.delivery === "cache" ? ` · cached ${timeAgo(q.retrievedAt)}` : ""}
                          </span>
                          {quoteSourceAgeLabel(q.at) && (
                            <span
                              className="text-[9px] text-amber-300/80"
                              title={`Exchange observation time; retrieved ${timeAgo(q.retrievedAt)}`}
                            >
                              {quoteSourceAgeLabel(q.at)}
                            </span>
                          )}
                        </>
                      );
                    })()}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-white/40">
                    <span>
                      {selected.sector} · {selected.mentions24h} collected in 24h · last {timeAgo(selected.lastMentionAt)}
                    </span>
                    {selected.earningsAt != null && (
                      <span
                        className="rounded border border-amber-400/25 bg-amber-400/[0.07] px-1.5 py-[1px] text-[10px] font-medium text-amber-300"
                        title="upcoming earnings date (finnhub calendar)"
                      >
                        earnings {Math.ceil((selected.earningsAt - Date.now()) / 86_400_000)}d
                      </span>
                    )}
                    {selected.lastSurprise && (
                      <span
                        className="tabnum rounded border px-1.5 py-[1px] text-[10px] font-medium"
                        style={{
                          color: selected.lastSurprise.percent >= 0 ? "#34d399" : "#f87171",
                          borderColor: selected.lastSurprise.percent >= 0 ? "rgba(52,211,153,0.25)" : "rgba(248,113,113,0.25)",
                          background: "rgba(255,255,255,0.03)",
                        }}
                        title={`EPS vs consensus, ${selected.lastSurprise.period} (finnhub)`}
                      >
                        EPS surprise {selected.lastSurprise.percent > 0 ? "+" : ""}
                        {selected.lastSurprise.percent.toFixed(1)}%
                      </span>
                    )}
                  </div>
                  <div className="mt-2 flex items-center gap-2 text-[11.5px]">
                    <DeltaChip delta={selected.delta} />
                    <span className="text-white/30">vs trailing 24h</span>
                  </div>
                </div>
                <div className="col-span-2 flex w-full flex-row justify-between gap-1 sm:ml-auto sm:w-auto sm:shrink-0 sm:justify-start">
                  {WINDOWS.map((w, i) => (
                    <button
                      key={w.h}
                      onClick={() => setWindowHours(w.h)}
                      className={`flex items-center justify-between gap-2 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                        windowHours === w.h
                          ? "bg-white/[0.09] text-white"
                          : "text-white/40 hover:bg-white/[0.04] hover:text-white/70"
                      }`}
                    >
                      {w.label}
                      <kbd>{i + 1}</kbd>
                    </button>
                  ))}
                </div>
              </div>

              <div className="panel mt-2 shrink-0">
                <div className="panel-head chart-panel-head">
                  <span className="micro">
                    {chartMode === "overlay" ? "Sentiment × Price" : "Sentiment"}
                  </span>
                  <div className="chart-panel-meta flex items-center gap-2 text-[9.5px] text-white/40">
                    <span className="flex items-center gap-1">
                      <span className="inline-block h-[2px] w-3 bg-emerald-400" /> sentiment
                    </span>
                    {chartMode === "overlay" && (
                      <span className="flex items-center gap-1">
                        <span className="inline-block h-[2px] w-3 bg-white/80" /> price
                      </span>
                    )}
                    {chartMode === "overlay" && (
                      <span
                        className={selectedPriceError ? "text-amber-300/80" : "text-white/30"}
                        title={selectedPriceSource ? `Latest provider observation ${selectedPriceSource.sourceLatestAt == null ? "time unknown" : new Date(selectedPriceSource.sourceLatestAt).toISOString()}; served ${new Date(selectedPriceSource.servedAt).toISOString()}${selectedPriceSource.cacheAgeMs == null ? "" : `; memory cache age ${Math.round(selectedPriceSource.cacheAgeMs / 1000)}s`}; only provider timestamps within this window are plotted.` : undefined}
                      >
                        {selectedPriceError ? selectedPriceReady ? "refresh failed · keeping prior series" : "price history unavailable" : selectedPriceSource
                          ? `${selectedPriceSource.delivery.replaceAll("_", " ")}${selectedPriceSource.cacheAgeMs == null ? "" : ` ${Math.round(selectedPriceSource.cacheAgeMs / 1000)}s`} · source ${timeAgo(selectedPriceSource.sourceLatestAt)}`
                          : "price waiting"}
                      </span>
                    )}
                    <button
                      onClick={() => setChartMode((m) => (m === "overlay" ? "sentiment" : "overlay"))}
                      className="tabnum rounded border border-white/10 px-1.5 py-[1px] hover:bg-white/[0.05]"
                    >
                      {chartMode === "overlay" ? "S×P" : "S"}
                      <kbd className="ml-1">c</kbd>
                    </button>
                  </div>
                </div>
                <div className="px-3 py-2">
                  <SeriesChart
                    key={selectedSeriesKey ?? "no-selection"}
                    points={selectedSeries}
                    hours={windowHours}
                    loading={chartLoading}
                    mode={chartMode}
                    price={selectedPrice}
                    latestPriceAt={selectedPriceSource?.sourceLatestAt ?? null}
                    onViewHistory={() => setWindowHours(168)}
                    priceLoading={selectedPricePending}
                    priceError={selectedPriceError}
                    seriesError={selectedSeriesError}
                    seriesReady={selectedSeriesReady}
                  />
                </div>
              </div>

              {breaking.length > 0 && (
                <div className="no-scrollbar panel mt-2 flex shrink-0 items-center gap-1.5 overflow-x-auto px-2 py-1.5">
                  <span className="micro shrink-0 px-1 text-amber-300/80">Just landed</span>
                  {breaking.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => setDrawerMention(m)}
                      className="flex shrink-0 items-baseline gap-1.5 rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 text-[10.5px] hover:bg-white/[0.06]"
                    >
                      <span className="font-semibold text-white/80">{tickerOf(m.companyId)}</span>
                      <span
                        className="tabnum font-medium"
                        style={{ color: (m.score?.impact ?? 0) >= 0 ? "#34d399" : "#f87171" }}
                      >
                        {(m.score?.impact ?? 0) > 0 ? "+" : ""}
                        {(m.score?.impact ?? 0).toFixed(0)}
                      </span>
                      <span className="clamp-1 max-w-[240px] text-white/60">{m.title}</span>
                    </button>
                  ))}
                </div>
              )}

              <div className="mt-2 grid min-h-0 flex-1 grid-cols-1 gap-3 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_330px] lg:overflow-hidden">
                <div className="panel flex min-h-[45vh] max-h-[55vh] flex-col lg:min-h-0 lg:max-h-none">
                  <div className="panel-head mentions-panel-head shrink-0">
                    <span className="micro">
                      Mentions · {health?.health.jev.model ?? "jev"}
                      {mentionsFailed && <span className="ml-2 normal-case tracking-normal text-amber-300/80">refresh failed</span>}
                    </span>
                    <div className="mentions-filters">
                      {FILTERS.map((f) => (
                        <button
                          key={f.key}
                          onClick={() => setFeedFilter(f.key)}
                          className={`rounded-md px-2 py-[3px] text-[10.5px] transition-colors ${
                            feedFilter === f.key
                              ? "bg-white/[0.09] text-white"
                              : "text-white/40 hover:bg-white/[0.04] hover:text-white/70"
                          }`}
                        >
                          {f.label}
                          <kbd className="ml-1">f</kbd>
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto p-2">
                    {filteredMentions.map((m) => (
                      <MentionCard key={m.id} m={m} dense onOpen={setDrawerMention} />
                    ))}
                    {filteredMentions.length === 0 && (
                      <div className="px-3 py-4 text-[12px] text-white/35" role="status">
                        {mentionsFailed
                          ? "Mentions could not be loaded. Select another company and return to retry."
                          : mentionsPending
                            ? `Loading ${selected.ticker} mentions…`
                            : selectedMentions.length === 0
                              ? "No mentions in this window yet. New mentions are scored within seconds of arrival."
                              : feedFilter === "all" && selectedMentions.every((mention) => mention.status === "off_target")
                                ? `No in-scope mentions yet. ${selectedMentions.length} off-target ${selectedMentions.length === 1 ? "item is" : "items are"} hidden; choose Off-target to review ${selectedMentions.length === 1 ? "it" : "them"}.`
                              : "Nothing matches this filter."}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex min-h-0 flex-col gap-3 overflow-visible pb-2 pr-1 lg:overflow-y-auto lg:pb-0">
                  <OutcomeCheck companyId={selected.id} ticker={selected.ticker} hours={windowHours} refreshToken={tape.length} />
                  <ValidationPanel />
                </div>
              </div>
            </>
            )
          ) : (
            <div className="flex h-full items-center justify-center text-[12px] text-white/35">
              {companies.length === 0 ? "Connecting to the desk…" : "Select a company from the watchlist."}
            </div>
          )}
        </main>

        <aside className="hidden min-h-0 flex-col overflow-y-auto border-l border-desk-line xl:flex">
          <div className="panel-head sticky top-0 z-10 bg-[#0a0c11]/95 backdrop-blur">
            <span className="micro">Top movers</span>
            <span className="text-[9px] text-white/25">24h Δ</span>
          </div>
          <TopMovers companies={companies} selectedId={selectedId} onSelect={setSelectedId} />

          <div className="panel-head sticky top-0 z-0 mt-3 border-t border-desk-line bg-[#0a0c11]/95 backdrop-blur">
            <span className="micro">Live tape</span>
          </div>
          <Tape mentions={tape} tickerOf={tickerOf} onOpen={setDrawerMention} />

          <div className="mt-3 border-t border-desk-line">
            <div className="panel-head">
              <span className="micro">Desk health</span>
            </div>
            <HealthPanel health={health} />
          </div>
        </aside>
      </div>

      <StatusBar health={health} session={session} connected={connected} tape={tape} />
    </div>
    <MentionDrawer
      mention={drawerMention}
      onClose={closeDrawer}
      retryAvailability={retryAvailability}
    />
    </>
  );
}

function isApplicationMention(mention: Mention): boolean {
  return String(mention.collector) !== "demo_simulation" && mention.score?.engine !== "demo-sim";
}

function upsertMention(mentions: Mention[], mention: Mention, limit: number): Mention[] {
  if (!isApplicationMention(mention)) return mentions;
  const existingIndex = mentions.findIndex((item) => item.id === mention.id);
  if (existingIndex < 0) return [mention, ...mentions].slice(0, limit);
  const updated = mentions.slice();
  updated[existingIndex] = mention;
  return updated;
}

function mergeSnapshotWithLive(
  snapshot: Mention[],
  current: Mention[],
  latestStreamed: Map<string, { sequence: number; mention: Mention }>,
  sequenceAtStart: number,
  limit: number,
  preserveUnseenCurrent = true,
): Mention[] {
  const snapshotIds = new Set(snapshot.map((mention) => mention.id));
  const responseRows = snapshot.map((mention) => {
    const streamed = latestStreamed.get(mention.id);
    return streamed && streamed.sequence > sequenceAtStart ? streamed.mention : mention;
  });
  const unseenCurrent = preserveUnseenCurrent
    ? current.filter((mention) => !snapshotIds.has(mention.id) && isApplicationMention(mention))
    : [...latestStreamed.values()]
      .filter((streamed) => streamed.sequence > sequenceAtStart && !snapshotIds.has(streamed.mention.id))
      .map((streamed) => streamed.mention);
  return [...unseenCurrent, ...responseRows].slice(0, limit);
}
