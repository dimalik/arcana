import { z } from "zod";

// Keep provider-facing schemas simple. Anthropic structured output currently
// rejects several JSON-schema constraints such as array maxItems and numeric
// min/max bounds, so cardinality and value limits are enforced in local code
// after parse instead of in the transport schema.
export const relatedPaperListwiseSelectionSchema = z
  .object({
    paperId: z.string(),
    relevanceScore: z.number(),
    rationale: z.string(),
    primarySignals: z.array(z.string()).optional(),
  })
  .passthrough();

export const rerankRelatedPapersRuntimeOutputSchema = z
  .object({
    selectedPapers: z.array(relatedPaperListwiseSelectionSchema),
    summary: z.string(),
  })
  .passthrough();

export type RelatedPaperListwiseSelection = z.infer<
  typeof relatedPaperListwiseSelectionSchema
>;
export type RerankRelatedPapersRuntimeOutput = z.infer<
  typeof rerankRelatedPapersRuntimeOutputSchema
>;
