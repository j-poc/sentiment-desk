import { clockTime } from "../lib/format.js";

export function Header({ totalMentions, clock }: { totalMentions: number; clock: number }) {
  return (
    <header className="flex h-[46px] shrink-0 items-center gap-2 border-b border-desk-line bg-black/50 px-2 backdrop-blur sm:gap-4 sm:px-4">
      <div className="flex min-w-0 items-center gap-1.5 sm:gap-2.5">
        <svg width="22" height="22" viewBox="0 0 32 32" aria-hidden>
          <rect width="32" height="32" rx="8" fill="rgba(255,255,255,0.06)" />
          <path d="M8 22a8 8 0 0 1 16 0" stroke="#34d399" strokeWidth="2.5" fill="none" strokeLinecap="round" />
          <line x1="16" y1="22" x2="21" y2="13" stroke="#e8ebf2" strokeWidth="2.5" strokeLinecap="round" />
        </svg>
        <div className="whitespace-nowrap text-[10px] font-semibold tracking-[0.1em] sm:text-[12px] sm:tracking-[0.24em]">SENTIMENT DESK</div>
      </div>

      <div className="ml-auto flex items-center gap-2 text-[9px] text-white/45 sm:gap-5 sm:text-[11px]">
        <span className="tabnum hidden sm:inline">
          {totalMentions.toLocaleString()} source {totalMentions === 1 ? "record" : "records"} retrieved in 24h
        </span>
        <span className="tabnum w-16 text-right sm:inline">{clockTime(clock)}</span>
      </div>
    </header>
  );
}
