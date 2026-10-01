export function shouldRefreshDeskOnFirstEvidence(
  previousEligibleCount: number | null,
  currentEligibleCount: number,
  companyHistoryVisible: boolean,
): boolean {
  if (currentEligibleCount <= 0) return false;
  if (previousEligibleCount === 0) return true;
  return previousEligibleCount == null && !companyHistoryVisible;
}

export class FirstEvidenceRecovery {
  private previousEligibleCount: number | null = null;
  private pendingSnapshot = false;
  private snapshotInFlight = false;

  observe(currentEligibleCount: number, companyHistoryVisible: boolean): {
    refreshFeeds: boolean;
    refreshSnapshot: boolean;
  } {
    const refreshFeeds = shouldRefreshDeskOnFirstEvidence(
      this.previousEligibleCount, currentEligibleCount, companyHistoryVisible,
    );
    this.previousEligibleCount = currentEligibleCount;
    if (currentEligibleCount <= 0) this.pendingSnapshot = false;
    else if (refreshFeeds) this.pendingSnapshot = true;
    const refreshSnapshot = this.pendingSnapshot && !this.snapshotInFlight;
    if (refreshSnapshot) this.snapshotInFlight = true;
    return { refreshFeeds, refreshSnapshot };
  }

  snapshotApplied(): void {
    this.pendingSnapshot = false;
  }

  snapshotFailed(): void {
    if ((this.previousEligibleCount ?? 0) > 0) this.pendingSnapshot = true;
  }

  snapshotSettled(): void {
    this.snapshotInFlight = false;
  }
}
