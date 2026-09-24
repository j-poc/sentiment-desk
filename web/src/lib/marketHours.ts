/**
 * US equity session logic, computed in America/New_York regardless of where
 * the desk is viewed from.
 */

export interface SessionInfo {
  state: "open" | "pre" | "post" | "closed";
  label: string;
  etClock: string;
}

const PARTS = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

export function sessionInfo(d = new Date()): SessionInfo {
  const parts = PARTS.formatToParts(d);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const weekday = get("weekday");
  const hour = Number(get("hour")) % 24;
  const minute = Number(get("minute"));
  const minutes = hour * 60 + minute;
  const etClock = `${String(hour).padStart(2, "0")}:${get("minute")}:${get("second")} ET`;
  const weekend = weekday === "Sat" || weekday === "Sun";

  if (!weekend && minutes >= 9 * 60 + 30 && minutes < 16 * 60) {
    return { state: "open", label: "MARKET OPEN", etClock };
  }
  if (!weekend && minutes >= 4 * 60 && minutes < 9 * 60 + 30) {
    return { state: "pre", label: "PRE-MARKET", etClock };
  }
  if (!weekend && minutes >= 16 * 60 && minutes < 20 * 60) {
    return { state: "post", label: "AFTER HOURS", etClock };
  }
  return { state: "closed", label: "MARKET CLOSED", etClock };
}
