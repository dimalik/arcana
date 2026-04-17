import type { LLMProvider } from "../../llm/models";
import type { ProxyConfig } from "../../llm/proxy-settings";
import { buildPrompt, cleanJsonResponse } from "../../llm/prompts";
import { generateLLMResponse } from "../../llm/provider";
import { getTextForReferenceExtraction } from "../extract-section";
import type { ReferenceExtractionCandidate } from "../types";

interface RawLlmReference {
  index?: number;
  title?: string | null;
  authors?: string[] | null;
  year?: number | null;
  venue?: string | null;
  doi?: string | null;
  rawCitation?: string | null;
}

export interface LlmReferenceExtractionResult {
  candidates: ReferenceExtractionCandidate[];
  rawResponse: string;
}

export function mapLlmReferencesToCandidates(
  refs: RawLlmReference[],
): ReferenceExtractionCandidate[] {
  return refs.map((ref) => ({
    referenceIndex: ref.index ?? null,
    rawCitation: ref.rawCitation?.trim() || ref.title?.trim() || "Unknown reference",
    title: ref.title?.trim() || ref.rawCitation?.trim() || null,
    authors: ref.authors ?? null,
    year: ref.year ?? null,
    venue: ref.venue ?? null,
    doi: ref.doi ?? null,
    arxivId: null,
    extractionMethod: "llm_repair",
    extractionConfidence: ref.title ? 0.55 : 0.35,
  }));
}

export async function extractReferencesWithLlm(params: {
  fullText: string;
  provider: LLMProvider;
  modelId: string;
  proxyConfig?: ProxyConfig;
}): Promise<LlmReferenceExtractionResult> {
  const refText = getTextForReferenceExtraction(params.fullText);
  const { system } = buildPrompt("extractReferences", "");
  const prompt = `Here is the reference/bibliography section of the paper:\n\n${refText}`;
  const rawResponse = await generateLLMResponse({
    provider: params.provider,
    modelId: params.modelId,
    system,
    prompt,
    maxTokens: 8000,
    proxyConfig: params.proxyConfig,
  });

  const cleaned = cleanJsonResponse(rawResponse);
  const parsed = JSON.parse(cleaned) as RawLlmReference[] | { refs?: RawLlmReference[] };
  const refs = Array.isArray(parsed) ? parsed : parsed.refs ?? [];

  return {
    rawResponse,
    candidates: mapLlmReferencesToCandidates(refs),
  };
}
