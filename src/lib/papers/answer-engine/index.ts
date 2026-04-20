import "server-only";

import type {
  ConversationArtifactKind,
  PaperClaimEvidenceType,
} from "@/generated/prisma/client";
import {
  buildTimelineRuntimeOutputSchema,
  compareMethodologiesRuntimeOutputSchema,
  detectContradictionsRuntimeOutputSchema,
  findGapsRuntimeOutputSchema,
} from "@/lib/llm/runtime-output-schemas";
import type { LLMProvider } from "@/lib/llm/models";
import type { ProxyConfig } from "@/lib/llm/proxy-settings";
import { SYSTEM_PROMPTS } from "@/lib/llm/prompts";
import { prisma } from "@/lib/prisma";

import { runPaperAnalysisCapability } from "../analysis/capability";
import { runCrossPaperAnalysisCapability } from "../analysis/cross-paper-engine";
import {
  getLatestCompletedPaperClaimRun,
  type PaperClaimView,
} from "../analysis/store";
import { normalizeAnalysisText } from "../analysis/normalization/text";

import {
  type AnswerCitation,
  type ChatMessageMetadata,
  type PaperAnswerIntent,
} from "./metadata";
import { classifyPaperAnswerIntent } from "./intent";

export { normalizeChatHistory } from "./chat-history";
export {
  parseChatMessageMetadata,
  serializeChatMessageMetadata,
  type AnswerCitation,
  type ChatMessageMetadata,
  type PaperAnswerIntent,
} from "./metadata";
export { classifyPaperAnswerIntent } from "./intent";
export { createConversationArtifact, type ConversationArtifactView } from "../analysis/store";

interface AnswerPaperContext {
  id: string;
  title: string;
  year: number | null;
  abstract: string | null;
  summary: string | null;
  keyFindings: string | null;
  fullText: string | null;
  claims: PaperClaimView[];
}

export interface ConversationArtifactDraft {
  kind: ConversationArtifactKind;
  title: string;
  payloadJson: string;
}

export interface PreparedPaperAnswer {
  intent: PaperAnswerIntent;
  systemPrompt: string;
  citations: AnswerCitation[];
  artifacts: ConversationArtifactDraft[];
}

interface PreparePaperAnswerParams {
  paperId: string;
  question: string;
  provider: LLMProvider;
  modelId: string;
  proxyConfig?: ProxyConfig | null;
  userId?: string;
  conversationId?: string;
}

const STOP_WORDS = new Set([
  "about",
  "after",
  "before",
  "does",
  "from",
  "have",
  "into",
  "just",
  "like",
  "more",
  "most",
  "paper",
  "papers",
  "that",
  "their",
  "them",
  "this",
  "what",
  "when",
  "where",
  "which",
  "with",
  "would",
]);

const NON_ASSERTIVE_EVIDENCE_TYPES = new Set<PaperClaimEvidenceType>(["CITING"]);

const PAPER_CONTEXT_SELECT = {
  id: true,
  title: true,
  year: true,
  abstract: true,
  summary: true,
  keyFindings: true,
  fullText: true,
} as const;

function tokenizeForRanking(value: string): string[] {
  return normalizeAnalysisText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

function uniqueCitations(citations: AnswerCitation[]): AnswerCitation[] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = [
      citation.paperId,
      citation.sourceKind,
      citation.sectionPath ?? "",
      citation.snippet,
    ].join("::");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatCitationForPrompt(citation: AnswerCitation, index: number): string {
  const section = citation.sectionPath ? ` / ${citation.sectionPath}` : "";
  return `[S${index + 1}] ${citation.paperTitle}${section}\n${citation.snippet}`;
}

function formatKeyFindings(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function buildPreferredClaimFilters(
  intent: PaperAnswerIntent,
  query: string,
): {
  roles?: string[];
  facets?: string[];
} {
  const normalizedQuery = normalizeAnalysisText(query);

  if (intent === "claims") {
    if (normalizedQuery.includes("limitation")) {
      return {
        roles: ["LIMITATION", "FUTURE_WORK"],
        facets: ["LIMITATION"],
      };
    }
    if (
      normalizedQuery.includes("method") ||
      normalizedQuery.includes("approach")
    ) {
      return {
        roles: ["METHOD", "CONTRIBUTION", "RESULT"],
        facets: ["APPROACH", "RESOURCE", "RESULT"],
      };
    }
    return {
      roles: ["CONTRIBUTION", "RESULT", "METHOD", "LIMITATION"],
      facets: ["RESULT", "APPROACH", "LIMITATION", "COMPARISON"],
    };
  }

  if (intent === "compare_methodologies") {
    return {
      roles: ["METHOD", "DATASET", "EVALUATION", "RESULT"],
      facets: ["APPROACH", "RESOURCE", "COMPARISON", "RESULT"],
    };
  }

  return {};
}

function rankClaimsForQuestion(
  claims: PaperClaimView[],
  question: string,
  options?: {
    roles?: string[];
    facets?: string[];
    limit?: number;
  },
): PaperClaimView[] {
  const queryTokens = new Set(tokenizeForRanking(question));
  const preferredRoles = options?.roles ? new Set(options.roles) : null;
  const preferredFacets = options?.facets ? new Set(options.facets) : null;

  const scored = claims
    .filter((claim) => !NON_ASSERTIVE_EVIDENCE_TYPES.has(claim.evidenceType))
    .map((claim) => {
      const textTokens = tokenizeForRanking(claim.normalizedText || claim.text);
      const excerptTokens = tokenizeForRanking(claim.sourceExcerpt);
      const sectionTokens = tokenizeForRanking(claim.sectionPath);
      let score = claim.confidence;

      for (const token of Array.from(queryTokens)) {
        if (textTokens.includes(token)) score += 3;
        if (excerptTokens.includes(token)) score += 2;
        if (sectionTokens.includes(token)) score += 1;
      }

      if (preferredRoles?.has(claim.rhetoricalRole)) score += 1.5;
      if (preferredFacets?.has(claim.facet)) score += 1.5;
      if (claim.evidenceType === "PRIMARY") score += 0.5;

      return { claim, score };
    })
    .sort((left, right) => right.score - left.score || left.claim.orderIndex - right.claim.orderIndex);

  const ranked = scored
    .filter((item, index) => item.score > 0 || index < (options?.limit ?? 6))
    .map((item) => item.claim);

  return ranked.slice(0, options?.limit ?? 6);
}

async function ensureClaimsForPaper(
  paper: Omit<AnswerPaperContext, "claims">,
  params: {
    provider: LLMProvider;
    modelId: string;
    proxyConfig?: ProxyConfig | null;
    userId?: string;
  },
): Promise<PaperClaimView[]> {
  const latestRun = await getLatestCompletedPaperClaimRun(prisma, paper.id);
  if (latestRun) {
    return latestRun.claims;
  }

  const text = paper.fullText || paper.abstract || "";
  if (!text) return [];

  const result = await runPaperAnalysisCapability({
    capability: "claims",
    paperId: paper.id,
    text,
    provider: params.provider,
    modelId: params.modelId,
    proxyConfig: params.proxyConfig ?? undefined,
    userId: params.userId,
  });
  return result.claims;
}

async function loadConversationContext(conversationId: string | undefined): Promise<{
  selectedText: string | null;
  additionalPapers: Array<Omit<AnswerPaperContext, "claims">>;
}> {
  if (!conversationId) {
    return { selectedText: null, additionalPapers: [] };
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      additionalPapers: {
        include: { paper: { select: PAPER_CONTEXT_SELECT } },
      },
    },
  });

  if (!conversation) {
    return { selectedText: null, additionalPapers: [] };
  }

  return {
    selectedText: conversation.selectedText,
    additionalPapers: conversation.additionalPapers.map(({ paper }) => paper),
  };
}

async function loadAnswerContext(params: PreparePaperAnswerParams): Promise<{
  seedPaper: AnswerPaperContext;
  selectedText: string | null;
  additionalPapers: AnswerPaperContext[];
}> {
  const seedPaperBase = await prisma.paper.findUnique({
    where: { id: params.paperId },
    select: PAPER_CONTEXT_SELECT,
  });
  if (!seedPaperBase) {
    throw new Error("Paper not found");
  }

  const conversationContext = await loadConversationContext(params.conversationId);
  const seedClaims = await ensureClaimsForPaper(seedPaperBase, params);

  const additionalPapers = await Promise.all(
    conversationContext.additionalPapers.map(async (paper) => ({
      ...paper,
      claims: await ensureClaimsForPaper(paper, params),
    })),
  );

  return {
    seedPaper: {
      ...seedPaperBase,
      claims: seedClaims,
    },
    selectedText: conversationContext.selectedText,
    additionalPapers,
  };
}

async function loadPaperContextMap(
  paperIds: string[],
  params: {
    provider: LLMProvider;
    modelId: string;
    proxyConfig?: ProxyConfig | null;
    userId?: string;
  },
): Promise<Map<string, AnswerPaperContext>> {
  if (paperIds.length === 0) return new Map();

  const papers = await prisma.paper.findMany({
    where: { id: { in: paperIds } },
    select: PAPER_CONTEXT_SELECT,
  });

  const hydrated = await Promise.all(
    papers.map(async (paper) => ({
      ...paper,
      claims: await ensureClaimsForPaper(paper, params),
    })),
  );

  return new Map(hydrated.map((paper) => [paper.id, paper]));
}

function buildClaimCitations(
  paper: AnswerPaperContext,
  claims: PaperClaimView[],
): AnswerCitation[] {
  return claims.map((claim) => ({
    paperId: paper.id,
    paperTitle: paper.title,
    snippet: claim.sourceExcerpt || claim.text,
    sectionPath: claim.sectionPath,
    sourceKind: "claim",
  }));
}

function buildSummaryCitation(
  paper: AnswerPaperContext,
): AnswerCitation | null {
  const findings = formatKeyFindings(paper.keyFindings);
  const summarySource =
    findings[0] || paper.summary || paper.abstract || null;
  if (!summarySource) return null;

  return {
    paperId: paper.id,
    paperTitle: paper.title,
    snippet: summarySource,
    sectionPath: null,
    sourceKind: "summary",
  };
}

function buildSelectedTextCitation(
  paper: AnswerPaperContext,
  selectedText: string | null,
): AnswerCitation | null {
  if (!selectedText) return null;
  return {
    paperId: paper.id,
    paperTitle: paper.title,
    snippet: selectedText,
    sectionPath: null,
    sourceKind: "selection",
  };
}

function buildPrompt(params: {
  paperTitle: string;
  question: string;
  intent: PaperAnswerIntent;
  selectedText: string | null;
  citations: AnswerCitation[];
  artifacts: ConversationArtifactDraft[];
}): string {
  const sourceBlock =
    params.citations.length > 0
      ? params.citations.map(formatCitationForPrompt).join("\n\n")
      : "No retrieved sources were available.";
  const artifactBlock =
    params.artifacts.length > 0
      ? params.artifacts
          .map(
            (artifact, index) =>
              `Artifact ${index + 1} (${artifact.kind}): ${artifact.title}\n${artifact.payloadJson}`,
          )
          .join("\n\n")
      : "No structured artifact is attached.";
  const selectedTextBlock = params.selectedText
    ? `Selected passage from the conversation:\n${params.selectedText}\n\n`
    : "";

  return `${SYSTEM_PROMPTS.chat}

You are answering a paper-focused question with a curated evidence packet, not the raw full text.

Rules:
- Use only the retrieved sources and attached structured artifacts below.
- If the evidence is insufficient, say so plainly.
- Cite supporting evidence inline with the source tags like [S1], [S2].
- If a structured artifact is attached, summarize it instead of reproducing raw JSON.
- Keep the answer grounded in the paper(s), then add explanation.

Primary paper: "${params.paperTitle}"
Intent: ${params.intent}

${selectedTextBlock}User question:
${params.question}

Retrieved sources:
${sourceBlock}

Structured artifacts:
${artifactBlock}`;
}

function parseArtifactPayloadJson<T>(value: T): string {
  return JSON.stringify(value, null, 2);
}

function buildClaimArtifact(
  paper: AnswerPaperContext,
  claims: PaperClaimView[],
): ConversationArtifactDraft | null {
  if (claims.length === 0) return null;
  return {
    kind: "CLAIM_LIST",
    title: "Relevant claims",
    payloadJson: parseArtifactPayloadJson({
      paperId: paper.id,
      paperTitle: paper.title,
      claims: claims.map((claim) => ({
        id: claim.id,
        text: claim.text,
        rhetoricalRole: claim.rhetoricalRole,
        facet: claim.facet,
        polarity: claim.polarity,
        sectionPath: claim.sectionPath,
        sourceExcerpt: claim.sourceExcerpt,
      })),
    }),
  };
}

function buildContradictionArtifacts(params: {
  seedPaper: AnswerPaperContext;
  relatedPapers: AnswerPaperContext[];
  payload: ReturnType<typeof detectContradictionsRuntimeOutputSchema.parse>;
}): {
  citations: AnswerCitation[];
  artifacts: ConversationArtifactDraft[];
} {
  const relatedPapersById = new Map(
    params.relatedPapers.map((paper) => [paper.id, paper]),
  );
  const citations: AnswerCitation[] = [];

  for (const contradiction of params.payload.contradictions.slice(0, 5)) {
    citations.push({
      paperId: params.seedPaper.id,
      paperTitle: params.seedPaper.title,
      snippet: contradiction.newPaperClaim,
      sectionPath: null,
      sourceKind: "artifact",
    });
    const relatedPaper = relatedPapersById.get(contradiction.conflictingPaperId);
    citations.push({
      paperId: contradiction.conflictingPaperId,
      paperTitle: relatedPaper?.title ?? contradiction.conflictingPaperId,
      snippet: contradiction.conflictingPaperClaim,
      sectionPath: null,
      sourceKind: "artifact",
    });
  }

  return {
    citations,
    artifacts: [
      {
        kind: "CONTRADICTION_TABLE",
        title: "Contradiction candidates",
        payloadJson: parseArtifactPayloadJson(params.payload),
      },
    ],
  };
}

function buildGapArtifacts(params: {
  papersById: Map<string, AnswerPaperContext>;
  payload: ReturnType<typeof findGapsRuntimeOutputSchema.parse>;
}): {
  citations: AnswerCitation[];
  artifacts: ConversationArtifactDraft[];
} {
  const citations: AnswerCitation[] = [];
  for (const gap of params.payload.gaps) {
    for (const paperId of gap.relevantPaperIds) {
      const paper = params.papersById.get(paperId);
      if (!paper) continue;
      const supportingClaim = rankClaimsForQuestion(paper.claims, gap.title, {
        roles: ["LIMITATION", "FUTURE_WORK", "RESULT", "METHOD"],
        limit: 1,
      })[0];
      citations.push(
        supportingClaim
          ? {
              paperId: paper.id,
              paperTitle: paper.title,
              snippet: supportingClaim.sourceExcerpt || supportingClaim.text,
              sectionPath: supportingClaim.sectionPath,
              sourceKind: "claim",
            }
          : {
              paperId: paper.id,
              paperTitle: paper.title,
              snippet: gap.description,
              sectionPath: null,
              sourceKind: "artifact",
            },
      );
    }
  }

  return {
    citations,
    artifacts: [
      {
        kind: "GAP_LIST",
        title: "Research gaps",
        payloadJson: parseArtifactPayloadJson(params.payload),
      },
    ],
  };
}

function buildTimelineArtifacts(params: {
  papersById: Map<string, AnswerPaperContext>;
  payload: ReturnType<typeof buildTimelineRuntimeOutputSchema.parse>;
}): {
  citations: AnswerCitation[];
  artifacts: ConversationArtifactDraft[];
} {
  const citations = params.payload.timeline.slice(0, 6).map((entry) => ({
    paperId: entry.paperId,
    paperTitle: params.papersById.get(entry.paperId)?.title ?? entry.paperId,
    snippet: entry.keyAdvance || entry.contribution,
    sectionPath: null,
    sourceKind: "artifact" as const,
  }));

  return {
    citations,
    artifacts: [
      {
        kind: "TIMELINE",
        title: "Idea timeline",
        payloadJson: parseArtifactPayloadJson(params.payload),
      },
    ],
  };
}

function buildMethodologyArtifacts(
  payload: ReturnType<typeof compareMethodologiesRuntimeOutputSchema.parse>,
): {
  citations: AnswerCitation[];
  artifacts: ConversationArtifactDraft[];
} {
  const citations = payload.comparison.papers.slice(0, 6).map((paper) => ({
    paperId: paper.paperId,
    paperTitle: paper.title,
    snippet: paper.keyResults || paper.approach,
    sectionPath: null,
    sourceKind: "artifact" as const,
  }));

  return {
    citations,
    artifacts: [
      {
        kind: "METHODOLOGY_COMPARE",
        title: "Methodology comparison",
        payloadJson: parseArtifactPayloadJson(payload),
      },
    ],
  };
}

export async function preparePaperAnswer(
  params: PreparePaperAnswerParams,
): Promise<PreparedPaperAnswer> {
  const { seedPaper, selectedText, additionalPapers } = await loadAnswerContext(params);
  const intent = classifyPaperAnswerIntent({
    question: params.question,
    additionalPaperCount: additionalPapers.length,
  });

  const citations: AnswerCitation[] = [];
  const artifacts: ConversationArtifactDraft[] = [];
  const selectedTextCitation = buildSelectedTextCitation(seedPaper, selectedText);
  if (selectedTextCitation) citations.push(selectedTextCitation);

  if (intent === "claims") {
    const filters = buildPreferredClaimFilters(intent, params.question);
    const relevantClaims = rankClaimsForQuestion(seedPaper.claims, params.question, {
      ...filters,
      limit: 6,
    });
    citations.push(...buildClaimCitations(seedPaper, relevantClaims));
    const artifact = buildClaimArtifact(seedPaper, relevantClaims);
    if (artifact) artifacts.push(artifact);
  } else if (intent === "contradictions") {
    const payload = detectContradictionsRuntimeOutputSchema.parse(
      await runCrossPaperAnalysisCapability({
        capability: "contradictions",
        paperId: params.paperId,
        relatedPaperIds: additionalPapers.map((paper) => paper.id),
        provider: params.provider,
        modelId: params.modelId,
        proxyConfig: params.proxyConfig,
        userId: params.userId,
      }),
    );
    const relatedPapersById = await loadPaperContextMap(
      Array.from(
        new Set(payload.contradictions.map((item) => item.conflictingPaperId)),
      ),
      params,
    );
    const contradictionArtifacts = buildContradictionArtifacts({
      seedPaper,
      relatedPapers: Array.from(relatedPapersById.values()),
      payload,
    });
    citations.push(...contradictionArtifacts.citations);
    artifacts.push(...contradictionArtifacts.artifacts);
  } else if (intent === "gaps") {
    const payload = findGapsRuntimeOutputSchema.parse(
      await runCrossPaperAnalysisCapability({
        capability: "gaps",
        paperId: params.paperId,
        relatedPaperIds: additionalPapers.map((paper) => paper.id),
        provider: params.provider,
        modelId: params.modelId,
        proxyConfig: params.proxyConfig,
        userId: params.userId,
      }),
    );
    const involvedPaperIds = Array.from(
      new Set(payload.gaps.flatMap((gap) => gap.relevantPaperIds)),
    );
    const supplementalPapers = await loadPaperContextMap(involvedPaperIds, params);
    const papersById = new Map<string, AnswerPaperContext>([
      [seedPaper.id, seedPaper],
      ...Array.from(supplementalPapers.entries()),
    ]);
    const gapArtifacts = buildGapArtifacts({ papersById, payload });
    citations.push(...gapArtifacts.citations);
    artifacts.push(...gapArtifacts.artifacts);
  } else if (intent === "timeline") {
    const payload = buildTimelineRuntimeOutputSchema.parse(
      await runCrossPaperAnalysisCapability({
        capability: "timeline",
        paperId: params.paperId,
        relatedPaperIds: additionalPapers.map((paper) => paper.id),
        provider: params.provider,
        modelId: params.modelId,
        proxyConfig: params.proxyConfig,
        userId: params.userId,
      }),
    );
    const supplementalPapers = await loadPaperContextMap(
      Array.from(new Set(payload.timeline.map((entry) => entry.paperId))),
      params,
    );
    const papersById = new Map<string, AnswerPaperContext>([
      [seedPaper.id, seedPaper],
      ...Array.from(supplementalPapers.entries()),
    ]);
    const timelineArtifacts = buildTimelineArtifacts({ papersById, payload });
    citations.push(...timelineArtifacts.citations);
    artifacts.push(...timelineArtifacts.artifacts);
  } else if (intent === "compare_methodologies") {
    const payload = compareMethodologiesRuntimeOutputSchema.parse(
      await runCrossPaperAnalysisCapability({
        capability: "compare_methodologies",
        paperId: params.paperId,
        relatedPaperIds: additionalPapers.map((paper) => paper.id),
        provider: params.provider,
        modelId: params.modelId,
        proxyConfig: params.proxyConfig,
        userId: params.userId,
      }),
    );
    const methodologyArtifacts = buildMethodologyArtifacts(payload);
    citations.push(...methodologyArtifacts.citations);
    artifacts.push(...methodologyArtifacts.artifacts);
  } else {
    const filters = buildPreferredClaimFilters(intent, params.question);
    const relevantClaims = rankClaimsForQuestion(seedPaper.claims, params.question, {
      ...filters,
      limit: 6,
    });
    if (relevantClaims.length > 0) {
      citations.push(...buildClaimCitations(seedPaper, relevantClaims));
    }
    const summaryCitation = buildSummaryCitation(seedPaper);
    if (summaryCitation) citations.push(summaryCitation);
  }

  const unique = uniqueCitations(citations).slice(0, 8);
  const fallbackSummaryCitation =
    unique.length === 0 ? buildSummaryCitation(seedPaper) : null;
  if (fallbackSummaryCitation) {
    unique.push(fallbackSummaryCitation);
  }

  return {
    intent,
    citations: unique,
    artifacts,
    systemPrompt: buildPrompt({
      paperTitle: seedPaper.title,
      question: params.question,
      intent,
      selectedText,
      citations: unique,
      artifacts,
    }),
  };
}

export function buildChatMessageMetadata(params: {
  intent: PaperAnswerIntent;
  citations: AnswerCitation[];
}): ChatMessageMetadata {
  return {
    intent: params.intent,
    citations: params.citations,
  };
}
