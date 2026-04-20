import type { PaperClaimEvidenceType, PaperClaimPolarity } from "@/generated/prisma/client";
import { listProjectedTargetPaperIds } from "@/lib/assertions/relation-reader";
import { generateStructuredObject } from "@/lib/llm/provider";
import { SYSTEM_PROMPTS } from "@/lib/llm/prompts";
import {
  PAPER_ANALYSIS_LLM_OPERATIONS,
  withPaperLlmContext,
} from "@/lib/llm/paper-llm-context";
import {
  buildTimelineRuntimeOutputSchema,
  compareMethodologiesRuntimeOutputSchema,
  detectContradictionsRuntimeOutputSchema,
  findGapsRuntimeOutputSchema,
  type BuildTimelineRuntimeOutput,
  type CompareMethodologiesRuntimeOutput,
  type DetectContradictionsRuntimeOutput,
  type FindGapsRuntimeOutput,
} from "@/lib/llm/runtime-output-schemas";
import type { LLMProvider } from "@/lib/llm/models";
import type { ProxyConfig } from "@/lib/llm/proxy-settings";
import { prisma } from "@/lib/prisma";
import type { ZodTypeAny } from "zod";

import {
  getLatestCompletedPaperClaimRun,
  type PaperClaimView,
} from "./store";
import { runPaperAnalysisCapability } from "./capability";
import { evaluationContextsAlign, normalizeEvaluationContext } from "./normalization/evaluation-context";
import { stancesAlign, stancesContradict } from "./normalization/stance";

export type CrossPaperAnalysisCapability =
  | "contradictions"
  | "gaps"
  | "timeline"
  | "compare_methodologies";

interface AnalysisPaperContext {
  id: string;
  title: string;
  year: number | null;
  abstract: string | null;
  summary: string | null;
  keyFindings: string | null;
  fullText: string | null;
  claims: PaperClaimView[];
}

export interface ContradictionCandidate {
  newPaperClaim: string;
  conflictingPaperId: string;
  conflictingPaperClaim: string;
  severity: "direct" | "methodological" | "tension";
  explanation: string;
  alignment: {
    task: string;
    dataset: string;
    metric: string;
    reason: "polarity_flip" | "predicate_opposition";
  };
}

type CrossPaperOutputMap = {
  contradictions: DetectContradictionsRuntimeOutput;
  gaps: FindGapsRuntimeOutput;
  timeline: BuildTimelineRuntimeOutput;
  compare_methodologies: CompareMethodologiesRuntimeOutput;
};

export interface RunCrossPaperAnalysisParams {
  capability: CrossPaperAnalysisCapability;
  paperId: string;
  provider: LLMProvider;
  modelId: string;
  proxyConfig?: ProxyConfig | null;
  userId?: string;
  relatedPaperIds?: string[];
}

const PAPER_CONTEXT_SELECT = {
  id: true,
  title: true,
  year: true,
  abstract: true,
  summary: true,
  keyFindings: true,
  fullText: true,
} as const;

const NON_ASSERTIVE_EVIDENCE_TYPES = new Set<PaperClaimEvidenceType>(["CITING"]);

function topClaimsForPaper(
  paper: AnalysisPaperContext,
  options?: {
    roles?: string[];
    facets?: string[];
    limit?: number;
  },
): PaperClaimView[] {
  const roles = options?.roles ? new Set(options.roles) : null;
  const facets = options?.facets ? new Set(options.facets) : null;
  return paper.claims
    .filter((claim) => {
      if (roles && !roles.has(claim.rhetoricalRole)) return false;
      if (facets && !facets.has(claim.facet)) return false;
      return true;
    })
    .slice(0, options?.limit ?? 8);
}

async function ensureClaimsForPaper(
  paper: Omit<AnalysisPaperContext, "claims">,
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

async function loadCrossPaperContext(
  params: RunCrossPaperAnalysisParams,
): Promise<{
  seedPaper: AnalysisPaperContext;
  relatedPapers: AnalysisPaperContext[];
}> {
  const seedPaper = await prisma.paper.findUnique({
    where: { id: params.paperId },
    select: PAPER_CONTEXT_SELECT,
  });
  if (!seedPaper) {
    throw new Error("Paper not found");
  }

  const relatedPaperIds =
    params.relatedPaperIds && params.relatedPaperIds.length > 0
      ? params.relatedPaperIds.filter((paperId) => paperId !== params.paperId)
      : await listProjectedTargetPaperIds(params.paperId, {
          excludeRelationTypes: ["cites"],
          limit: 10,
        });

  const relatedPapers = await prisma.paper.findMany({
    where: { id: { in: relatedPaperIds } },
    select: PAPER_CONTEXT_SELECT,
  });

  const allPapers = [seedPaper, ...relatedPapers];
  const claimsByPaperId = new Map<string, PaperClaimView[]>();

  for (const paper of allPapers) {
    claimsByPaperId.set(
      paper.id,
      await ensureClaimsForPaper(paper, {
        provider: params.provider,
        modelId: params.modelId,
        proxyConfig: params.proxyConfig,
        userId: params.userId,
      }),
    );
  }

  return {
    seedPaper: {
      ...seedPaper,
      claims: claimsByPaperId.get(seedPaper.id) ?? [],
    },
    relatedPapers: relatedPapers.map((paper) => ({
      ...paper,
      claims: claimsByPaperId.get(paper.id) ?? [],
    })),
  };
}

function formatPaperHeader(paper: AnalysisPaperContext): string {
  const parts = [`id: ${paper.id}`, `title: ${paper.title}`];
  if (paper.year) parts.push(`year: ${paper.year}`);
  if (paper.abstract) parts.push(`abstract: ${paper.abstract.slice(0, 500)}`);
  if (paper.summary) parts.push(`summary: ${paper.summary.slice(0, 700)}`);
  return parts.join(" | ");
}

function formatClaimLine(claim: PaperClaimView): string {
  const parts = [
    `role=${claim.rhetoricalRole.toLowerCase()}`,
    `facet=${claim.facet.toLowerCase()}`,
    `polarity=${claim.polarity.toLowerCase()}`,
    `evidence=${claim.evidenceType.toLowerCase()}`,
    `text=${claim.text}`,
  ];
  const evaluationContext = normalizeEvaluationContext(claim.evaluationContext);
  if (evaluationContext) {
    parts.push(
      `eval={task:${evaluationContext.task}; dataset:${evaluationContext.dataset}; metric:${evaluationContext.metric}}`,
    );
  }
  if (claim.citationAnchors.length > 0) {
    parts.push(
      `anchors=${claim.citationAnchors.map((anchor) => anchor.rawMarker).join(",")}`,
    );
  }
  return `- ${parts.join(" | ")}`;
}

function buildGapPrompt(
  seedPaper: AnalysisPaperContext,
  relatedPapers: AnalysisPaperContext[],
): string {
  const paperBlocks = [seedPaper, ...relatedPapers].map((paper) => {
    const focusClaims = topClaimsForPaper(paper, {
      roles: ["LIMITATION", "FUTURE_WORK", "METHOD", "RESULT"],
      facets: ["LIMITATION", "APPROACH", "RESULT", "RESOURCE"],
      limit: 8,
    });
    return [formatPaperHeader(paper), ...focusClaims.map(formatClaimLine)].join("\n");
  });
  return `PAPER CLUSTER:\n\n${paperBlocks.join("\n\n---\n\n")}`;
}

function buildTimelinePrompt(
  seedPaper: AnalysisPaperContext,
  relatedPapers: AnalysisPaperContext[],
): string {
  const papers = [seedPaper, ...relatedPapers].sort(
    (left, right) => (left.year ?? 9999) - (right.year ?? 9999),
  );
  const paperBlocks = papers.map((paper) => {
    const focusClaims = topClaimsForPaper(paper, {
      roles: ["CONTRIBUTION", "RESULT", "EVALUATION", "FUTURE_WORK"],
      limit: 8,
    });
    return [formatPaperHeader(paper), ...focusClaims.map(formatClaimLine)].join("\n");
  });
  return `PAPERS IN CHRONOLOGICAL ORDER:\n\n${paperBlocks.join("\n\n---\n\n")}`;
}

function buildMethodologyPrompt(
  seedPaper: AnalysisPaperContext,
  relatedPapers: AnalysisPaperContext[],
): string {
  const paperBlocks = [seedPaper, ...relatedPapers].map((paper) => {
    const focusClaims = topClaimsForPaper(paper, {
      roles: ["METHOD", "DATASET", "EVALUATION", "RESULT"],
      facets: ["APPROACH", "RESOURCE", "RESULT", "COMPARISON"],
      limit: 10,
    });
    return [formatPaperHeader(paper), ...focusClaims.map(formatClaimLine)].join("\n");
  });
  return `PAPERS TO COMPARE:\n\n${paperBlocks.join("\n\n---\n\n")}`;
}

export function buildContradictionCandidates(params: {
  seedPaper: AnalysisPaperContext;
  relatedPapers: AnalysisPaperContext[];
}): ContradictionCandidate[] {
  const candidates: ContradictionCandidate[] = [];

  for (const seedClaim of params.seedPaper.claims) {
    if (NON_ASSERTIVE_EVIDENCE_TYPES.has(seedClaim.evidenceType)) continue;
    if (!seedClaim.stance || !seedClaim.evaluationContext) continue;

    for (const relatedPaper of params.relatedPapers) {
      for (const relatedClaim of relatedPaper.claims) {
        if (NON_ASSERTIVE_EVIDENCE_TYPES.has(relatedClaim.evidenceType)) continue;
        if (!relatedClaim.stance || !relatedClaim.evaluationContext) continue;
        if (!stancesAlign(seedClaim.stance, relatedClaim.stance)) continue;
        if (!evaluationContextsAlign(seedClaim.evaluationContext, relatedClaim.evaluationContext)) {
          continue;
        }

        const contradiction = stancesContradict(
          {
            stance: seedClaim.stance,
            polarity: seedClaim.polarity as PaperClaimPolarity,
          },
          {
            stance: relatedClaim.stance,
            polarity: relatedClaim.polarity as PaperClaimPolarity,
          },
        );
        if (!contradiction.opposed || !contradiction.reason) continue;

        const context = normalizeEvaluationContext(seedClaim.evaluationContext);
        if (!context) continue;

        candidates.push({
          newPaperClaim: seedClaim.text,
          conflictingPaperId: relatedPaper.id,
          conflictingPaperClaim: relatedClaim.text,
          severity:
            contradiction.reason === "polarity_flip" ? "direct" : "tension",
          explanation:
            contradiction.reason === "polarity_flip"
              ? `Both claims target ${context.task} on ${context.dataset} using ${context.metric}, but they assert opposite outcomes.`
              : `Both claims address ${context.task} on ${context.dataset} with ${context.metric}, but their predicate direction conflicts.`,
          alignment: {
            task: context.task,
            dataset: context.dataset,
            metric: context.metric,
            reason: contradiction.reason,
          },
        });
      }
    }
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = [
      candidate.newPaperClaim,
      candidate.conflictingPaperId,
      candidate.conflictingPaperClaim,
      candidate.alignment.task,
      candidate.alignment.dataset,
      candidate.alignment.metric,
    ].join("::");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildContradictionResult(
  seedPaper: AnalysisPaperContext,
  relatedPapers: AnalysisPaperContext[],
): DetectContradictionsRuntimeOutput {
  const contradictions = buildContradictionCandidates({ seedPaper, relatedPapers });
  if (contradictions.length === 0) {
    return detectContradictionsRuntimeOutputSchema.parse({
      contradictions: [],
      summary:
        "No contradiction candidates met the alignment gate for stance, polarity, and evaluation context.",
    });
  }

  const relatedPaperCount = new Set(
    contradictions.map((candidate) => candidate.conflictingPaperId),
  ).size;
  return detectContradictionsRuntimeOutputSchema.parse({
    contradictions,
    summary: `Found ${contradictions.length} contradiction candidate(s) across ${relatedPaperCount} related paper(s) after filtering to aligned stance triples and matching task/dataset/metric contexts.`,
  });
}

async function runStructuredCapability<TSchema extends ZodTypeAny>(params: {
  operation:
    | typeof PAPER_ANALYSIS_LLM_OPERATIONS.FIND_GAPS
    | typeof PAPER_ANALYSIS_LLM_OPERATIONS.BUILD_TIMELINE
    | typeof PAPER_ANALYSIS_LLM_OPERATIONS.COMPARE_METHODOLOGIES;
  paperId: string;
  userId?: string;
  source: string;
  provider: LLMProvider;
  modelId: string;
  proxyConfig?: ProxyConfig | null;
  system: string;
  prompt: string;
  schemaName: "findGaps" | "buildTimeline" | "compareMethodologies";
  schema: TSchema;
}): Promise<TSchema["_output"]> {
  return withPaperLlmContext(
    {
      operation: params.operation,
      paperId: params.paperId,
      userId: params.userId,
      runtime: "interactive",
      source: params.source,
    },
    async () => {
      const { object } = await generateStructuredObject({
        provider: params.provider,
        modelId: params.modelId,
        proxyConfig: params.proxyConfig ?? undefined,
        system: params.system,
        prompt: params.prompt,
        schemaName: params.schemaName,
        schema: params.schema,
        maxTokens: 4_000,
      });
      return object;
    },
  );
}

export async function runCrossPaperAnalysisCapability(
  params: RunCrossPaperAnalysisParams & {
    capability: "contradictions";
  },
): Promise<DetectContradictionsRuntimeOutput>;
export async function runCrossPaperAnalysisCapability(
  params: RunCrossPaperAnalysisParams & {
    capability: "gaps";
  },
): Promise<FindGapsRuntimeOutput>;
export async function runCrossPaperAnalysisCapability(
  params: RunCrossPaperAnalysisParams & {
    capability: "timeline";
  },
): Promise<BuildTimelineRuntimeOutput>;
export async function runCrossPaperAnalysisCapability(
  params: RunCrossPaperAnalysisParams & {
    capability: "compare_methodologies";
  },
): Promise<CompareMethodologiesRuntimeOutput>;
export async function runCrossPaperAnalysisCapability(
  params: RunCrossPaperAnalysisParams,
): Promise<CrossPaperOutputMap[CrossPaperAnalysisCapability]> {
  const { seedPaper, relatedPapers } = await loadCrossPaperContext(params);

  if (relatedPapers.length === 0) {
    throw new Error("No related papers found. Run analysis first to link papers.");
  }

  if (params.capability === "contradictions") {
    return buildContradictionResult(seedPaper, relatedPapers);
  }

  if (params.capability === "gaps") {
    const totalClaims =
      seedPaper.claims.length +
      relatedPapers.reduce((sum, paper) => sum + paper.claims.length, 0);
    if (totalClaims < 2) {
      return {
        gaps: [],
        overallAssessment:
          "Claims are too sparse across this cluster to synthesize credible research gaps yet.",
      };
    }

    return runStructuredCapability({
      operation: PAPER_ANALYSIS_LLM_OPERATIONS.FIND_GAPS,
      paperId: params.paperId,
      userId: params.userId,
      source: "papers.analysis.gaps",
      provider: params.provider,
      modelId: params.modelId,
      proxyConfig: params.proxyConfig,
      system: SYSTEM_PROMPTS.findGaps,
      prompt: buildGapPrompt(seedPaper, relatedPapers),
      schemaName: "findGaps",
      schema: findGapsRuntimeOutputSchema,
    });
  }

  if (params.capability === "timeline") {
    const totalAnchoredClaims = [seedPaper, ...relatedPapers].reduce(
      (sum, paper) =>
        sum +
        paper.claims.filter((claim) => claim.citationAnchors.length > 0).length,
      0,
    );
    if (totalAnchoredClaims < 2) {
      return {
        timeline: [],
        narrative:
          "There are not enough citation-anchored claims across the cluster to build an honest timeline yet.",
        openQuestions: [],
      };
    }

    return runStructuredCapability({
      operation: PAPER_ANALYSIS_LLM_OPERATIONS.BUILD_TIMELINE,
      paperId: params.paperId,
      userId: params.userId,
      source: "papers.analysis.timeline",
      provider: params.provider,
      modelId: params.modelId,
      proxyConfig: params.proxyConfig,
      system: SYSTEM_PROMPTS.buildTimeline,
      prompt: buildTimelinePrompt(seedPaper, relatedPapers),
      schemaName: "buildTimeline",
      schema: buildTimelineRuntimeOutputSchema,
    });
  }

  return runStructuredCapability({
    operation: PAPER_ANALYSIS_LLM_OPERATIONS.COMPARE_METHODOLOGIES,
    paperId: params.paperId,
    userId: params.userId,
    source: "papers.analysis.compare_methodologies",
    provider: params.provider,
    modelId: params.modelId,
    proxyConfig: params.proxyConfig,
    system: SYSTEM_PROMPTS.compareMethodologies,
    prompt: buildMethodologyPrompt(seedPaper, relatedPapers),
    schemaName: "compareMethodologies",
    schema: compareMethodologiesRuntimeOutputSchema,
  });
}
