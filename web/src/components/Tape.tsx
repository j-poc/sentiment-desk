import type { Mention } from "../lib/api.js";
import { TAKEAWAY_LABEL } from "./MentionCard.js";
import { fmtIndex, sentimentColor, shortTime } from "../lib/format.js";

const ARROW: Record<string, string> = { positive: "▲", negative: "▼", neutral: "·" };

/** The live tape: every scored mention across the watchlist, newest first. */
export function Tape({
  mentions,
  tickerOf,
  onOpen,
}: {
  mentions: Mention[];
  tickerOf: (companyId: string) => string;
  onOpen?: (m: Mention) => void;
}) {
  const newest = mentions[0]?.id;
  return (
    <div className="flex flex-col">
      {mentions.length === 0 && (
        <div className="px-4 py-6 text-[11px] text-white/30">Waiting for scored mentions…</div>
      )}
      {mentions.map((m) => {
        const s = m.score;
        const dir = s ? sentimentColor(s.sentiment) : "#64748b";
        return (
          <a
            key={m.id}
            href={m.source.url}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => {
              if (onOpen) {
                e.preventDefault();
                onOpen(m);
              }
            }}
            className={`flex items-baseline gap-2 border-b border-white/[0.04] px-4 py-2.5 transition-colors hover:bg-white/[0.03] ${
              m.id === newest ? "flash-in" : ""
            }`}
          >
            <span className="tabnum w-9 shrink-0 text-[10px] text-white/35">{shortTime(m.publishedAt)}</span>
            <span className="w-11 shrink-0 truncate text-[10.5px] font-semibold text-white/55">
              {tickerOf(m.companyId)}
            </span>
            <span className="shrink-0 text-[9px]" style={{ color: dir }}>
              {s ? ARROW[s.sentiment] : "…"}
            </span>
            {s && s.takeaway !== "routine" ? (
              <span className="clamp-1 min-w-0 flex-1 text-[11.5px]">
                <span className="font-semibold uppercase tracking-wide" style={{ color: dir }}>
                  {TAKEAWAY_LABEL[s.takeaway] ?? s.takeaway}
                </span>
                <span className="text-white/45"> — {m.title}</span>
              </span>
            ) : (
              <span className="clamp-1 min-w-0 flex-1 text-[12px] text-white/80">{m.title}</span>
            )}
            {s && (
              <span className="tabnum w-10 shrink-0 text-right text-[11px]" style={{ color: dir }}>
                {fmtIndex(s.impact)}
              </span>
            )}
          </a>
        );
      })}
    </div>
  );
}
