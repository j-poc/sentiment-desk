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
