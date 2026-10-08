import type { SecFilingResearchTask } from "../../../shared/sec-filings-inbox.js";

export type SecFilingResumeTarget = {
  requestId: number;
  cik: string;
  accession: string;
  issuer: string;
  filingUrl: string;
  nextQuestion: string;
  feedReceiptId: string;
  feedUpdatedAt: string | null;
  retrievedAt: string | null;
};

export type SecFilingResumeResolvedState = "open" | "rolled_out" | "stale" | "unavailable";

export function secFilingResumeActionId(target: Pick<SecFilingResumeTarget, "cik" | "accession">, state: SecFilingResumeResolvedState): string {
  const prefix = state === "open" ? "sec-filing-resume-inspect" : "saved-sec-resume-inspect";
  return `${prefix}-${target.cik}-${target.accession}`;
}

export function secFilingResumeTargetFromTask(task: SecFilingResearchTask, requestId: number): SecFilingResumeTarget {
  return {
    requestId,
    cik: task.cik,
    accession: task.triggeringAccession,
    issuer: task.issuer,
    filingUrl: task.filingUrl,
    nextQuestion: task.nextQuestion,
    feedReceiptId: task.feedReceiptId,
    feedUpdatedAt: task.feedUpdatedAt,
    retrievedAt: task.retrievedAt,
  };
}
