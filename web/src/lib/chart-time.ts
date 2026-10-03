const MAX_DATE_UTC_MILLISECONDS = 8_640_000_000_000_000;

export function isValidUtcMilliseconds(timestamp: number): boolean {
  return Number.isSafeInteger(timestamp) && Math.abs(timestamp) <= MAX_DATE_UTC_MILLISECONDS;
}

export function formatChartTimestamp(timestamp: number): string {
  if (!isValidUtcMilliseconds(timestamp)) throw new RangeError("Chart timestamp must be valid UTC milliseconds.");
  return new Date(timestamp).toISOString().replace("T", " ").replace("Z", " UTC");
}
