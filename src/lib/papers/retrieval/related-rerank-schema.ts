import { z } from "zod";

export const relatedPaperListwiseSelectionSchema = z
  .object({
    paperId: z.string().min(1),
    relevanceScore: z.number().min(0).max(1),
    rationale: z.string().min(1),
    primarySignals: z.array(z.string().min(1)).max(4).optional(),
  })
  .passthrough();

export const rerankRelatedPapersRuntimeOutputSchema = z
  .object({
    selectedPapers: z.array(relatedPaperListwiseSelectionSchema).max(10),
    summary: z.string().min(1),
  })
  .passthrough();

export type RelatedPaperListwiseSelection = z.infer<
  typeof relatedPaperListwiseSelectionSchema
>;
export type RerankRelatedPapersRuntimeOutput = z.infer<
  typeof rerankRelatedPapersRuntimeOutputSchema
>;
