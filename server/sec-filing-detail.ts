import { secFilingIdentity, type SecFilingDetail, type SecFilingInboxRow } from "../shared/sec-filings-inbox.js";
import { ExternalRequestPausedError } from "./external-request-gate.js";
import { ProviderRateLimitError } from "./provider-cooldown.js";
import { fetchFilingByAccession, fetchFilingEvidence, ITEM_LABELS, type SecFiling } from "./sources/sec.js";

type DetailDeps = {
  enabled: boolean;
  userAgent: string;
  fetchMetadata?: typeof fetchFilingByAccession;
  fetchEvidence?: typeof fetchFilingEvidence;
  now?: () => number;
};

function iso(value: number | null | undefined): string | null {
  return value == null || !Number.isSafeInteger(value) ? null : new Date(value).toISOString();
}

function paused(row: SecFilingInboxRow, message = "SEC document requests are paused by the current source permissions. The official filing page remains available."): SecFilingDetail {
  return {
    state: "paused", cik: row.cik, accession: row.accession, filingUrl: row.filingUrl,
    filingDate: row.filedOn, reportDate: null, acceptedAt: row.acceptedAt,
    metadataRetrievedAt: null, items: [], selectionReason: null, selectedRole: null, documents: [], message,
  };
}

/** Loads one explicitly selected inbox filing; it never persists text or dispatches a classifier. */
export class SecFilingDetailService {
  private readonly inFlight = new Map<string, Promise<SecFilingDetail>>();
  private readonly fetchMetadata: typeof fetchFilingByAccession;
  private readonly fetchEvidence: typeof fetchFilingEvidence;
  private readonly now: () => number;

  constructor(private readonly deps: DetailDeps) {
    this.fetchMetadata = deps.fetchMetadata ?? fetchFilingByAccession;
    this.fetchEvidence = deps.fetchEvidence ?? fetchFilingEvidence;
    this.now = deps.now ?? Date.now;
  }

  inspect(row: SecFilingInboxRow): Promise<SecFilingDetail> {
    const identity = secFilingIdentity(row);
    const existing = this.inFlight.get(identity);
    if (existing) return existing;
    const pending = this.load(row).finally(() => this.inFlight.delete(identity));
    this.inFlight.set(identity, pending);
    return pending;
  }

  private async load(row: SecFilingInboxRow): Promise<SecFilingDetail> {
    if (!this.deps.enabled || !this.deps.userAgent.trim()) return paused(row);
    let filing: SecFiling | null;
    try {
      filing = await this.fetchMetadata({ cik: row.cik, archiveCikPath: row.filingCikPath ?? row.cik,
        accessionNo: row.accession, userAgent: this.deps.userAgent });
    } catch (error) {
      if (error instanceof ProviderRateLimitError) return {
        ...paused(row, "The SEC rate-limited this request. Wait for its cooldown, then retry or open the official filing page."),
        state: "rate_limited",
      };
      if (error instanceof ExternalRequestPausedError) return paused(row);
      return { ...paused(row, "SEC filing metadata could not be loaded. Retry this filing or open it on the SEC site."), state: "failed" };
    }
    if (!filing) return {
      ...paused(row, "The exact filing was not found in the issuer's current SEC submissions record."), state: "not_found",
    };
    if (filing.cik !== row.cik || filing.accessionNo !== row.accession || filing.formType !== "8-K") {
      return { ...paused(row, "SEC metadata did not match this issuer and exact 8-K accession."), state: "failed" };
    }

    let evidence;
    try {
      evidence = await this.fetchEvidence(filing, this.deps.userAgent);
    } catch {
      return {
        ...paused(row, "SEC metadata matched, but the filing document could not be read. Retry or open the official filing page."),
        state: "partial", filingDate: iso(filing.filedAt)?.slice(0, 10) ?? null, reportDate: filing.reportDate ?? null,
        acceptedAt: iso(filing.acceptanceAt), metadataRetrievedAt: iso(filing.metadataRetrievedAt),
        items: filing.items.map((code) => ({ code, label: ITEM_LABELS[code] ?? null })),
      };
    }

    const documents = evidence.context.documents.map((document) => ({
      role: document.role,
      url: document.url,
      outcome: document.outcome,
      retrievedAt: iso(document.retrievedAt),
      bodySha256: document.bodySha256,
      excerpt: document.excerpt,
      errorCode: document.errorCode,
    }));
    const state = evidence.result === "success" ? "ready" : evidence.result === "rate_limited" ? "rate_limited" : "partial";
    const message = state === "ready" ? null
      : state === "rate_limited" ? "The SEC rate-limited a filing-document request. Wait for its cooldown, then retry."
        : "SEC metadata matched, but the filing text is incomplete or could not be verified. Use the source link or retry.";
    return {
      state,
      cik: row.cik,
      accession: row.accession,
      filingUrl: row.filingUrl,
      filingDate: iso(filing.filedAt)?.slice(0, 10) ?? null,
      reportDate: filing.reportDate ?? null,
      acceptedAt: iso(filing.acceptanceAt),
      metadataRetrievedAt: iso(filing.metadataRetrievedAt ?? this.now()),
      items: filing.items.map((code) => ({ code, label: ITEM_LABELS[code] ?? null })),
      selectionReason: evidence.context.selectionReason,
      selectedRole: evidence.context.selectedRole,
      documents,
      message,
    };
  }
}
