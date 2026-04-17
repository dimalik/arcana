import type { LLMProvider } from "../llm/models";
import { GrobidReferenceExtractor } from "./extractors/grobid";
import type { PreflightOutput } from "./pdf-preflight";
import type {
  ExtractionMethod,
  ExtractionStatus,
  PreflightResult,
  ReferenceExtractionCandidate,
} from "./types";

export interface ReferenceExtractionAttempt {
  method: ExtractionMethod;
  status: ExtractionStatus;
  candidateCount: number;
  errorSummary?: string;
  preflightResult?: PreflightResult;
  preflightReason?: string;
  pageCount?: number;
}

export interface ReferenceExtractionPipelineResult {
  candidates: ReferenceExtractionCandidate[];
  method: ExtractionMethod;
  status: ExtractionStatus;
  extractorVersion: string;
  fallbackReason?: string;
  llmRawResponse?: string;
  attempts: ReferenceExtractionAttempt[];
}

export interface ReferenceExtractionPipelineDeps {
  grobidExtract?: (
    paperId: string,
    pdfPath: string,
  ) => Promise<{
    candidates: ReferenceExtractionCandidate[];
    status: ExtractionStatus;
    errorSummary?: string;
    preflight?: PreflightOutput;
  }>;
  llmExtract?: (params: {
    fullText: string;
    provider: LLMProvider;
    modelId: string;
    proxyConfig?: unknown;
  }) => Promise<{
    candidates: ReferenceExtractionCandidate[];
    rawResponse: string;
  }>;
}

export async function extractReferenceCandidates(params: {
  paperId: string;
  filePath?: string | null;
  fullText: string;
  provider: LLMProvider;
  modelId: string;
  proxyConfig?: unknown;
  deps?: ReferenceExtractionPipelineDeps;
}): Promise<ReferenceExtractionPipelineResult> {
  const fallbackReasons: string[] = [];
  const attempts: ReferenceExtractionAttempt[] = [];
  const grobidExtract =
    params.deps?.grobidExtract ??
    ((paperId: string, pdfPath: string) =>
      new GrobidReferenceExtractor().extract(paperId, pdfPath));
  const llmExtract = params.deps?.llmExtract ?? defaultLlmExtract;

  if (params.filePath) {
    const grobidResult = await grobidExtract(params.paperId, params.filePath);
    attempts.push({
      method: "grobid_tei",
      status: grobidResult.status,
      candidateCount: grobidResult.candidates.length,
      errorSummary: grobidResult.errorSummary,
      preflightResult: grobidResult.preflight?.result,
      preflightReason: grobidResult.preflight?.reason,
      pageCount: grobidResult.preflight?.pageCount ?? undefined,
    });
    if (grobidResult.candidates.length > 0 && grobidResult.status !== "failed") {
      return {
        candidates: grobidResult.candidates,
        method: "grobid_tei",
        status: grobidResult.status,
        extractorVersion: "grobid_v1",
        attempts,
      };
    }

    fallbackReasons.push(grobidResult.errorSummary ?? "GROBID returned no candidates");
  } else {
    fallbackReasons.push("paper has no PDF file path");
    attempts.push({
      method: "grobid_tei",
      status: "failed",
      candidateCount: 0,
      errorSummary: "paper has no PDF file path",
    });
  }

  const llmResult = await llmExtract({
    fullText: params.fullText,
    provider: params.provider,
    modelId: params.modelId,
    proxyConfig: params.proxyConfig,
  });
  attempts.push({
    method: "llm_repair",
    status: llmResult.candidates.length > 0 ? "succeeded" : "failed",
    candidateCount: llmResult.candidates.length,
  });

  return {
    candidates: llmResult.candidates,
    method: "llm_repair",
    status: llmResult.candidates.length > 0 ? "succeeded" : "failed",
    extractorVersion: "llm_v1",
    fallbackReason: fallbackReasons.length > 0 ? fallbackReasons.join("; ") : undefined,
    llmRawResponse: llmResult.rawResponse,
    attempts,
  };
}

async function defaultLlmExtract(params: {
  fullText: string;
  provider: LLMProvider;
  modelId: string;
  proxyConfig?: unknown;
}) {
  const { extractReferencesWithLlm } = await import("./extractors/llm");
  return extractReferencesWithLlm({
    ...params,
    proxyConfig: params.proxyConfig as Parameters<
      typeof extractReferencesWithLlm
    >[0]["proxyConfig"],
  });
}
