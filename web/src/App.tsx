import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getJSON,
  openStream,
  type CompanySnapshot,
  type HealthDTO,
  type Mention,
  type SeriesPoint,
} from "./lib/api.js";
import { Header } from "./components/Header.js";
import { Watchlist, DeltaChip } from "./components/Watchlist.js";
import { Gauge } from "./components/Gauge.js";
import { SeriesChart } from "./components/SeriesChart.js";
import { MentionCard } from "./components/MentionCard.js";
import { Tape } from "./components/Tape.js";
import { HealthPanel } from "./components/HealthPanel.js";
import { timeAgo } from "./lib/format.js";

const WINDOWS = [
  { h: 6, label: "6H" },
  { h: 24, label: "24H" },
  { h: 72, label: "3D" },
  { h: 168, label: "7D" },
];

export default function App() {
  const [companies, setCompanies] = useState<CompanySnapshot[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tape, setTape] = useState<Mention[]>([]);
  const [mentions, setMentions] = useState<Mention[]>([]);
  const [series, setSeries] = useState<SeriesPoint[]>([]);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const [sparks, setSparks] = useState<Record<string, SeriesPoint[]>>({});
  const [health, setHealth] = useState<HealthDTO | null>(null);
  const [connected, setConnected] = useState(false);
  const [demo, setDemo] = useState(false);
  const [windowHours, setWindowHours] = useState(24);
  const [clock, setClock] = useState(Date.now());

  const selectedIdRef = useRef<string | null>(null);
  const windowRef = useRef(24);
  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);
  useEffect(() => {
    windowRef.current = windowHours;
  }, [windowHours]);

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

  // Initial load: watchlist, tape, health snapshot.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cs = await getJSON<CompanySnapshot[]>("/api/companies");
        if (!alive) return;
        setCompanies(cs);
        setSelectedId((prev) => prev ?? cs[0]?.id ?? null);
      } catch {
        /* server not up yet; the health poll retries */
      }
      try {
        const t = await getJSON<Mention[]>("/api/tape?limit=50");
        if (alive) setTape(t);
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
          setMentions((prev) => (prev.some((x) => x.id === m.id) ? prev : [m, ...prev].slice(0, 80)));
        }
        const now = Date.now();
        if (now - lastSeriesRefresh > 8_000) {
          lastSeriesRefresh = now;
          void refreshSeries();
        }
      },
      onCompany: (s) => setCompanies((prev) => prev.map((c) => (c.id === s.id ? s : c))),
    });
    return close;
  }, [refreshSeries]);

  // Series for the selected company: on select/window change and every 30s.
  useEffect(() => {
    if (!selectedId) return;
    void refreshSeries(selectedId);
    const t = setInterval(() => void refreshSeries(selectedId), 30_000);
    return () => clearInterval(t);
  }, [selectedId, windowHours, refreshSeries]);

  // Mentions for the selected company.
  useEffect(() => {
    if (!selectedId) return;
    let alive = true;
    (async () => {
      try {
        const ms = await getJSON<Mention[]>(`/api/companies/${selectedId}/mentions?hours=72&limit=60`);
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
      const ids = (await getJSON<CompanySnapshot[]>("/api/companies").catch(() => [] as CompanySnapshot[])).map(
        (c) => c.id,
      );
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

  // Clock.
  useEffect(() => {
    const t = setInterval(() => setClock(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const tickerOf = useCallback(
    (id: string) => companies.find((c) => c.id === id)?.ticker ?? id.slice(0, 4).toUpperCase(),
    [companies],
  );
  const totalMentions = companies.reduce((acc, c) => acc + c.mentions24h, 0);

  return (
    <div className="flex h-full flex-col">
      <Header connected={connected} demo={demo} health={health} totalMentions={totalMentions} clock={clock} />

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[300px_minmax(0,1fr)] xl:grid-cols-[300px_minmax(0,1fr)_320px]">
        <aside className="hidden min-h-0 overflow-y-auto border-r border-desk-line lg:block">
          <div className="px-4 pb-1.5 pt-3 text-[10px] font-medium uppercase tracking-[0.16em] text-white/35">
            Watchlist
          </div>
          <Watchlist companies={companies} selectedId={selectedId} sparks={sparks} onSelect={setSelectedId} />
        </aside>

        <main className="min-h-0 overflow-y-auto px-5 py-4">
          {selected ? (
            <div className="mx-auto max-w-3xl">
              <div className="panel flex flex-wrap items-center gap-6 px-5 py-4">
                <Gauge value={selected.index} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <h1 className="text-[19px] font-semibold">{selected.name}</h1>
                    <span className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[11px] font-medium text-white/60">
                      {selected.ticker}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[12px] text-white/40">
                    {selected.sector} · {selected.mentions24h} mentions in 24h · last {timeAgo(selected.lastMentionAt)}
                  </div>
                  <div className="mt-2 flex items-center gap-2 text-[12px]">
                    <DeltaChip delta={selected.delta} />
                    <span className="text-white/30">vs trailing 24h</span>
                  </div>
                </div>
                <div className="flex flex-col gap-1">
                  {WINDOWS.map((w) => (
                    <button
                      key={w.h}
                      onClick={() => setWindowHours(w.h)}
                      className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                        windowHours === w.h
                          ? "bg-white/[0.09] text-white"
                          : "text-white/40 hover:bg-white/[0.04] hover:text-white/70"
                      }`}
                    >
                      {w.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="panel mt-4 px-3 py-3 pl-9">
                <SeriesChart points={series} hours={windowHours} loading={seriesLoading && series.length === 0} />
              </div>

              <div className="mb-2 mt-5 text-[10px] font-medium uppercase tracking-[0.16em] text-white/35">
                Mentions · scored by {health?.health.jev.model ?? "jev"}
              </div>
              <div className="flex flex-col gap-2 pb-6">
                {mentions.map((m) => (
                  <MentionCard key={m.id} m={m} />
                ))}
                {mentions.length === 0 && (
                  <div className="panel px-4 py-6 text-[12px] text-white/35">
                    No scored mentions in this window yet. New mentions are scored within seconds of arrival.
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
          <div className="px-4 pb-1.5 pt-3 text-[10px] font-medium uppercase tracking-[0.16em] text-white/35">
            Live tape
          </div>
          <Tape mentions={tape} tickerOf={tickerOf} />
          <div className="mt-3 border-t border-desk-line">
            <div className="px-4 pb-1.5 pt-3 text-[10px] font-medium uppercase tracking-[0.16em] text-white/35">
              Desk health
            </div>
            <HealthPanel health={health} />
          </div>
        </aside>
      </div>
    </div>
  );
}
