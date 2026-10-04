export type AnalystResearchDisposition = "investigate" | "dismissed";

export const MAX_ANALYST_RESEARCH_QUESTION_CHARS = 1_000;
export const MAX_ACTIVE_ANALYST_RESEARCH_ITEMS = 500;
export const MAX_STORED_ANALYST_RESEARCH_ITEMS = 10_000;

/** Local, user-authored work linked to one immutable source observation. */
export interface AnalystSourceReview {
  observationId: string;
  companyId: string;
  disposition: AnalystResearchDisposition;
  nextQuestion: string;
  createdAt: number;
  updatedAt: number;
}

/** Broadcast only the disposition metadata needed to keep connected source scans current. */
export interface AnalystResearchDispositionChange {
  observationId: string;
  companyId: string;
  disposition: AnalystResearchDisposition;
  updatedAt: number;
}
