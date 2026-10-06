export interface SecFilingInboxRow {
  accession: string;
  cik: string;
  /** EDGAR login CIK encoded in the accession; it can differ from the issuer CIK. */
  accessionCik?: string;
  /** CIK component of the official SEC archive path; it can differ from both CIKs above. */
  filingCikPath?: string;
  issuer: string;
  form: "8-K" | "8-K/A";
  filedOn: string | null;
  acceptedAt: string | null;
  feedUpdatedAt: string | null;
  filingUrl: string;
}

export interface SecFilingsInboxView {
  state: "ready" | "stale" | "empty" | "pending" | "rate_limited" | "failed" | "not_configured" | "unsupported" | "unavailable";
  rows: SecFilingInboxRow[];
  receiptId: string | null;
  retrievedAt: string | null;
  feedUpdatedAt: string | null;
  jobStatus: string | null;
  canActivate: boolean;
  nextRefreshAt: string | null;
  message: string | null;
}
