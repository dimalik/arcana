import { z } from "zod";

import {
  paperClaimCitationAnchorsSchema,
  paperClaimEvaluationContextSchema,
  paperClaimStanceSchema,
} from "./types";

export const PAPER_CLAIM_FACET_VALUES = [
  "problem",
  "approach",
  "result",
  "comparison",
  "limitation",
  "resource",
] as const;

export const PAPER_CLAIM_POLARITY_VALUES = [
  "assertive",
  "negated",
  "conditional",
  "speculative",
] as const;

export const PAPER_CLAIM_EVIDENCE_TYPE_VALUES = [
  "primary",
  "secondary",
  "citing",
] as const;

export const PAPER_CLAIM_RHETORICAL_ROLE_VALUES = [
  "background",
  "motivation",
  "research_question",
  "hypothesis",
  "definition",
  "assumption",
  "method",
  "dataset",
  "result",
  "evaluation",
  "limitation",
  "future_work",
  "contribution",
] as const;

// Anthropic's structured-output transport rejects integer/number minimum/maximum
// constraints, so the runtime extraction schema must avoid them.
const paperClaimSourceSpanRuntimeSchema = z
  .object({
    charStart: z.number(),
    charEnd: z.number(),
    page: z.number().optional(),
  })
  .passthrough();

export const extractedPaperClaimSchema = z
  .object({
    claimType: z.string().min(1).nullable().optional(),
    rhetoricalRole: z
      .enum(PAPER_CLAIM_RHETORICAL_ROLE_VALUES)
      .nullable()
      .optional(),
    facet: z.enum(PAPER_CLAIM_FACET_VALUES).nullable().optional(),
    polarity: z.enum(PAPER_CLAIM_POLARITY_VALUES).nullable().optional(),
    stance: paperClaimStanceSchema.nullable().optional(),
    evaluationContext: paperClaimEvaluationContextSchema.nullable().optional(),
    text: z.string().min(1),
    sectionLabel: z.string().min(1).nullable().optional(),
    sourceExcerpt: z.string().min(1),
    sourceSpan: paperClaimSourceSpanRuntimeSchema.nullable().optional(),
    citationAnchors: paperClaimCitationAnchorsSchema.nullable().optional(),
    evidenceType: z
      .enum(PAPER_CLAIM_EVIDENCE_TYPE_VALUES)
      .nullable()
      .optional(),
    confidence: z.number().nullable().optional(),
  })
  .passthrough();

export const extractClaimsRuntimeOutputSchema = z
  .object({
    claims: z.array(extractedPaperClaimSchema),
  })
  .passthrough();

export type ExtractedPaperClaim = z.infer<typeof extractedPaperClaimSchema>;
export type ExtractClaimsRuntimeOutput = z.infer<
  typeof extractClaimsRuntimeOutputSchema
>;
