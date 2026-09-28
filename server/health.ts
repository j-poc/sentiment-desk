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
  externalRequestsEnabled: boolean;
  rss: SourceCounters;
  x: SourceCounters;
  quotes: SourceCounters;
  sec: SourceCounters;
  finnhub: SourceCounters;
  reddit: SourceCounters;
  jev: SourceCounters & { model: string };
}

export class HealthTracker {
  private readonly rss: SourceCounters;
  private readonly x: SourceCounters;
  private readonly jev: SourceCounters & { model: string };

  private readonly quotes: SourceCounters;
  private readonly sec: SourceCounters;
  private readonly finnhub: SourceCounters;
  private readonly reddit: SourceCounters;
  private readonly externalRequestsEnabled: boolean;

  constructor(
    xEnabled: boolean,
    jevEnabled: boolean,
    jevModel: string,
    secEnabled = false,
    finnhubEnabled = false,
    redditEnabled = false,
    externalRequestsEnabled = true,
  ) {
    this.externalRequestsEnabled = externalRequestsEnabled;
    this.rss = fresh(externalRequestsEnabled);
    this.x = fresh(externalRequestsEnabled && xEnabled);
    this.quotes = fresh(externalRequestsEnabled);
    this.sec = fresh(externalRequestsEnabled && secEnabled);
    this.finnhub = fresh(externalRequestsEnabled && finnhubEnabled);
    this.reddit = fresh(externalRequestsEnabled && redditEnabled);
    this.jev = { ...fresh(externalRequestsEnabled && jevEnabled), model: jevModel };
  }

  recordQuotes(ok: boolean, error?: string): void {
    this.record(this.quotes, ok, error);
  }

  recordRss(ok: boolean, error?: string): void {
    this.record(this.rss, ok, error);
  }

  recordX(ok: boolean, error?: string): void {
    this.record(this.x, ok, error);
  }

  recordSec(ok: boolean, error?: string): void {
    this.record(this.sec, ok, error);
  }

  recordFinnhub(ok: boolean, error?: string): void {
    this.record(this.finnhub, ok, error);
  }

  recordReddit(ok: boolean, error?: string): void {
    this.record(this.reddit, ok, error);
  }

  recordJev(ok: boolean, error?: string): void {
    this.record(this.jev, ok, error);
  }

  snapshot(): HealthSnapshot {
    return {
      externalRequestsEnabled: this.externalRequestsEnabled,
      rss: { ...this.rss },
      x: { ...this.x },
      quotes: { ...this.quotes },
      sec: { ...this.sec },
      finnhub: { ...this.finnhub },
      reddit: { ...this.reddit },
      jev: { ...this.jev },
    };
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
