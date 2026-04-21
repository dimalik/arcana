import { z } from "zod";

export const paperAnswerIntentSchema = z.enum([
  "direct_qa",
  "claims",
  "results",
  "figures",
  "tables",
  "code",
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

export const agentActionSummarySchema = z.object({
  step: z.number().int(),
  action: z.string(),
  detail: z.string(),
  phase: z.enum(["retrieve", "inspect", "synthesize"]).optional(),
  status: z.enum(["completed", "missing"]).optional(),
  source: z.enum(["planner", "fallback", "system"]).optional(),
  tool: z.string().optional(),
  input: z.string().nullable().optional(),
  outputPreview: z.string().nullable().optional(),
  citationsAdded: z.number().int().optional(),
  artifactsAdded: z.number().int().optional(),
});

export type AgentActionSummary = z.infer<typeof agentActionSummarySchema>;

export const chatMessageMetadataSchema = z.object({
  intent: paperAnswerIntentSchema,
  citations: z.array(answerCitationSchema),
  agentActions: z.array(agentActionSummarySchema).optional(),
  artifacts: z
    .array(
      z.object({
        id: z.string().optional(),
        kind: z.string(),
        title: z.string(),
        payloadJson: z.string(),
      }),
    )
    .optional(),
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
