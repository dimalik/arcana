export interface RecommendedPaper {
  title: string;
  abstract: string | null;
  authors: string[];
  year: number | null;
  doi: string | null;
  arxivId: string | null;
  externalUrl: string;
  citationCount: number | null;
  openAccessPdfUrl: string | null;
  source: string;
  matchReason?: string;
}

export interface RecommendationsCache {
  latest: RecommendedPaper[];
  recommended: RecommendedPaper[];
  fetchedAt: string;
}

export interface RecommendationBuildOptions {
  includeExternalSources?: boolean;
  allowLibraryCandidates?: boolean;
}
