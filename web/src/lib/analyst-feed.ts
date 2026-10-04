import type { AnalystResearchDisposition, AnalystResearchDispositionChange } from "../../../shared/analyst-research.js";

export type ResearchDispositionOverrides = ReadonlyMap<string, AnalystResearchDispositionChange>;

export type MentionFeedFilter = "all" | "bull" | "bear" | "material" | "offtarget" | "failed" | "history" | "identity_review";

export function includesWeakIssuerMatches(filter: MentionFeedFilter): boolean {
  return filter === "offtarget" || filter === "failed" || filter === "history" || filter === "identity_review";
}

export function researchDispositionFor(
  observation: { id: string; analystResearchDisposition?: AnalystResearchDisposition | null },
  overrides: ResearchDispositionOverrides,
): AnalystResearchDisposition | null {
  return overrides.get(observation.id)?.disposition ?? observation.analystResearchDisposition ?? null;
}

export function visibleInWorkingScan(
  observation: { id: string; analystResearchDisposition?: AnalystResearchDisposition | null; issuerIdentityStrong?: boolean },
  includeDismissed: boolean,
  overrides: ResearchDispositionOverrides,
  includeWeakIssuerMatches = false,
): boolean {
  return (includeDismissed || researchDispositionFor(observation, overrides) !== "dismissed")
    && (includeWeakIssuerMatches || observation.issuerIdentityStrong !== false);
}

export function applyDispositionChange(
  overrides: Map<string, AnalystResearchDispositionChange>,
  change: AnalystResearchDispositionChange,
): boolean {
  const previous = overrides.get(change.observationId);
  if (previous && previous.updatedAt >= change.updatedAt) return false;
  overrides.set(change.observationId, change);
  return true;
}
