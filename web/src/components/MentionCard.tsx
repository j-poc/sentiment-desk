import type { Mention } from "../lib/api.js";
import { NEU, fmtIndex, sentimentColor, shortTime } from "../lib/format.js";

const TIER_DOT: Record<string, string> = {
  wire: "#e2e8f0",
  major: "#7dd3fc",
  trade: "#94a3b8",
  blog: "#c4b5fd",
  social: "#fda4af",
  filing: "#fbbf24", // filings outrank everything: gold
};

const TYPE_LABEL: Record<string, string> = {
  results: "RESULTS",
  corporate_action: "CORP ACT",
  legal_regulatory: "LEGAL",
  leadership: "LEADERSHIP",
  product: "PRODUCT",
  analyst_action: "ANALYST",
  macro_sector: "MACRO",
  other: "NEWS",
};

export function Pill({
  children,
  color,
  dim,
}: {
  children: React.ReactNode;
  color?: string;
  dim?: boolean;
}) {
  return (
    <span
      className="rounded-md border px-1.5 py-[1px] text-[10px] font-medium"
      style={
        dim
          ? { borderColor: "rgba(255,255,255,0.12)", color: "rgba(232,235,242,0.45)", background: "rgba(255,255,255,0.03)" }
          : {
              borderColor: `${color}33`,
              color,
              background: `${color}14`,
            }
      }
    >
      {children}
    </span>
  );
}

export function MentionCard({
  m,
  compact,
  dense,
  onOpen,
}: {
  m: Mention;
  compact?: boolean;
  dense?: boolean;
  onOpen?: (m: Mention) => void;
}) {
  const s = m.score;
  const dir = s ? sentimentColor(s.sentiment) : NEU;
  const offTarget = m.status === "off_target";

  const body = (
    <>
      <div className="flex items-center gap-2 text-[11px] text-desk-dim">
        <span
          className="inline-block h-1.5 w-1.5 shrink-0 rounded-full"
          style={{ background: TIER_DOT[m.source.tier] ?? NEU }}
          title={m.source.tier}
        />
        <span className="truncate">{m.source.name}</span>
        <span className="text-white/20">·</span>
        <span className="tabnum shrink-0">{shortTime(m.publishedAt)}</span>
        {s && (
          <span className="tabnum ml-auto shrink-0 font-medium" style={{ color: dir }}>
            {fmtIndex(s.impact)}
          </span>
        )}
      </div>

      <div className={`mt-1.5 leading-snug text-desk-bright ${compact || dense ? "clamp-1 text-[12px]" : "clamp-2 text-[13px]"}`}>
        {m.title}
      </div>

      {m.status === "pending" && <div className="mt-2 text-[11px] text-white/35">awaiting judgment…</div>}
      {m.status === "failed" && (
        <div className="mt-2 text-[11px] text-red-400/80" title={m.error ?? ""}>
          scoring failed
        </div>
      )}

      {s && (
        <div className={`flex flex-wrap items-center gap-1.5 ${dense ? "mt-1" : "mt-2.5"}`}>
          <Pill color={dir}>{s.sentiment.toUpperCase()}</Pill>
          {m.source.kind === "sec" && <Pill color="#fbbf24">8-K FILING</Pill>}
          <Pill color="#a5b4fc">{TYPE_LABEL[s.eventType] ?? "NEWS"}</Pill>
          {s.eventScore >= 60 && <Pill color="#fbbf24">EVENT {Math.round(s.eventScore)}</Pill>}
          {s.surprise >= 0.7 && s.novel >= 0.6 && <Pill color="#5eead4">FRESH</Pill>}
          {s.material >= 0.6 && <Pill color="#a5b4fc">MATERIAL</Pill>}
          {s.novel >= 0.6 && s.surprise < 0.7 && <Pill color="#5eead4">NEW INFO</Pill>}
          {(m.confirmations ?? 1) >= 3 && <Pill color="#67e8f9">×{m.confirmations} SOURCES</Pill>}
          {s.confidence < 0.55 && <Pill color="#fbbf24">LOW CONF</Pill>}
          {offTarget && <Pill dim>OFF TARGET</Pill>}
          <span className="ml-auto flex items-center gap-1.5 text-[10px] text-white/35">
            <span className="tabnum">{Math.round(s.confidence * 100)}%</span>
            <span className="inline-block h-[3px] w-7 overflow-hidden rounded-full bg-white/10">
              <span
                className="block h-full rounded-full"
                style={{ width: `${Math.round(s.confidence * 100)}%`, background: dir }}
              />
            </span>
            <span className="tabnum">{s.latencyMs}ms</span>
          </span>
        </div>
      )}
    </>
  );

  const cls = `panel block text-left transition-colors hover:border-white/15 ${dense ? "px-3 py-2" : "px-3.5 py-3"} ${
    offTarget ? "opacity-55" : ""
  }`;

  if (onOpen) {
    return (
      <button type="button" onClick={() => onOpen(m)} className={`${cls} cursor-pointer`}>
        {body}
      </button>
    );
  }
  return (
    <a href={m.source.url} target="_blank" rel="noreferrer" className={cls}>
      {body}
    </a>
  );
}
