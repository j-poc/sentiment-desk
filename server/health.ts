/**
 * In-memory health counters for sources and the Jev engine. Counters reset on
 * restart; the durable record lives in the events table. The dashboard treats
 * health as first-class UI: a quiet failure must be visible, not silent.
 */

export interface SourceCounters {
  enabled: boolean;
  ok: number;
  fail: number;
  lastOkAt: number | null;
  lastErrorAt: number | null;
  lastError: string | null;
}

export interface HealthSnapshot {
  rss: SourceCounters;
  x: SourceCounters;
  jev: SourceCounters & { model: string };
}

export class HealthTracker {
  private readonly rss: SourceCounters;
  private readonly x: SourceCounters;
  private readonly jev: SourceCounters & { model: string };

  constructor(xEnabled: boolean, jevEnabled: boolean, jevModel: string) {
    this.rss = fresh(true);
    this.x = fresh(xEnabled);
    this.jev = { ...fresh(jevEnabled), model: jevModel };
  }

  recordRss(ok: boolean, error?: string): void {
    this.record(this.rss, ok, error);
  }

  recordX(ok: boolean, error?: string): void {
    this.record(this.x, ok, error);
  }

  recordJev(ok: boolean, error?: string): void {
    this.record(this.jev, ok, error);
  }

  snapshot(): HealthSnapshot {
    return { rss: { ...this.rss }, x: { ...this.x }, jev: { ...this.jev } };
  }

  private record(s: SourceCounters, ok: boolean, error?: string): void {
    if (ok) {
      s.ok += 1;
      s.lastOkAt = Date.now();
    } else {
      s.fail += 1;
      s.lastErrorAt = Date.now();
      s.lastError = error ?? "unknown error";
    }
  }
}

function fresh(enabled: boolean): SourceCounters {
  return { enabled, ok: 0, fail: 0, lastOkAt: null, lastErrorAt: null, lastError: null };
}
