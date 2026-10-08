export interface ListedSecurity {
  symbol: string;
  exchange: string;
  securityName: string;
  normalizedName: string;
}

export interface ListingDirectoryEvidence {
  source: string;
  createdAt: string;
  retrievedAt: string;
  bodyBytes: number;
  bodySha256: string;
}

export interface ListingSnapshot {
  securities: ListedSecurity[];
  createdAt: string;
  retrievedAt: string;
  directories: ListingDirectoryEvidence[];
}
