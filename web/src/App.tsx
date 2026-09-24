import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getJSON,
  openStream,
  type CompanySnapshot,
  type HealthDTO,
  type MarketSnapshot,
  type Mention,
  type PricePoint,
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
import { Tape } from "./components/Tape.js";
import { HealthPanel } from "./components/HealthPanel.js";
import { TopMovers } from "./components/TopMovers.js";
import { StatusBar } from "./components/StatusBar.js";
import { timeAgo } from "./lib/format.js";

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
      return ms.filter((m) => m.status === "failed" || m.status === "pending");
  }
}

export default function App() {
  const [companies, setCompanies] = useState<CompanySnapshot[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tape, setTape] = useState<Mention[]>([]);
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [series, setSeries] = useState<SeriesPoint[]>([]);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [sparks, setSparks] = useState<Record<string, SeriesPoint[]>>({});
  const [market, setMarket] = useState<MarketSnapshot | null>(null);
  const [price, setPrice] = useState<PricePoint[]>([]);
  const [health, setHealth] = useState<HealthDTO | null>(null);
  const [connected, setConnected] = useState(false);
  const [demo, setDemo] = useState(false);
  const [windowHours, setWindowHours] = useState(24);
  const [chartMode, setChartMode] = useState<"sentiment" | "overlay">("overlay");
  const [feedFilter, setFeedFilter] = useState<FilterKey>("all");
  const [sortMode, setSortMode] = useState<"delta" | "alpha">("delta");
  const [clock, setClock] = useState(Date.now());
  const [session, setSession] = useState<SessionInfo>(() => sessionInfo());

  const selectedIdRef = useRef<string | null>(null);
  const windowRef = useRef(24);
  const chartModeRef = useRef<"sentiment" | "overlay">("overlay");
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);
  useEffect(() => {
    windowRef.current = windowHours;
  }, [windowHours]);
  useEffect(() => {
    chartModeRef.current = chartMode;
  }, [chartMode]);

  const selected = useMemo(
    () => companies.find((c) => c.id === selectedId) ?? null,
    [companies, selectedId],
  );

  const refreshSeries = useCallback(async (companyId?: string) => {
    const id = companyId ?? selectedIdRef.current;
    if (!id) return;
    setSeriesLoading(true);
    try {
      setSeries(await getJSON<SeriesPoint[]>(`/api/companies/${id}/series?hours=${windowRef.current}`));
    } catch {
      /* keep last series */
    } finally {
      setSeriesLoading(false);
    }
  }, []);

  const refreshPrice = useCallback(async () => {
    if (chartModeRef.current !== "overlay") return;
    const id = selectedIdRef.current;
    if (!id) return;
    try {
      const all = await getJSON<CompanySnapshot[]>("/api/companies");
      const c = all.find((x) => x.id === id);
      if (!c) return;
      setPrice(
        await getJSON<PricePoint[]>(
          `/api/companies/${id}/price?ticker=${encodeURIComponent(c.ticker)}&hours=${windowRef.current}`,
        ),
      );
    } catch {
      /* keep last price series */
    }
  }, []);

  // Initial load: watchlist, tape, quotes, health snapshot.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cs = await getJSON<CompanySnapshot[]>("/api/companies");
        if (!alive) return;
        setCompanies(cs);
        setSelectedId((prev) => prev ?? cs[0]?.id ?? null);
      } catch {
        /* health poll retries */
      }
      try {
        const t = await getJSON<Mention[]>("/api/tape?limit=60");
        if (alive) setTape(t);
      } catch {
        /* ignore */
      }
      try {
        const m = await getJSON<MarketSnapshot>("/api/quotes");
        if (alive) setMarket(m);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // Live stream: one EventSource, native reconnect.
  useEffect(() => {
    let lastSeriesRefresh = 0;
    const close = openStream({
      onHello: (d) => {
        setDemo(d.demo);
        setConnected(true);
      },
      onState: setConnected,
      onMention: (m) => {
        setTape((prev) => (prev.some((x) => x.id === m.id) ? prev : [m, ...prev].slice(0, 60)));
        if (m.companyId === selectedIdRef.current) {
          setMentions((prev) => (prev.some((x) => x.id === m.id) ? prev : [m, ...prev].slice(0, 100)));
        }
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
  }, [refreshSeries, refreshPrice]);

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
    (async () => {
      try {
        const ms = await getJSON<Mention[]>(`/api/companies/${selectedId}/mentions?hours=168&limit=100`);
        if (alive) setMentions(ms);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      alive = false;
    };
  }, [selectedId]);

  // Health poll.
  useEffect(() => {
    const load = async () => {
      try {
        const h = await getJSON<HealthDTO>("/api/health");
        setHealth(h);
        setDemo(h.demo);
      } catch {
        /* ignore */
      }
    };
    void load();
    const t = setInterval(load, 20_000);
    return () => clearInterval(t);
  }, []);

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
  }, [companyCount]);

  // Clock + market session.
  useEffect(() => {
    const t = setInterval(() => {
      setClock(Date.now());
      setSession(sessionInfo());
    }, 1000);
    return () => clearInterval(t);
  }, []);

  // Ordering for display and keyboard navigation.
  const ordered = useMemo(() => {
    const list = [...companies];
    if (sortMode === "delta") {
      list.sort((a, b) => Math.abs(b.delta ?? -999) - Math.abs(a.delta ?? -999));
    } else {
      list.sort((a, b) => a.ticker.localeCompare(b.ticker));
    }
    return list;
  }, [companies, sortMode]);
  const orderRef = useRef<string[]>([]);
  useEffect(() => {
    orderRef.current = ordered.map((c) => c.id);
  }, [ordered]);

  // Keyboard: j/k or arrows move, 1-4 windows, f cycles filter, c toggles chart mode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
  }, [feedFilter]);

  const tickerOf = useCallback(
    (id: string) => companies.find((c) => c.id === id)?.ticker ?? id.slice(0, 4).toUpperCase(),
    [companies],
  );
  const totalMentions = companies.reduce((acc, c) => acc + c.mentions24h, 0);
  const filteredMentions = useMemo(() => applyFilter(mentions, feedFilter), [mentions, feedFilter]);

  return (
    <div className="flex h-full flex-col">
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
              className="tabnum flex items-center gap-1 rounded border border-white/10 px-1.5 py-[1px] text-[9.5px] text-white/50 hover:bg-white/[0.05]"
              title="toggle sort (delta movement vs alphabetical)"
            >
              {sortMode === "delta" ? "Δ MOVE" : "A-Z"}
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

        <main className="min-h-0 overflow-y-auto px-5 py-4">
          {selected ? (
            <div className="mx-auto max-w-3xl">
              <div className="panel flex flex-wrap items-center gap-6 px-5 py-4">
                <Gauge value={selected.index} />
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
                        <span
                          className="tabnum rounded px-1.5 py-0.5 text-[10.5px] font-medium"
                          style={{
                            color: c > 0.001 ? "#34d399" : c < -0.001 ? "#f87171" : "#94a3b8",
                            background: "rgba(255,255,255,0.04)",
                          }}
                        >
                          ${q.price.toFixed(2)} {c > 0 ? "+" : ""}
                          {c.toFixed(2)}%
                        </span>
                      );
                    })()}
                  </div>
                  <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-white/40">
                    <span>
                      {selected.sector} · {selected.mentions24h} mentions in 24h · last {timeAgo(selected.lastMentionAt)}
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
                <div className="flex flex-col gap-1">
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

              <div className="panel mt-4">
                <div className="panel-head">
                  <span className="micro">
                    {chartMode === "overlay" ? "Sentiment × Price" : "Sentiment"}
                  </span>
                  <div className="flex items-center gap-2 text-[9.5px] text-white/40">
                    <span className="flex items-center gap-1">
                      <span className="inline-block h-[2px] w-3 bg-emerald-400" /> sentiment
                    </span>
                    {chartMode === "overlay" && (
                      <span className="flex items-center gap-1">
                        <span className="inline-block h-[2px] w-3 bg-white/80" /> price
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
                <div className="px-3 py-3 pl-9">
                  <SeriesChart
                    points={series}
                    hours={windowHours}
                    loading={seriesLoading && series.length === 0}
                    mode={chartMode}
                    price={price}
                  />
                </div>
              </div>

              <OutcomeCheck companyId={selected.id} hours={windowHours} refreshToken={tape.length} />
              <ValidationPanel />

              <div className="mb-2 mt-5 flex items-center justify-between">
                <span className="micro">
                  Mentions · {health?.health.jev.model ?? "jev"}
                </span>
                <div className="flex items-center gap-1">
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
                      <kbd className="ml-1 opacity-0 group-hover:opacity-100">f</kbd>
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex flex-col gap-1.5 pb-6">
                {filteredMentions.map((m) => (
                  <MentionCard key={m.id} m={m} dense />
                ))}
                {filteredMentions.length === 0 && (
                  <div className="panel px-4 py-6 text-[12px] text-white/35">
                    {mentions.length === 0
                      ? "No mentions in this window yet. New mentions are scored within seconds of arrival."
                      : "Nothing matches this filter."}
                  </div>
                )}
              </div>
            </div>
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
          <Tape mentions={tape} tickerOf={tickerOf} />

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
  );
}
