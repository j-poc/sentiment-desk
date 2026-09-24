import { useId } from "react";
import { fmtIndex } from "../lib/format.js";

/**
 * Semicircular meter from -100 to 100. The needle eases toward its target so
 * live updates read as motion, not a jump cut.
 */
export function Gauge({ value, size = 148 }: { value: number | null; size?: number }) {
  const gradId = useId();
  const v = Math.max(-100, Math.min(100, value ?? 0));
  const angle = (v / 100) * 90;

  const ticks = [-100, -50, 0, 50, 100].map((t) => {
    const a = ((t / 100) * 90 * Math.PI) / 180;
    const outer = { x: 50 + 46 * Math.sin(a), y: 54 - 46 * Math.cos(a) };
    const inner = { x: 50 + 41 * Math.sin(a), y: 54 - 41 * Math.cos(a) };
    return { t, outer, inner, major: t === 0 };
  });

  return (
    <div className="flex flex-col items-center" style={{ width: size }}>
      <svg viewBox="0 0 100 60" style={{ width: size, overflow: "visible" }}>
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#f87171" stopOpacity="0.95" />
            <stop offset="42%" stopColor="#5b6472" />
            <stop offset="58%" stopColor="#5b6472" />
            <stop offset="100%" stopColor="#34d399" stopOpacity="0.95" />
          </linearGradient>
        </defs>
        <path
          d="M 8 54 A 42 42 0 0 1 92 54"
          fill="none"
          stroke={`url(#${gradId})`}
          strokeWidth="4.5"
          strokeLinecap="round"
        />
        {ticks.map(({ t, outer, inner, major }) => (
          <line
            key={t}
            x1={inner.x}
            y1={inner.y}
            x2={outer.x}
            y2={outer.y}
            stroke="rgba(255,255,255,0.35)"
            strokeWidth={major ? 1.4 : 0.8}
          />
        ))}
        <g
          style={{
            transform: `rotate(${angle}deg)`,
            transformOrigin: "50px 54px",
            transition: "transform 900ms cubic-bezier(0.22, 1, 0.36, 1)",
          }}
        >
          <line x1="50" y1="54" x2="50" y2="15" stroke="#e8ebf2" strokeWidth="2.4" strokeLinecap="round" />
          <circle cx="50" cy="15" r="1.8" fill="#e8ebf2" />
        </g>
        <circle cx="50" cy="54" r="3.6" fill="#e8ebf2" />
        <circle cx="50" cy="54" r="1.6" fill="#0e1016" />
      </svg>
      <div className="tabnum -mt-2 text-[26px] font-semibold leading-none">
        {fmtIndex(value)}
      </div>
    </div>
  );
}
