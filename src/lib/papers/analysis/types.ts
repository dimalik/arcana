import { z } from "zod";

export const paperClaimStanceSchema = z.object({
  subjectText: z.string().min(1),
  predicateText: z.string().min(1),
  objectText: z.string().min(1),
  qualifierText: z.string().min(1).optional(),
});

export type PaperClaimStance = z.infer<typeof paperClaimStanceSchema>;

export const paperClaimEvaluationContextSchema = z.object({
  task: z.string().min(1),
  dataset: z.string().min(1),
  metric: z.string().min(1),
  comparator: z.string().min(1).optional(),
  setting: z.string().min(1).optional(),
  split: z.string().min(1).optional(),
});

export type PaperClaimEvaluationContext = z.infer<
  typeof paperClaimEvaluationContextSchema
>;

export const paperClaimSourceSpanSchema = z.object({
  charStart: z.number().int().nonnegative(),
  charEnd: z.number().int().nonnegative(),
  page: z.number().int().positive().optional(),
});

export type PaperClaimSourceSpan = z.infer<typeof paperClaimSourceSpanSchema>;

export const paperClaimCitationAnchorSchema = z.object({
  citationMentionId: z.string().uuid().optional(),
  referenceEntryId: z.string().uuid().optional(),
  rawMarker: z.string().min(1),
});

export type PaperClaimCitationAnchor = z.infer<
  typeof paperClaimCitationAnchorSchema
>;

export const paperClaimCitationAnchorsSchema = z.array(
  paperClaimCitationAnchorSchema,
);

function parseJsonField<T>(
  value: string | null | undefined,
  schema: z.ZodType<T>,
): T | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    const result = schema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function serializeJsonField<T>(
  value: T | null | undefined,
  schema: z.ZodType<T>,
): string | null {
  if (value == null) return null;
  const parsed = schema.safeParse(value);
  return parsed.success ? JSON.stringify(parsed.data) : null;
}

export function parsePaperClaimStance(
  value: string | null | undefined,
): PaperClaimStance | null {
  return parseJsonField(value, paperClaimStanceSchema);
}

export function serializePaperClaimStance(
  value: PaperClaimStance | null | undefined,
): string | null {
  return serializeJsonField(value, paperClaimStanceSchema);
}

export function parsePaperClaimEvaluationContext(
  value: string | null | undefined,
): PaperClaimEvaluationContext | null {
  return parseJsonField(value, paperClaimEvaluationContextSchema);
}

export function serializePaperClaimEvaluationContext(
  value: PaperClaimEvaluationContext | null | undefined,
): string | null {
  return serializeJsonField(value, paperClaimEvaluationContextSchema);
}

export function parsePaperClaimSourceSpan(
  value: string | null | undefined,
): PaperClaimSourceSpan | null {
  return parseJsonField(value, paperClaimSourceSpanSchema);
}

export function serializePaperClaimSourceSpan(
  value: PaperClaimSourceSpan | null | undefined,
): string | null {
  return serializeJsonField(value, paperClaimSourceSpanSchema);
}

export function parsePaperClaimCitationAnchors(
  value: string | null | undefined,
): PaperClaimCitationAnchor[] {
  return parseJsonField(value, paperClaimCitationAnchorsSchema) ?? [];
}

export function serializePaperClaimCitationAnchors(
  value: PaperClaimCitationAnchor[] | null | undefined,
): string | null {
  return serializeJsonField(value ?? [], paperClaimCitationAnchorsSchema);
}

export function hasContradictionReadyEvaluationContext(
  value: PaperClaimEvaluationContext | null | undefined,
): value is PaperClaimEvaluationContext {
  return Boolean(value?.task && value?.dataset && value?.metric);
}
