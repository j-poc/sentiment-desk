export function shouldRefreshDeskOnFirstEvidence(
  previousEligibleCount: number | null,
  currentEligibleCount: number,
  companyHistoryVisible: boolean,
): boolean {
  if (currentEligibleCount <= 0) return false;
  if (previousEligibleCount === 0) return true;
  return previousEligibleCount == null && !companyHistoryVisible;
}
