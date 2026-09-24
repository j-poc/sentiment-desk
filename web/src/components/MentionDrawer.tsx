import { useEffect } from "react";
import type { Mention } from "../lib/api.js";
import { TAKEAWAY_LABEL } from "./MentionCard.js";
import { NEU, fmtIndex, sentimentColor, shortTime, timeAgo } from "../lib/format.js";

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

/**
 * The detail sidebar: everything the desk knows about one judgment, opened
 * from any mention row instead of demanding scroll space on the main screen.
 */
export function MentionDrawer({ mention, onClose }: { mention: Mention | null; onClose: () => void }) {
  useEffect(() => {
    if (!mention) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mention, onClose]);

  if (!mention) return null;
  const s = mention.score;
  const dir = s ? sentimentColor(s.sentiment) : NEU;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />
      <aside
        className="fixed inset-y-0 right-0 z-50 flex w-[440px] max-w-[92vw] flex-col border-l border-desk-line bg-[#0b0d13] shadow-2xl"
        style={{ animation: "rise-in 0.18s ease-out" }}
      >
        <div className="panel-head shrink-0">
          <span className="micro">Mention detail</span>
          <button
            onClick={onClose}
            className="tabnum rounded border border-white/10 px-2 py-[1px] text-[10px] text-white/50 hover:bg-white/[0.05]"
          >
            esc
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3.5">
          <div className="flex items-center gap-2 text-[11px] text-desk-dim">
            <span
              className="inline-block h-1.5 w-1.5 rounded-full"
              style={{ background: dir }}
            />
            <span className="truncate">{mention.source.name}</span>
            <span className="text-white/20">·</span>
            <span className="tabnum">{shortTime(mention.publishedAt)}</span>
            <span className="text-white/20">·</span>
            <span>{timeAgo(mention.publishedAt)}</span>
          </div>

          {s && s.takeaway !== "routine" && (
            <div className="mt-2 text-[12px] font-semibold uppercase tracking-wide" style={{ color: dir }}>
              {TAKEAWAY_LABEL[s.takeaway] ?? s.takeaway}
            </div>
          )}
          <h2 className={`font-semibold leading-snug text-desk-bright ${s && s.takeaway !== "routine" ? "mt-1 text-[13px] text-white/60" : "mt-2 text-[15px]"}`}>
            {mention.title}
          </h2>
          {mention.snippet && mention.snippet !== mention.title && (
            <p className="mt-2 text-[12px] leading-relaxed text-white/55">{mention.snippet}</p>
          )}

          {s ? (
            <>
              <div className="mt-4 flex items-center gap-3">
                <div className="tabnum text-[26px] font-semibold" style={{ color: dir }}>
                  {fmtIndex(s.impact)}
                </div>
                <div className="text-[11px] leading-tight text-white/45">
                  <div style={{ color: dir }}>{s.sentiment.toUpperCase()}</div>
                  <div>
                    event strength <span className="tabnum text-white/70">{Math.round(s.eventScore)}</span>
                  </div>
                </div>
                <div className="ml-auto text-right text-[10px] text-white/35">
                  <div className="tabnum">{s.latencyMs}ms judge</div>
                  <div className="tabnum">${s.costUsd.toFixed(5)}</div>
                </div>
              </div>

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
                <div className="flex justify-between py-[2px]">
                  <span>published / retrieved</span>
                  <span className="tabnum text-white/70">
                    {shortTime(mention.publishedAt)} / {shortTime(mention.retrievedAt)}
                  </span>
                </div>
                {(mention.confirmations ?? 1) > 1 && (
                  <div className="flex justify-between py-[2px]">
                    <span>sources covering</span>
                    <span className="tabnum text-white/70">×{mention.confirmations}</span>
                  </div>
                )}
                {mention.status === "off_target" && (
                  <div className="py-[2px] text-amber-400/80">excluded from every index (off-target)</div>
                )}
              </div>
            </>
          ) : (
            <div className="mt-4 text-[11.5px] text-white/40">
              {mention.status === "failed" ? `Scoring failed: ${mention.error ?? "unknown error"}` : "Awaiting judgment…"}
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-desk-line p-3">
          <a
            href={mention.source.url}
            target="_blank"
            rel="noreferrer"
            className="block rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-center text-[11.5px] font-medium text-white/80 hover:bg-white/[0.07]"
          >
            Open original source ↗
          </a>
        </div>
      </aside>
    </>
  );
}
