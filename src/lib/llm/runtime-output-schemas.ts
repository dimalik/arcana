import { z } from "zod";
import { extractClaimsRuntimeOutputSchema } from "@/lib/papers/analysis/extract-claims-schema";
import {
  rerankRelatedPapersRuntimeOutputSchema,
  scoreRelatedPapersPointwiseRuntimeOutputSchema,
} from "@/lib/papers/retrieval/related-rerank-schema";

const nullableString = z.string().nullable().optional();
const optionalStringArray = z.array(z.string()).optional();
const optionalNullableStringArray = z.array(z.string()).nullable().optional();

export const extractRuntimeOutputSchema = z
  .object({
    title: nullableString,
    authors: optionalNullableStringArray,
    year: z.coerce.number().int().nullable().optional(),
    venue: nullableString,
    doi: nullableString,
    arxivId: nullableString,
    abstract: nullableString,
    keyFindings: optionalStringArray,
    methodology: nullableString,
    contributions: optionalStringArray,
    limitations: optionalStringArray,
  })
  .passthrough();

export const categorizeRuntimeOutputSchema = z
  .object({
    tags: z.array(z.string()),
  })
  .passthrough();

export const extractReferencesRuntimeOutputSchema = z.array(
  z
    .object({
      index: z.coerce.number().int().optional(),
      title: z.string(),
      authors: z.array(z.string()).nullable().optional(),
      year: z.coerce.number().int().nullable().optional(),
      venue: z.string().nullable().optional(),
      doi: z.string().nullable().optional(),
      rawCitation: z.string(),
    })
    .passthrough(),
);

export const detectContradictionsRuntimeOutputSchema = z
  .object({
    contradictions: z.array(
      z
        .object({
          newPaperClaim: z.string(),
          conflictingPaperId: z.string(),
          conflictingPaperClaim: z.string(),
          severity: z.enum(["direct", "methodological", "tension"]),
          explanation: z.string(),
        })
        .passthrough(),
    ),
    summary: z.string(),
  })
  .passthrough();

export const findGapsRuntimeOutputSchema = z
  .object({
    gaps: z.array(
      z
        .object({
          title: z.string(),
          description: z.string(),
          relevantPaperIds: z.array(z.string()),
          type: z.enum([
            "methodological",
            "empirical",
            "theoretical",
            "application",
            "scale",
          ]),
          confidence: z.number(),
        })
        .passthrough(),
    ),
    overallAssessment: z.string(),
  })
  .passthrough();

export const buildTimelineRuntimeOutputSchema = z
  .object({
    timeline: z.array(
      z
        .object({
          paperId: z.string(),
          year: z.coerce.number().int(),
          role: z.string(),
          contribution: z.string(),
          buildsOn: z.array(z.string()),
          keyAdvance: z.string(),
        })
        .passthrough(),
    ),
    narrative: z.string(),
    openQuestions: z.array(z.string()),
  })
  .passthrough();

export const compareMethodologiesRuntimeOutputSchema = z
  .object({
    comparison: z
      .object({
        papers: z.array(
          z
            .object({
              paperId: z.string(),
              title: z.string(),
              approach: z.string(),
              datasets: z.array(z.string()),
              metrics: z.array(z.string()),
              baselines: z.array(z.string()),
              keyResults: z.string(),
            })
            .passthrough(),
        ),
        commonDatasets: z.array(z.string()),
        commonMetrics: z.array(z.string()),
        headToHead: z.array(
          z
            .object({
              dataset: z.string(),
              metric: z.string(),
              results: z.array(
                z
                  .object({
                    paperId: z.string(),
                    value: z.string(),
                    notes: z.string(),
                  })
                  .passthrough(),
              ),
            })
            .passthrough(),
        ),
      })
      .passthrough(),
    methodologicalDifferences: z.array(
      z
        .object({
          aspect: z.string(),
          description: z.string(),
          implication: z.string(),
        })
        .passthrough(),
    ),
    verdict: z.string(),
  })
  .passthrough();

export const extractCitationContextsRuntimeOutputSchema = z.array(
  z
    .object({
      citation: z.string(),
      context: z.string(),
    })
    .passthrough(),
);

export const distillRuntimeOutputSchema = z
  .object({
    insights: z.array(
      z
        .object({
          learning: z.string(),
          significance: z.string(),
          applications: z.string().optional().nullable(),
          roomSuggestion: z.string().optional().nullable(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export const paperAnswerAgentActionRuntimeOutputSchema = z.discriminatedUnion(
  "type",
  [
    z.object({
      type: z.literal("read_section"),
      section: z.enum(["overview", "methodology", "results"]),
    }),
    z.object({
      type: z.literal("search_claims"),
      query: z.string().min(1).max(160),
      limit: z.coerce.number().int().min(1).max(6).default(4),
    }),
    z.object({
      type: z.literal("list_figures"),
      kind: z.enum(["figure", "table", "any"]).default("any"),
      query: z.string().max(120).optional(),
      limit: z.coerce.number().int().min(1).max(8).default(5),
    }),
    z.object({
      type: z.literal("open_figure"),
      target: z.string().min(1).max(120),
    }),
    z.object({
      type: z.literal("finish"),
      answerPlan: z.string().min(1).max(240),
    }),
  ],
);

export const paperAnswerCodeArtifactRuntimeOutputSchema = z
  .object({
    summary: z.string(),
    filename: z.string(),
    language: z.string(),
    code: z.string(),
    assumptions: z.array(z.string()).default([]),
  })
  .passthrough();

export const PROCESSING_RUNTIME_OUTPUT_SCHEMAS = {
  extract: extractRuntimeOutputSchema,
  extractClaims: extractClaimsRuntimeOutputSchema,
  categorize: categorizeRuntimeOutputSchema,
  extractReferences: extractReferencesRuntimeOutputSchema,
  detectContradictions: detectContradictionsRuntimeOutputSchema,
  findGaps: findGapsRuntimeOutputSchema,
  buildTimeline: buildTimelineRuntimeOutputSchema,
  compareMethodologies: compareMethodologiesRuntimeOutputSchema,
  extractCitationContexts: extractCitationContextsRuntimeOutputSchema,
  distill: distillRuntimeOutputSchema,
  rerankRelatedPapers: rerankRelatedPapersRuntimeOutputSchema,
  scoreRelatedPapersPointwise: scoreRelatedPapersPointwiseRuntimeOutputSchema,
  paperAnswerAgentAction: paperAnswerAgentActionRuntimeOutputSchema,
  paperAnswerCodeArtifact: paperAnswerCodeArtifactRuntimeOutputSchema,
} as const;

export type ProcessingRuntimeStructuredPromptType =
  keyof typeof PROCESSING_RUNTIME_OUTPUT_SCHEMAS;

export type ExtractRuntimeOutput = z.infer<typeof extractRuntimeOutputSchema>;
export type CategorizeRuntimeOutput = z.infer<
  typeof categorizeRuntimeOutputSchema
>;
export type ExtractClaimsRuntimeOutput = z.infer<
  typeof extractClaimsRuntimeOutputSchema
>;
export type ExtractReferencesRuntimeOutput = z.infer<
  typeof extractReferencesRuntimeOutputSchema
>;
export type DetectContradictionsRuntimeOutput = z.infer<
  typeof detectContradictionsRuntimeOutputSchema
>;
export type FindGapsRuntimeOutput = z.infer<typeof findGapsRuntimeOutputSchema>;
export type BuildTimelineRuntimeOutput = z.infer<
  typeof buildTimelineRuntimeOutputSchema
>;
export type CompareMethodologiesRuntimeOutput = z.infer<
  typeof compareMethodologiesRuntimeOutputSchema
>;
export type ExtractCitationContextsRuntimeOutput = z.infer<
  typeof extractCitationContextsRuntimeOutputSchema
>;
export type DistillRuntimeOutput = z.infer<typeof distillRuntimeOutputSchema>;
export type PaperAnswerAgentActionRuntimeOutput = z.infer<
  typeof paperAnswerAgentActionRuntimeOutputSchema
>;
export type PaperAnswerCodeArtifactRuntimeOutput = z.infer<
  typeof paperAnswerCodeArtifactRuntimeOutputSchema
>;
export type RerankRelatedPapersRuntimeOutput = z.infer<
  typeof rerankRelatedPapersRuntimeOutputSchema
>;
export type ScoreRelatedPapersPointwiseRuntimeOutput = z.infer<
  typeof scoreRelatedPapersPointwiseRuntimeOutputSchema
>;

export class StructuredRuntimeOutputError extends Error {
  readonly promptType: ProcessingRuntimeStructuredPromptType;
  readonly code: "json_parse_failed" | "schema_validation_failed";
  readonly source: "provider" | "batch";

  constructor(options: {
    promptType: ProcessingRuntimeStructuredPromptType;
    code: "json_parse_failed" | "schema_validation_failed";
    source: "provider" | "batch";
    cause?: unknown;
  }) {
    const message =
      options.code === "json_parse_failed"
        ? `Structured ${options.source} output for ${options.promptType} was not valid JSON`
        : `Structured ${options.source} output for ${options.promptType} did not match the frozen schema`;
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = "StructuredRuntimeOutputError";
    this.promptType = options.promptType;
    this.code = options.code;
    this.source = options.source;
  }
}

type ProcessingRuntimeOutputMap = {
  [K in ProcessingRuntimeStructuredPromptType]: z.infer<
    (typeof PROCESSING_RUNTIME_OUTPUT_SCHEMAS)[K]
  >;
};

export function validateStructuredRuntimeOutput<
  TPromptType extends ProcessingRuntimeStructuredPromptType,
>(
  promptType: TPromptType,
  value: unknown,
  source: "provider" | "batch",
): ProcessingRuntimeOutputMap[TPromptType] {
  const parsed = PROCESSING_RUNTIME_OUTPUT_SCHEMAS[promptType].safeParse(value);
  if (!parsed.success) {
    throw new StructuredRuntimeOutputError({
      promptType,
      code: "schema_validation_failed",
      source,
      cause: parsed.error,
    });
  }
  return parsed.data as ProcessingRuntimeOutputMap[TPromptType];
}

export function parseStructuredRuntimeOutputText<
  TPromptType extends ProcessingRuntimeStructuredPromptType,
>(
  promptType: TPromptType,
  text: string,
  source: "provider" | "batch",
): ProcessingRuntimeOutputMap[TPromptType] {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new StructuredRuntimeOutputError({
      promptType,
      code: "json_parse_failed",
      source,
      cause: error,
    });
  }

  return validateStructuredRuntimeOutput(promptType, value, source);
}

export function serializeStructuredRuntimeOutput<
  TPromptType extends ProcessingRuntimeStructuredPromptType,
>(
  promptType: TPromptType,
  value: ProcessingRuntimeOutputMap[TPromptType],
): string {
  return JSON.stringify(
    validateStructuredRuntimeOutput(promptType, value, "provider"),
  );
}
