import type { Mention } from "../lib/api.js";
import { NEU, fmtIndex, sentimentColor, sourceDateTime, timeAgo } from "../lib/format.js";
import { sourceClockForMention } from "../lib/source-clock.js";
import { differentPossessiveHeadlineSubject, otherExplicitTickerSymbols, sourceLinkPathNamesCompany } from "../lib/issuer-symbols.js";
import { CategoricalJudgment } from "./CategoricalJudgment.js";

const TIER_DOT: Record<string, string> = {
  wire: "#e2e8f0",
  major: "#7dd3fc",
  trade: "#94a3b8",
  blog: "#c4b5fd",
  social: "#fda4af",
  filing: "#fbbf24", // filings outrank everything: gold
};

export const TAKEAWAY_LABEL: Record<string, string> = {
  results_beat: "Results beat",
  results_miss: "Results miss",
  guidance_raise: "Guidance raised",
  guidance_cut: "Guidance cut",
  accounting_redo: "Accounting redo",
  listing_risk: "Delisting risk",
  mna_capital: "M&A / capital move",
  leadership: "Leadership change",
  legal_hit: "Legal / regulatory hit",
  legal_relief: "Legal / regulatory relief",
  product_win: "Product / ops win",
  product_setback: "Product / ops setback",
  analyst_shift: "Analyst view shift",
  routine: "Routine / context",
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
  title,
}: {
  children: React.ReactNode;
  color?: string;
  dim?: boolean;
  title?: string;
}) {
  return (
    <span
      className="rounded-md border px-1.5 py-[1px] text-[10px] font-medium"
      title={title}
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
  tickerOf,
  knownTickers = [],
  companyNameOf,
}: {
  m: Mention;
  compact?: boolean;
  dense?: boolean;
  onOpen?: (m: Mention) => void;
  tickerOf?: (companyId: string) => string;
  knownTickers?: readonly string[];
  companyNameOf?: (companyId: string) => string;
}) {
  const s = m.score;
  const dir = s ? sentimentColor(s.sentiment) : NEU;
  const impactColor = s ? (s.impact > 0 ? "#34d399" : s.impact < 0 ? "#f87171" : NEU) : NEU;
  const offTarget = m.status === "off_target" || m.status === "excluded";
  const sourceClock = sourceClockForMention(m);
  const publisher = m.publisherName || m.source.publisher || m.source.name;
  const issuerName = companyNameOf?.(m.companyId);
  const issuerTicker = tickerOf?.(m.companyId);
  const otherSymbols = issuerTicker ? otherExplicitTickerSymbols(`${m.title} ${m.snippet}`, issuerTicker, knownTickers) : [];
  const leadSubject = issuerName && issuerTicker
    ? differentPossessiveHeadlineSubject(m.title, m.snippet, issuerName, issuerTicker)
    : null;
  const titleLinkConflict = Boolean(leadSubject && issuerName && sourceLinkPathNamesCompany(m.source.url, issuerName));

  const body = (
    <>
      <div className="mention-card-meta text-[11px] text-desk-dim" role="group" aria-label="Source and freshness details">
        <span className="mention-card-meta-item mention-card-meta-publisher" role="group" aria-label={`Publisher: ${publisher}`} title={`Publisher: ${publisher}`}>
          <span className="mention-card-meta-label">Publisher</span>
          <span className="mention-card-publisher"><span
            aria-hidden="true"
            className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle"
            style={{ background: TIER_DOT[m.source.tier] ?? NEU }}
            title={m.source.tier}
          />{publisher}</span>
        </span>
        <span className="mention-card-meta-item mention-card-meta-source-time" role="group" aria-label={`${sourceClock.label}: ${sourceClock.at == null ? "time unavailable" : sourceDateTime(sourceClock.at)}`}>
          <span className="mention-card-meta-label">Source time</span>
          {sourceClock.at == null
            ? <span className="tabnum">{sourceClock.label}</span>
            : <time className="tabnum" dateTime={new Date(sourceClock.at).toISOString()} title={`${sourceClock.context} ${new Date(sourceClock.at).toISOString()}`}>
                {sourceClock.label}: {sourceDateTime(sourceClock.at)}
              </time>}
        </span>
        <span className="mention-card-meta-item mention-card-meta-retrieved" role="group" aria-label={`Retrieved ${new Date(m.retrievedAt).toISOString()}; ${timeAgo(m.retrievedAt)}`}>
          <span className="mention-card-meta-label">Retrieved</span>
          <time className="text-[10.5px] text-white/65" dateTime={new Date(m.retrievedAt).toISOString()} title={`Retrieved ${new Date(m.retrievedAt).toISOString()}`}>{timeAgo(m.retrievedAt)}</time>
        </span>
        {s && (
          <span
            className="mention-card-meta-item mention-card-meta-impact tabnum font-medium"
            role="group"
            style={{ color: impactColor }}
            title="Directional impact is 100 × [Jev P(positive) − P(negative)] impact points. It can be positive or negative even when the most likely class is neutral."
            aria-label={`Jev directional impact ${fmtIndex(s.impact)}; most likely sentiment class ${s.sentiment}. Impact is 100 times positive probability minus negative probability, in impact points.`}
          >
            <span className="mention-card-meta-label">Historical Jev impact</span>
            <span>impact {fmtIndex(s.impact)}</span>
          </span>
        )}
      </div>

      {/* The takeaway IS the headline; the raw wire title is supporting detail. */}
      {s && s.takeaway !== "routine" && (
        <div className="mt-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: dir }}>
          {TAKEAWAY_LABEL[s.takeaway] ?? s.takeaway}
        </div>
      )}
      <div
        className={`leading-snug ${
          s && s.takeaway !== "routine"
            ? "mt-0.5 clamp-2 text-[11.5px] text-white/50"
            : compact
              ? "mt-1.5 clamp-1 text-[12px] text-desk-bright"
              : "mt-1.5 clamp-2 text-[12.5px] text-desk-bright"
        }`}
      >
        {m.title}
      </div>

      {m.analystResearchDisposition === "dismissed" && (
        <div className="mt-1 text-[10px] text-amber-100/70">Set aside by you · source remains saved</div>
      )}
      {m.issuerIdentityStrong === false && (
        <div className="mt-1 text-[10px] text-amber-100/70">Issuer match uncertain · may still concern this company</div>
      )}
      {m.issuerIdentityStrong !== false && issuerTicker && otherSymbols.length > 0 && (
        <div className="mt-1 text-[10px] text-amber-100/75" title={`This record is filed under ${issuerTicker} and also names ${otherSymbols.join(", ")}. Check which issuer the source concerns before using it as issuer-specific evidence.`}>
          Also names {otherSymbols.join(", ")} · verify issuer relevance
        </div>
      )}
      {m.issuerIdentityStrong !== false && leadSubject && issuerName && (
        <div className="mt-1 text-[10px] text-amber-100/75" title={titleLinkConflict
          ? `The headline leads with ${leadSubject}, while the saved excerpt and URL path name ${issuerName}. Check that the headline and link belong together; the path does not verify page contents.`
          : `The headline leads with ${leadSubject}, while the saved excerpt also mentions ${issuerName}. Check relevance before using it as issuer-specific evidence.`}>
          {titleLinkConflict
            ? `Headline leads with ${leadSubject}; excerpt and URL path name ${issuerName} · check title/link`
            : `Headline leads with ${leadSubject}; excerpt names ${issuerName} · verify ${issuerTicker} relevance`}
        </div>
      )}
      {m.status === "pending" && <div className="mt-2 text-[11px] text-white/35">awaiting judgment…</div>}
      {m.classification && <CategoricalJudgment judgment={m.classification} />}
      {m.status === "scoring" && <div className="mt-2 text-[11px] text-sky-200/70">Classifying this item…</div>}
      {m.status === "retrying" && (
        <div className="mt-2 text-[11px] text-amber-200/80" title={m.error ?? ""}>
          retry scheduled{m.scoreRetryAt == null ? "" : ` · ${new Date(m.scoreRetryAt).toLocaleTimeString()}`}
        </div>
      )}
      {m.status === "failed" && (
        <div className="mt-2 text-[11px] text-red-400/80" title={m.error ?? ""}>
          scoring failed
        </div>
      )}
      {m.status === "corrupt" && (
        <div className="mt-2 text-[11px] text-amber-300/80" title={m.error ?? ""}>
          Stored model result is incomplete; result withheld
        </div>
      )}

      {s && (
        <div className={`flex flex-wrap items-center gap-1.5 ${dense ? "mt-1" : "mt-2.5"}`}>
          <Pill color={dir}>{s.sentiment.toUpperCase()}</Pill>
          {m.source.kind === "sec" && <Pill color="#fbbf24">8-K FILING</Pill>}
          <Pill color="#a5b4fc">{TYPE_LABEL[s.eventType] ?? "NEWS"}</Pill>
          {s.eventScore >= 60 && <Pill color="#fbbf24">EVENT {Math.round(s.eventScore)}</Pill>}
          {s.surprise >= 0.7 && s.novel >= 0.6 && <Pill color="#5eead4">FRESH</Pill>}
          {s.material >= 0.6 && (
            <Pill color="#a5b4fc" title="Historical Jev model material score meets its 0.60 display threshold. This is not an independently validated materiality finding.">
              JEV MATERIAL
            </Pill>
          )}
          {s.novel >= 0.6 && s.surprise < 0.7 && <Pill color="#5eead4">NEW INFO</Pill>}
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

  const cls = `panel mention-card block min-w-0 max-w-full text-left transition-colors hover:border-white/15 ${dense ? "px-3 py-2" : "px-3.5 py-3"} ${
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
