export const POS = "#34d399";
export const NEG = "#f87171";
export const NEU = "#94a3b8";

export function sentimentColor(s: string | null | undefined): string {
  if (s === "positive") return POS;
  if (s === "negative") return NEG;
  return NEU;
}

export function fmtIndex(v: number | null | undefined): string {
  if (v == null) return "--";
  return (v > 0 ? "+" : "") + v.toFixed(1);
}

export function fmtDelta(v: number | null | undefined): string {
  if (v == null) return "--";
  return (v > 0 ? "+" : "") + v.toFixed(1);
}

export function fmtCost(usd: number): string {
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(3)}`;
  if (usd > 0) return `$${usd.toFixed(4)}`;
  return "$0";
}

export function timeAgo(ms: number | null | undefined, now = Date.now()): string {
  if (ms == null) return "never";
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 10) return "now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function quoteSourceAgeLabel(at: number | null, now = Date.now()): string | null {
  if (at == null) return "source time unknown";
  if (at > now) return "source time is in the future";
  if (now - at <= 15 * 60_000) return null;
  return `source ${timeAgo(at, now)}`;
}

export function clockTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function shortTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function sourceDateTime(ms: number): string {
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", timeZoneName: "short",
  }).format(new Date(ms));
}

export function dayTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export const TIER_LABEL: Record<string, string> = {
  wire: "Wire",
  major: "Major",
  trade: "Trade",
  blog: "Retail/Blog",
  social: "Social",
};
