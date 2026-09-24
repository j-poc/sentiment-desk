/**
 * Semicircular meter from -100 to 100: muted track, a value arc that grows
 * from the neutral top toward the current reading (green right, red left),
 * a clean needle with hub, and the value centered below. Reads like an
 * instrument, not a speedometer toy.
 */

const POS = "#34d399";
const NEG = "#f87171";
const NEU = "#94a3b8";

export function Gauge({ value, size = 120 }: { value: number | null; size?: number }) {
  const v = Math.max(-100, Math.min(100, value ?? 0));
  const hasValue = value != null;

  const R = 38;
  const CX = 50;
  const CY = 50;
  const rad = (deg: number) => (deg * Math.PI) / 180;
  // Angle convention: 0° = right (+100), 90° = top (0), 180° = left (-100).
  const angle = 90 - (v / 100) * 90;
  const pt = (deg: number, r: number) => ({
    x: CX + r * Math.cos(rad(deg)),
    y: CY - r * Math.sin(rad(deg)),
  });

  const trackStart = pt(180, R);
  const trackEnd = pt(0, R);
  const valStart = pt(90, R);
  const valEnd = pt(angle, R);
  const sweep: 0 | 1 = v >= 0 ? 1 : 0;

  const color = !hasValue ? NEU : v > 3 ? POS : v < -3 ? NEG : NEU;

  const ticks = [-100, -50, 0, 50, 100].map((t) => {
    const a = 90 - (t / 100) * 90;
    return { t, outer: pt(a, R + 4), inner: pt(a, R - 1) };
  });

  return (
    <div className="flex flex-col items-center" style={{ width: size }}>
      <svg viewBox="0 0 100 58" style={{ width: size, overflow: "visible" }}>
        {/* track */}
        <path
          d={`M ${trackStart.x.toFixed(2)} ${trackStart.y.toFixed(2)} A ${R} ${R} 0 0 1 ${trackEnd.x.toFixed(2)} ${trackEnd.y.toFixed(2)}`}
          fill="none"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth="5"
          strokeLinecap="round"
        />
        {/* value arc from neutral toward the reading */}
        {hasValue && Math.abs(v) > 1 && (
          <path
            d={`M ${valStart.x.toFixed(2)} ${valStart.y.toFixed(2)} A ${R} ${R} 0 0 ${sweep} ${valEnd.x.toFixed(2)} ${valEnd.y.toFixed(2)}`}
            fill="none"
            stroke={color}
            strokeWidth="5"
            strokeLinecap="round"
            opacity="0.95"
          />
        )}
        {/* ticks */}
        {ticks.map(({ t, outer, inner }) => (
          <line
            key={t}
            x1={inner.x}
            y1={inner.y}
            x2={outer.x}
            y2={outer.y}
            stroke={t === 0 ? "rgba(255,255,255,0.4)" : "rgba(255,255,255,0.18)"}
            strokeWidth={t === 0 ? 1.4 : 0.8}
          />
        ))}
        {/* needle: drawn at neutral (up), rotated by the reading — keeps the
            entry animation as a smooth swing rather than a jump cut. */}
        {hasValue && (
          <g
            style={{
              transform: `rotate(${(v / 100) * 90}deg)`,
              transformOrigin: `${CX}px ${CY}px`,
              transition: "transform 900ms cubic-bezier(0.22, 1, 0.36, 1)",
            }}
          >
            <line x1={CX} y1={CY} x2={CX} y2={CY - (R - 7)} stroke="#e8ebf2" strokeWidth="2" strokeLinecap="round" />
            <line
              x1={CX}
              y1={CY}
              x2={CX}
              y2={CY + 7}
              stroke="rgba(232,235,242,0.35)"
              strokeWidth="3"
              strokeLinecap="round"
            />
          </g>
        )}
        <circle cx={CX} cy={CY} r="4" fill="#0e1016" stroke="rgba(255,255,255,0.55)" strokeWidth="1.4" />
        <circle cx={CX} cy={CY} r="1.4" fill="#e8ebf2" />
      </svg>
      <div
        className="tabnum -mt-1 font-semibold leading-none"
        style={{ fontSize: Math.max(16, Math.round(size * 0.19)), color: hasValue ? color : "rgba(232,235,242,0.35)" }}
      >
        {hasValue ? `${v > 0 ? "+" : ""}${v.toFixed(1)}` : "--"}
      </div>
    </div>
  );
}
