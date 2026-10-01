/**
 * In-memory health counters for sources and the Jev engine. Counters reset on
 * restart; the durable record lives in the events table. The dashboard treats
 * health as first-class UI: a quiet failure must be visible, not silent.
 */
import type { CollectorId } from "./types.js";

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
  sourceApproval: {
    requestedCollectors: CollectorId[];
    approvedCollectors: CollectorId[];
    blockedRequestedCollectors: CollectorId[];
    typesafeAccountUseApproved: boolean;
    jevAllowedCollectors: CollectorId[];
    openaiAccountUseApproved?: boolean;
    openaiAllowedCollectors?: CollectorId[];
    openaiBlockedCollectors?: CollectorId[];
  };
  rss: SourceCounters;
  gdelt: SourceCounters;
  x: SourceCounters;
  quotes: SourceCounters;
  sec: SourceCounters;
  finnhub: SourceCounters;
  reddit: SourceCounters;
  jev: SourceCounters & { model: string };
  classifier: SourceCounters & { provider: "openai_luna" | "typesafe"; model: string; configured: boolean; blockedReason: string | null };
}

export interface ClassifierHealthConfig {
  provider: "openai_luna" | "typesafe";
  model: string;
  configured: boolean;
  enabled: boolean;
  blockedReason: string | null;
}

export class HealthTracker {
  private readonly rss: SourceCounters;
  private readonly gdelt: SourceCounters;
  private readonly x: SourceCounters;
  private readonly jev: SourceCounters & { model: string };
  private readonly classifier: SourceCounters & ClassifierHealthConfig;

  private readonly quotes: SourceCounters;
  private readonly sec: SourceCounters;
  private readonly finnhub: SourceCounters;
  private readonly reddit: SourceCounters;
  private readonly externalRequestsEnabled: boolean;
  private readonly sourceApproval: HealthSnapshot["sourceApproval"];

  constructor(
    xEnabled: boolean,
    jevEnabled: boolean,
    jevModel: string,
    secEnabled = false,
    finnhubEnabled = false,
    redditEnabled = false,
    externalRequestsEnabled = true,
    externalCollectors?: ReadonlySet<CollectorId>,
    sourceApproval: HealthSnapshot["sourceApproval"] = {
      requestedCollectors: [],
      approvedCollectors: [],
      blockedRequestedCollectors: [],
      typesafeAccountUseApproved: false,
      jevAllowedCollectors: [],
    },
    classifierConfig: ClassifierHealthConfig = { provider: "typesafe", model: jevModel, configured: jevEnabled, enabled: jevEnabled, blockedReason: jevEnabled ? null : "provider is disabled" },
  ) {
    const collectorEnabled = (collector: CollectorId) =>
      externalRequestsEnabled && (externalCollectors == null || externalCollectors.has(collector));
    this.externalRequestsEnabled = externalRequestsEnabled;
    this.sourceApproval = {
      requestedCollectors: [...sourceApproval.requestedCollectors],
      approvedCollectors: [...sourceApproval.approvedCollectors],
      blockedRequestedCollectors: [...sourceApproval.blockedRequestedCollectors],
      typesafeAccountUseApproved: sourceApproval.typesafeAccountUseApproved,
      jevAllowedCollectors: [...sourceApproval.jevAllowedCollectors],
      openaiAccountUseApproved: sourceApproval.openaiAccountUseApproved ?? false,
      openaiAllowedCollectors: [...(sourceApproval.openaiAllowedCollectors ?? [])],
      openaiBlockedCollectors: [...(sourceApproval.openaiBlockedCollectors ?? [])],
    };
    this.rss = fresh(collectorEnabled("google_news_rss") || collectorEnabled("yahoo_finance_rss"));
    this.gdelt = fresh(collectorEnabled("gdelt_doc_api"));
    this.x = fresh(collectorEnabled("x") && xEnabled);
    this.quotes = fresh(collectorEnabled("yahoo_quote"));
    this.sec = fresh(collectorEnabled("sec_edgar") && secEnabled);
    this.finnhub = fresh(collectorEnabled("finnhub") && finnhubEnabled);
    this.reddit = fresh(collectorEnabled("reddit") && redditEnabled);
    this.jev = { ...fresh(externalRequestsEnabled && jevEnabled), model: jevModel };
    this.classifier = { ...fresh(externalRequestsEnabled && classifierConfig.enabled), ...classifierConfig };
  }

  recordQuotes(ok: boolean, error?: string): void {
    this.record(this.quotes, ok, error);
  }

  recordRss(ok: boolean, error?: string): void {
    this.record(this.rss, ok, error);
  }

  recordGdelt(ok: boolean, error?: string): void {
    this.record(this.gdelt, ok, error);
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

  recordClassifier(ok: boolean, error?: string): void { this.record(this.classifier, ok, error); }

  snapshot(): HealthSnapshot {
    return {
      externalRequestsEnabled: this.externalRequestsEnabled,
      sourceApproval: {
        requestedCollectors: [...this.sourceApproval.requestedCollectors],
        approvedCollectors: [...this.sourceApproval.approvedCollectors],
        blockedRequestedCollectors: [...this.sourceApproval.blockedRequestedCollectors],
        typesafeAccountUseApproved: this.sourceApproval.typesafeAccountUseApproved,
        jevAllowedCollectors: [...this.sourceApproval.jevAllowedCollectors],
        openaiAccountUseApproved: this.sourceApproval.openaiAccountUseApproved ?? false,
        openaiAllowedCollectors: [...(this.sourceApproval.openaiAllowedCollectors ?? [])],
        openaiBlockedCollectors: [...(this.sourceApproval.openaiBlockedCollectors ?? [])],
      },
      rss: { ...this.rss },
      gdelt: { ...this.gdelt },
      x: { ...this.x },
      quotes: { ...this.quotes },
      sec: { ...this.sec },
      finnhub: { ...this.finnhub },
      reddit: { ...this.reddit },
      jev: { ...this.jev },
      classifier: { ...this.classifier },
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
