export type CategoricalDisposition = "classified" | "excluded" | "review_required";

export interface CategoricalDispositionEvidence {
  sentiment: string | null;
  eventType: string | null;
  takeaway: string | null;
  about: boolean | null;
  material: boolean | null;
  investorRelevant: boolean | null;
  evidenceSufficient: boolean;
}

function explicitlyOutOfScope(evidence: CategoricalDispositionEvidence): boolean {
  return evidence.about === false || evidence.investorRelevant === false;
}

function completeEvidence(evidence: CategoricalDispositionEvidence): boolean {
  return evidence.evidenceSufficient && evidence.sentiment !== null && evidence.eventType !== null &&
    evidence.takeaway !== null && evidence.about !== null && evidence.material !== null &&
    evidence.investorRelevant !== null;
}

/** The class-vs-review decision needs strong identity when all evidence is present. */
export function categoricalDispositionDependsOnIdentity(evidence: CategoricalDispositionEvidence): boolean {
  return !explicitlyOutOfScope(evidence) && completeEvidence(evidence);
}

export function deriveCategoricalDisposition(
  evidence: CategoricalDispositionEvidence,
  strongIdentity: boolean,
): CategoricalDisposition {
  if (explicitlyOutOfScope(evidence)) return "excluded";
  return strongIdentity && completeEvidence(evidence) ? "classified" : "review_required";
}

/**
 * Check whether a saved disposition is compatible with the evidence available
 * to the caller. A null identity means the evaluation packet cannot distinguish
 * a valid review_required result from a valid classified result when fields are
 * complete, so it accepts either while still rejecting contradictions.
 */
export function isCategoricalDispositionAllowed(
  evidence: CategoricalDispositionEvidence,
  disposition: CategoricalDisposition,
  strongIdentity: boolean | null,
): boolean {
  if (explicitlyOutOfScope(evidence)) return disposition === "excluded";
  if (disposition === "excluded") return false;
  const complete = completeEvidence(evidence);
  if (disposition === "classified") return complete && strongIdentity !== false;
  return strongIdentity !== true || !complete;
}
