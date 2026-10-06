export function resetResearchScrollForSelection(
  region: Pick<HTMLElement, "scrollTop"> | null,
  previousCompanyId: string | null,
  selectedCompanyId: string | null,
  enteringDesk = false,
): boolean {
  if (!region || (previousCompanyId === selectedCompanyId && !enteringDesk)) return false;
  region.scrollTop = 0;
  return true;
}
