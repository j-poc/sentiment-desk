/** Expand an exact JSON decimal token, including exponent notation, to plain base-10 text. */
export function normalizeExactDecimal(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 96) return null;
  const match = raw.match(/^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/);
  if (!match) return null;
  const sign = match[1] === "-" ? "-" : "";
  const integer = match[2]!;
  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? "0");
  if (!Number.isSafeInteger(exponent) || exponent < -40 || exponent > 40) return null;
  const digits = `${integer}${fraction}`;
  const decimalAt = integer.length + exponent;
  let normalized: string;
  if (decimalAt <= 0) normalized = `0.${"0".repeat(-decimalAt)}${digits}`;
  else if (decimalAt >= digits.length) normalized = `${digits}${"0".repeat(decimalAt - digits.length)}`;
  else normalized = `${digits.slice(0, decimalAt)}.${digits.slice(decimalAt)}`;
  const [wholeRaw, fractionRaw = ""] = normalized.split(".");
  const whole = wholeRaw!.replace(/^0+(?=\d)/, "");
  const decimal = fractionRaw.replace(/0+$/, "");
  const magnitude = decimal ? `${whole}.${decimal}` : whole;
  if (magnitude.length > 80) return null;
  return /^0(?:\.0*)?$/.test(magnitude) ? "0" : `${sign}${magnitude}`;
}

function decimalParts(value: string): { units: bigint; scale: number } | null {
  const normalized = normalizeExactDecimal(value);
  if (normalized == null) return null;
  const negative = normalized.startsWith("-");
  const magnitude = negative ? normalized.slice(1) : normalized;
  const [whole, fraction = ""] = magnitude.split(".");
  const units = BigInt(`${whole}${fraction}`) * (negative ? -1n : 1n);
  return { units, scale: fraction.length };
}

function decimalText(units: bigint, scale: number): string {
  const negative = units < 0n;
  const digits = (negative ? -units : units).toString().padStart(scale + 1, "0");
  const whole = scale === 0 ? digits : digits.slice(0, -scale);
  const fraction = scale === 0 ? "" : digits.slice(-scale).replace(/0+$/, "");
  const result = fraction ? `${whole}.${fraction}` : whole;
  return /^0(?:\.0*)?$/.test(result) ? "0" : `${negative ? "-" : ""}${result}`;
}

export function decimalComparison(current: string, prior: string): { delta: string; percentChange: string | null } | null {
  const currentParts = decimalParts(current);
  const priorParts = decimalParts(prior);
  if (!currentParts || !priorParts) return null;
  const scale = Math.max(currentParts.scale, priorParts.scale);
  const currentUnits = currentParts.units * 10n ** BigInt(scale - currentParts.scale);
  const priorUnits = priorParts.units * 10n ** BigInt(scale - priorParts.scale);
  const deltaUnits = currentUnits - priorUnits;
  if (priorUnits <= 0n) return { delta: decimalText(deltaUnits, scale), percentChange: null };
  const numerator = deltaUnits * 10_000n;
  let quotient = numerator / priorUnits;
  const remainder = numerator % priorUnits;
  if ((remainder < 0n ? -remainder : remainder) * 2n >= priorUnits) quotient += numerator < 0n ? -1n : 1n;
  return { delta: decimalText(deltaUnits, scale), percentChange: decimalText(quotient, 2) };
}

export function isValidReportedDecimals(value: string): boolean {
  if (value === "INF") return true;
  if (!/^-?(?:0|[1-9]\d?)$/.test(value)) return false;
  const exponent = Number(value);
  return Number.isSafeInteger(exponent) && exponent >= -18 && exponent <= 18;
}

/** Classify a reported difference using a conservative full-quantum error bound. */
export function interpretReportedDifference(
  delta: string,
  currentDecimals: string,
  priorDecimals: string,
): "change_exceeds_precision" | "within_reported_precision" | "no_reported_difference" | null {
  if (!isValidReportedDecimals(currentDecimals) || !isValidReportedDecimals(priorDecimals)) return null;
  const deltaParts = decimalParts(delta);
  if (!deltaParts) return null;
  const quantum = (reportedDecimals: string): { units: bigint; scale: number } => {
    if (reportedDecimals === "INF") return { units: 0n, scale: 0 };
    const exponent = Number(reportedDecimals);
    return exponent < 0
      ? { units: 10n ** BigInt(-exponent), scale: 0 }
      : { units: 1n, scale: exponent };
  };
  const currentQuantum = quantum(currentDecimals);
  const priorQuantum = quantum(priorDecimals);
  const commonScale = Math.max(deltaParts.scale, currentQuantum.scale, priorQuantum.scale);
  const deltaUnits = deltaParts.units * 10n ** BigInt(commonScale - deltaParts.scale);
  const currentUncertainty = currentQuantum.units * 10n ** BigInt(commonScale - currentQuantum.scale);
  const priorUncertainty = priorQuantum.units * 10n ** BigInt(commonScale - priorQuantum.scale);
  // SEC decimals may describe truncation or rounding, so use each full quantum.
  const conservativeBound = currentUncertainty + priorUncertainty;
  const magnitude = deltaUnits < 0n ? -deltaUnits : deltaUnits;
  if (conservativeBound > 0n && magnitude <= conservativeBound) return "within_reported_precision";
  if (conservativeBound === 0n && deltaUnits === 0n) return "no_reported_difference";
  return "change_exceeds_precision";
}

export function exactDecimalIsPositive(value: string): boolean | null {
  const parts = decimalParts(value);
  return parts === null ? null : parts.units > 0n;
}
