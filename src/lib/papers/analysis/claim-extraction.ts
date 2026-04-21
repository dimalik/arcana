import { createHash } from "node:crypto";

import type {
  PaperClaimEvidenceType,
  PaperClaimFacet,
  PaperClaimPolarity,
  PaperClaimRhetoricalRole,
  PaperClaimRun,
} from "../../../generated/prisma/client";
import { SYSTEM_PROMPTS } from "../../llm/prompts";
import { generateStructuredObject } from "../../llm/provider";
import type { LLMProvider } from "../../llm/models";
import { getBodyTextForContextExtraction } from "../../references/extract-section";

import type {
  PaperClaimCitationAnchor,
  PaperClaimEvaluationContext,
  PaperClaimSourceSpan,
  PaperClaimStance,
} from "./types";
import {
  extractClaimsRuntimeOutputSchema,
  type ExtractClaimsRuntimeOutput,
  type ExtractedPaperClaim,
} from "./extract-claims-schema";
import { classifyRhetoricalRole } from "./rhetorical-roles";
import { normalizeSectionLabel } from "./section-normalization";
import {
  type PaperAnalysisDb,
  completePaperClaimRun,
  getPaperClaimRunByFingerprint,
  getPaperClaimsForRun,
  hydratePaperClaim,
  replacePaperClaimsForRun,
  type StoredPaperClaimInput,
  upsertPaperClaimRun,
} from "./store";

export const PAPER_CLAIM_EXTRACTOR_VERSION = "paper-claims-v1";
const MAX_CLAIM_EXTRACTION_SOURCE_CHARS = 60_000;
const CLAIM_EXTRACTION_CHUNK_CHARS = 5_500;
const MAX_CLAIM_EXTRACTION_CHUNKS = 8;
type ClaimExtractionProxyConfig = Parameters<
  typeof generateStructuredObject
>[0]["proxyConfig"];

export interface ClaimExtractionChunk {
  text: string;
  sectionLabel: string | null;
}

export interface ExtractClaimsForPaperParams {
  db: PaperAnalysisDb;
  paperId: string;
  text: string;
  provider: LLMProvider;
  modelId: string;
  proxyConfig?: ClaimExtractionProxyConfig;
  force?: boolean;
  chunkLimit?: number;
  extractChunk?: (params: {
    chunk: ClaimExtractionChunk;
    chunkIndex: number;
    chunkCount: number;
    provider: LLMProvider;
    modelId: string;
    proxyConfig?: ClaimExtractionProxyConfig;
  }) => Promise<ExtractClaimsRuntimeOutput>;
}

export interface ExtractClaimsForPaperResult {
  cached: boolean;
  extractorVersion: string;
  sourceTextHash: string;
  chunkCount: number;
  run: PaperClaimRun;
  claims: ReturnType<typeof hydratePaperClaim>[];
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
}

function normalizeClaimText(value: string): string {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isHeadingParagraph(paragraph: string): boolean {
  const trimmed = paragraph.trim();
  if (!trimmed) return false;
  if (trimmed.length > 120) return false;
  if (/[.!?:]$/.test(trimmed)) return false;
  const wordCount = trimmed.split(/\s+/).length;
  return wordCount <= 12;
}

function splitIntoParagraphs(value: string): string[] {
  return value
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => normalizeWhitespace(paragraph))
    .filter(Boolean);
}

function sliceLongParagraph(
  paragraph: string,
  maxChars: number,
): string[] {
  if (paragraph.length <= maxChars) return [paragraph];
  const slices: string[] = [];
  let start = 0;
  while (start < paragraph.length) {
    const end = Math.min(start + maxChars, paragraph.length);
    slices.push(paragraph.slice(start, end).trim());
    start = end;
  }
  return slices.filter(Boolean);
}

export function buildClaimExtractionChunks(
  fullText: string,
  options?: {
    maxSourceChars?: number;
    chunkChars?: number;
    chunkLimit?: number;
  },
): ClaimExtractionChunk[] {
  const bodyText =
    getBodyTextForContextExtraction(
      fullText,
      options?.maxSourceChars ?? MAX_CLAIM_EXTRACTION_SOURCE_CHARS,
    ) ?? normalizeWhitespace(fullText);
  const paragraphs = splitIntoParagraphs(bodyText);
  const maxChunkChars = options?.chunkChars ?? CLAIM_EXTRACTION_CHUNK_CHARS;
  const chunkLimit = options?.chunkLimit ?? MAX_CLAIM_EXTRACTION_CHUNKS;

  if (paragraphs.length === 0) {
    return bodyText
      ? [
          {
            text: bodyText.slice(0, maxChunkChars),
            sectionLabel: null,
          },
        ]
      : [];
  }

  const chunks: ClaimExtractionChunk[] = [];
  let currentSectionLabel: string | null = null;
  let currentParagraphs: string[] = [];
  let currentLength = 0;

  const pushCurrentChunk = () => {
    if (currentParagraphs.length === 0) return;
    chunks.push({
      text: currentParagraphs.join("\n\n"),
      sectionLabel: currentSectionLabel,
    });
    currentParagraphs = [];
    currentLength = 0;
  };

  for (const paragraph of paragraphs) {
    if (chunks.length >= chunkLimit) break;

    if (isHeadingParagraph(paragraph)) {
      if (currentParagraphs.length > 0) {
        pushCurrentChunk();
        if (chunks.length >= chunkLimit) break;
      }
      currentSectionLabel = paragraph;
      continue;
    }

    for (const slice of sliceLongParagraph(paragraph, maxChunkChars)) {
      const nextLength = currentLength + slice.length + (currentParagraphs.length > 0 ? 2 : 0);
      if (nextLength > maxChunkChars && currentParagraphs.length > 0) {
        pushCurrentChunk();
        if (chunks.length >= chunkLimit) break;
      }
      currentParagraphs.push(slice);
      currentLength += slice.length + (currentParagraphs.length > 1 ? 2 : 0);
    }
  }

  if (chunks.length < chunkLimit && currentParagraphs.length > 0) {
    pushCurrentChunk();
  }

  return chunks.slice(0, chunkLimit);
}

function buildChunkPrompt(
  chunk: ClaimExtractionChunk,
  chunkIndex: number,
  chunkCount: number,
): string {
  const sectionSuffix = chunk.sectionLabel
    ? `Section heading: ${chunk.sectionLabel}\n\n`
    : "";
  return [
    `This is excerpt ${chunkIndex + 1} of ${chunkCount} from the paper body.`,
    sectionSuffix,
    "Extract only claims grounded in this excerpt.",
    "",
    chunk.text,
  ]
    .filter(Boolean)
    .join("\n");
}

function toPrismaRhetoricalRole(
  raw: ExtractedPaperClaim,
  sectionLabel: string | null,
): PaperClaimRhetoricalRole {
  const fallback = classifyRhetoricalRole({
    claimText: raw.text,
    sectionLabel,
    sectionPath: normalizeSectionLabel(sectionLabel),
  });

  const normalized = raw.rhetoricalRole ?? fallback;
  switch (normalized) {
    case "background":
      return "BACKGROUND";
    case "motivation":
      return "MOTIVATION";
    case "research_question":
      return "RESEARCH_QUESTION";
    case "hypothesis":
      return "HYPOTHESIS";
    case "definition":
      return "DEFINITION";
    case "assumption":
      return "ASSUMPTION";
    case "method":
      return "METHOD";
    case "dataset":
      return "DATASET";
    case "result":
      return "RESULT";
    case "evaluation":
      return "EVALUATION";
    case "limitation":
      return "LIMITATION";
    case "future_work":
      return "FUTURE_WORK";
    case "contribution":
      return "CONTRIBUTION";
  }
}

function toPrismaFacet(raw: ExtractedPaperClaim): PaperClaimFacet {
  switch (raw.facet ?? "result") {
    case "problem":
      return "PROBLEM";
    case "approach":
      return "APPROACH";
    case "result":
      return "RESULT";
    case "comparison":
      return "COMPARISON";
    case "limitation":
      return "LIMITATION";
    case "resource":
      return "RESOURCE";
  }
}

function toPrismaPolarity(raw: ExtractedPaperClaim): PaperClaimPolarity {
  switch (raw.polarity ?? "assertive") {
    case "assertive":
      return "ASSERTIVE";
    case "negated":
      return "NEGATED";
    case "conditional":
      return "CONDITIONAL";
    case "speculative":
      return "SPECULATIVE";
  }
}

function toPrismaEvidenceType(raw: ExtractedPaperClaim): PaperClaimEvidenceType {
  switch (raw.evidenceType ?? "primary") {
    case "primary":
      return "PRIMARY";
    case "secondary":
      return "SECONDARY";
    case "citing":
      return "CITING";
  }
}

function serializeStanceKey(value: PaperClaimStance | null | undefined): string {
  if (!value) return "";
  return [
    normalizeClaimText(value.subjectText),
    normalizeClaimText(value.predicateText),
    normalizeClaimText(value.objectText),
    normalizeClaimText(value.qualifierText ?? ""),
  ].join("|");
}

function serializeEvaluationContextKey(
  value: PaperClaimEvaluationContext | null | undefined,
): string {
  if (!value) return "";
  return [
    normalizeClaimText(value.task),
    normalizeClaimText(value.dataset),
    normalizeClaimText(value.metric),
    normalizeClaimText(value.comparator ?? ""),
    normalizeClaimText(value.setting ?? ""),
    normalizeClaimText(value.split ?? ""),
  ].join("|");
}

function normalizeConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0.7;
  }
  return Math.max(0, Math.min(value, 1));
}

function normalizeSourceSpan(
  value: unknown,
): PaperClaimSourceSpan | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as {
    charStart?: unknown;
    charEnd?: unknown;
    page?: unknown;
  };

  const charStart =
    typeof candidate.charStart === "number" &&
    Number.isFinite(candidate.charStart)
      ? Math.trunc(candidate.charStart)
      : null;
  const charEnd =
    typeof candidate.charEnd === "number" &&
    Number.isFinite(candidate.charEnd)
      ? Math.trunc(candidate.charEnd)
      : null;

  if (
    charStart == null ||
    charEnd == null ||
    charStart < 0 ||
    charEnd < 0 ||
    charEnd < charStart
  ) {
    return null;
  }

  const page =
    typeof candidate.page === "number" && Number.isFinite(candidate.page)
      ? Math.trunc(candidate.page)
      : undefined;

  return page == null || page <= 0
    ? { charStart, charEnd }
    : { charStart, charEnd, page };
}

export function materializeStoredClaim(
  raw: ExtractedPaperClaim,
  fallbackSectionLabel: string | null,
  orderIndex: number,
): StoredPaperClaimInput {
  const sectionLabel = raw.sectionLabel ?? fallbackSectionLabel ?? null;
  const normalizedText = normalizeClaimText(raw.text);
  const sourceExcerpt = normalizeWhitespace(raw.sourceExcerpt);
  const sectionPath = normalizeSectionLabel(sectionLabel);

  return {
    claimType: raw.claimType ?? raw.facet ?? null,
    rhetoricalRole: toPrismaRhetoricalRole(raw, sectionLabel),
    facet: toPrismaFacet(raw),
    polarity: toPrismaPolarity(raw),
    stance: raw.stance ?? null,
    evaluationContext: raw.evaluationContext ?? null,
    text: normalizeWhitespace(raw.text),
    normalizedText,
    confidence: normalizeConfidence(raw.confidence),
    sectionLabel,
    sectionPath,
    sourceExcerpt,
    excerptHash: sha256(normalizeClaimText(sourceExcerpt)),
    sourceSpan: normalizeSourceSpan(raw.sourceSpan),
    citationAnchors:
      (raw.citationAnchors as PaperClaimCitationAnchor[] | null | undefined) ??
      null,
    evidenceType: toPrismaEvidenceType(raw),
    orderIndex,
  };
}

export function dedupeStoredClaims(
  claims: StoredPaperClaimInput[],
): StoredPaperClaimInput[] {
  const seen = new Set<string>();
  const deduped: StoredPaperClaimInput[] = [];

  for (const claim of claims) {
    const key = [
      claim.normalizedText,
      claim.rhetoricalRole,
      claim.facet,
      claim.polarity,
      serializeStanceKey(claim.stance),
      serializeEvaluationContextKey(claim.evaluationContext),
      claim.evidenceType,
    ].join("::");

    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({
      ...claim,
      orderIndex: deduped.length,
    });
  }

  return deduped;
}

async function extractClaimsForChunk(params: {
  provider: LLMProvider;
  modelId: string;
  proxyConfig?: ClaimExtractionProxyConfig;
  chunk: ClaimExtractionChunk;
  chunkIndex: number;
  chunkCount: number;
}): Promise<ExtractClaimsRuntimeOutput> {
  const { object } = await generateStructuredObject({
    provider: params.provider,
    modelId: params.modelId,
    proxyConfig: params.proxyConfig ?? undefined,
    system: SYSTEM_PROMPTS.extractClaims,
    prompt: buildChunkPrompt(params.chunk, params.chunkIndex, params.chunkCount),
    schema: extractClaimsRuntimeOutputSchema,
    schemaName: "extractClaims",
    maxTokens: 3_500,
  });
  return object;
}

export async function extractClaimsForPaper(
  params: ExtractClaimsForPaperParams,
): Promise<ExtractClaimsForPaperResult> {
  const sourceText =
    getBodyTextForContextExtraction(
      params.text,
      MAX_CLAIM_EXTRACTION_SOURCE_CHARS,
    ) ?? normalizeWhitespace(params.text);
  if (!sourceText) {
    throw new Error("No text available for claim extraction");
  }

  const sourceTextHash = sha256(sourceText);
  const existingRun = await getPaperClaimRunByFingerprint(
    params.db,
    params.paperId,
    PAPER_CLAIM_EXTRACTOR_VERSION,
    sourceTextHash,
  );

  if (existingRun?.status === "COMPLETED" && !params.force) {
    return {
      cached: true,
      extractorVersion: PAPER_CLAIM_EXTRACTOR_VERSION,
      sourceTextHash,
      chunkCount: 0,
      run: existingRun,
      claims: existingRun.claims.map(hydratePaperClaim),
    };
  }

  const run = await upsertPaperClaimRun(params.db, {
    paperId: params.paperId,
    extractorVersion: PAPER_CLAIM_EXTRACTOR_VERSION,
    sourceTextHash,
    status: "RUNNING",
    completedAt: null,
  });

  try {
    const chunks = buildClaimExtractionChunks(sourceText, {
      chunkLimit: params.chunkLimit ?? MAX_CLAIM_EXTRACTION_CHUNKS,
    });
    const materializedClaims: StoredPaperClaimInput[] = [];

    for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
      const chunk = chunks[chunkIndex];
      if (!chunk) continue;
      const extracted = await (params.extractChunk ?? extractClaimsForChunk)({
        provider: params.provider,
        modelId: params.modelId,
        proxyConfig: params.proxyConfig,
        chunk,
        chunkIndex,
        chunkCount: chunks.length,
      });

      for (const claim of extracted.claims) {
        materializedClaims.push(
          materializeStoredClaim(
            claim,
            chunk.sectionLabel,
            materializedClaims.length,
          ),
        );
      }
    }

    const dedupedClaims = dedupeStoredClaims(materializedClaims);
    await replacePaperClaimsForRun(params.db, {
      paperId: params.paperId,
      runId: run.id,
      claims: dedupedClaims,
    });
    const completedRun = await completePaperClaimRun(params.db, {
      runId: run.id,
      status: "COMPLETED",
    });
    const storedClaims = await getPaperClaimsForRun(params.db, completedRun.id);

    return {
      cached: false,
      extractorVersion: PAPER_CLAIM_EXTRACTOR_VERSION,
      sourceTextHash,
      chunkCount: chunks.length,
      run: completedRun,
      claims: storedClaims.map(hydratePaperClaim),
    };
  } catch (error) {
    await completePaperClaimRun(params.db, {
      runId: run.id,
      status: "FAILED",
    }).catch(() => {
      // Preserve the original extraction error.
    });
    throw error;
  }
}
