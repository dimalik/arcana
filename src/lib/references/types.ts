export const EXTRACTION_METHODS = [
  "source_native",
  "grobid_tei",
  "llm_repair",
] as const;

export type ExtractionMethod = (typeof EXTRACTION_METHODS)[number];

export function isExtractionMethod(value: unknown): value is ExtractionMethod {
  return (
    typeof value === "string" &&
    (EXTRACTION_METHODS as readonly string[]).includes(value)
  );
}

export const RESOLUTION_METHODS = [
  "doi_exact",
  "arxiv_exact",
  "identifier_exact",
  "crossref_candidate",
  "openalex_candidate",
  "semantic_scholar_candidate",
  "arxiv_candidate",
  "manual",
  "unresolved",
] as const;

export type ResolutionMethod = (typeof RESOLUTION_METHODS)[number];

export const PREFLIGHT_RESULTS = [
  "text_layer_ok",
  "text_layer_missing",
  "text_layer_garbled",
  "preflight_error",
  "not_applicable",
] as const;

export type PreflightResult = (typeof PREFLIGHT_RESULTS)[number];

export function isPreflightResult(value: unknown): value is PreflightResult {
  return (
    typeof value === "string" &&
    (PREFLIGHT_RESULTS as readonly string[]).includes(value)
  );
}

export const EXTRACTION_STATUSES = ["succeeded", "partial", "failed"] as const;

export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

export interface ReferenceExtractionCandidate {
  referenceIndex: number | null;
  rawCitation: string;
  title: string | null;
  authors: string[] | null;
  year: number | null;
  venue: string | null;
  doi: string | null;
  arxivId: string | null;
  externalIds?: Record<string, string>;
  extractionMethod: ExtractionMethod;
  extractionConfidence: number | null;
  sourceXmlFragment?: string;
  legacyReferenceId?: string;
}

export interface ReferenceResolutionResult {
  resolvedEntityId: string | null;
  resolutionMethod: ResolutionMethod;
  resolutionConfidence: number | null;
  matchedIdentifiers: Array<{ type: string; value: string }>;
  evidence: string[];
}

export interface ReferenceExtractor {
  readonly method: ExtractionMethod;
  extract(
    paperId: string,
    pdfPath: string,
  ): Promise<{
    candidates: ReferenceExtractionCandidate[];
    status: ExtractionStatus;
    errorSummary?: string;
  }>;
}
