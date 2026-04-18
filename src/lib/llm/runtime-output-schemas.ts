import { z } from "zod";

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

export const linkPapersRuntimeOutputSchema = z.array(
  z
    .object({
      targetPaperId: z.string(),
      relationType: z.string(),
      description: z.string().optional().nullable(),
      confidence: z.coerce.number(),
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

export const PROCESSING_RUNTIME_OUTPUT_SCHEMAS = {
  extract: extractRuntimeOutputSchema,
  categorize: categorizeRuntimeOutputSchema,
  linkPapers: linkPapersRuntimeOutputSchema,
  detectContradictions: detectContradictionsRuntimeOutputSchema,
  extractCitationContexts: extractCitationContextsRuntimeOutputSchema,
  distill: distillRuntimeOutputSchema,
} as const;

export type ProcessingRuntimeStructuredPromptType =
  keyof typeof PROCESSING_RUNTIME_OUTPUT_SCHEMAS;

export type ExtractRuntimeOutput = z.infer<typeof extractRuntimeOutputSchema>;
export type CategorizeRuntimeOutput = z.infer<
  typeof categorizeRuntimeOutputSchema
>;
export type LinkPapersRuntimeOutput = z.infer<
  typeof linkPapersRuntimeOutputSchema
>;
export type DetectContradictionsRuntimeOutput = z.infer<
  typeof detectContradictionsRuntimeOutputSchema
>;
export type ExtractCitationContextsRuntimeOutput = z.infer<
  typeof extractCitationContextsRuntimeOutputSchema
>;
export type DistillRuntimeOutput = z.infer<typeof distillRuntimeOutputSchema>;

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
