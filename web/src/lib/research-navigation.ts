export type ResearchView = "desk" | "sources" | "filings" | "radar" | "queue";

export type ResearchNavigationState = {
  selectedCompanyId: string | null;
  view: ResearchView;
};

export type MentionDrawerReturnTarget = { view: "sources"; scrollTop: number; mentionId: string };

export function mentionDrawerReturnTarget(view: ResearchView, scrollTop: number, mentionId: string): MentionDrawerReturnTarget | null {
  return view === "sources" ? { view, scrollTop, mentionId } : null;
}

export function researchViewAfterMentionClose(currentView: ResearchView, returnTarget: MentionDrawerReturnTarget | null): ResearchView {
  return returnTarget?.view ?? currentView;
}

/** Choosing an issuer means opening that issuer's research, regardless of the current view. */
export function selectCompanyForResearch(
  current: ResearchNavigationState,
  companyId: string,
): ResearchNavigationState {
  return { ...current, selectedCompanyId: companyId, view: "desk" };
}

export function focusCompanyResearchBrief(companyId: string): boolean {
  if (typeof document === "undefined") return false;
  const section = document.getElementById(`company-research-brief-${companyId}`);
  const heading = section?.querySelector<HTMLElement>("h2");
  if (!section || !heading) return false;
  section.scrollIntoView({ block: "start" });
  heading.focus({ preventScroll: true });
  return true;
}

export function revealCompanyPrivateEvidence(companyId: string): boolean {
  if (typeof document === "undefined") return false;
  const section = document.getElementById(`private-evidence-${companyId}`);
  if (!(section instanceof HTMLDetailsElement)) return false;
  const summary = section.querySelector<HTMLElement>("summary");
  if (!summary) return false;
  section.open = true;
  section.scrollIntoView({ block: "start" });
  summary.focus({ preventScroll: true });
  return true;
}
