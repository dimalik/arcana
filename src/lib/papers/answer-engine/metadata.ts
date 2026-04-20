import { z } from "zod";

export const paperAnswerIntentSchema = z.enum([
  "direct_qa",
  "claims",
  "contradictions",
  "gaps",
  "timeline",
  "compare_methodologies",
]);

export type PaperAnswerIntent = z.infer<typeof paperAnswerIntentSchema>;

export const answerCitationSchema = z.object({
  paperId: z.string(),
  paperTitle: z.string(),
  snippet: z.string(),
  sectionPath: z.string().nullable().optional(),
  sourceKind: z.enum(["claim", "selection", "summary", "artifact"]),
});

export type AnswerCitation = z.infer<typeof answerCitationSchema>;

export const chatMessageMetadataSchema = z.object({
  intent: paperAnswerIntentSchema,
  citations: z.array(answerCitationSchema),
});

export type ChatMessageMetadata = z.infer<typeof chatMessageMetadataSchema>;

export function parseChatMessageMetadata(
  value: string | null | undefined,
): ChatMessageMetadata | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    const result = chatMessageMetadataSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function serializeChatMessageMetadata(
  value: ChatMessageMetadata | null | undefined,
): string | null {
  if (!value) return null;
  const result = chatMessageMetadataSchema.safeParse(value);
  return result.success ? JSON.stringify(result.data) : null;
}
