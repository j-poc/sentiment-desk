/** Read-only snapshot of retained source records grouped by their Desk company assignment. */
export interface SavedSourceCoverageCompany<TMention> {
  companyId: string;
  name: string;
  ticker: string;
  identityGatePassCount: number;
  identityReviewCount: number;
  latestRetrievedAt: number | null;
  latestPublisherAt: number | null;
  latestProviderObservedAt: number | null;
  items: TMention[];
}

export interface SavedSourceCoverageSnapshot<TMention> {
  asOfMs: number;
  trackedCompanyCount: number;
  companiesWithIdentityGatePasses: number;
  identityGatePassCount: number;
  identityReviewCount: number;
  itemsPerCompany: number;
  companies: SavedSourceCoverageCompany<TMention>[];
}
