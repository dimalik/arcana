import {
  PAPER_INTERACTIVE_LLM_OPERATION_VALUES,
  PAPER_REFERENCE_ENRICHMENT_LLM_OPERATION_VALUES,
} from "./llm/paper-llm-operations";

export const PAPER_COST_SEGMENTS = [
  "processing",
  "interactive",
  "reference_enrichment",
  "agent",
  "unclassified",
] as const;

export type PaperCostSegment = (typeof PAPER_COST_SEGMENTS)[number];
export type ProviderUsageSegment = Exclude<PaperCostSegment, "agent">;

export const REFERENCE_ENRICHMENT_PROCESSING_OPERATIONS = [
  "processing_extractReferences",
  "processing_extractCitationContexts",
] as const;

const INTERACTIVE_OPERATION_SET = new Set<string>(PAPER_INTERACTIVE_LLM_OPERATION_VALUES);
// These two operations are emitted by the processing runtime, but they are
// reference-surface work and therefore roll up under reference_enrichment.
const REFERENCE_ENRICHMENT_OPERATION_SET = new Set<string>([
  ...PAPER_REFERENCE_ENRICHMENT_LLM_OPERATION_VALUES,
  ...REFERENCE_ENRICHMENT_PROCESSING_OPERATIONS,
]);

export function getProviderUsageSegment(
  operation: string,
): ProviderUsageSegment {
  if (REFERENCE_ENRICHMENT_OPERATION_SET.has(operation)) {
    return "reference_enrichment";
  }
  if (operation.startsWith("processing_")) {
    return "processing";
  }
  if (INTERACTIVE_OPERATION_SET.has(operation)) {
    return "interactive";
  }
  return "unclassified";
}

export function isMappedProviderUsageOperation(operation: string): boolean {
  return getProviderUsageSegment(operation) !== "unclassified";
}

export function getKnownPaperUsageOperations(): string[] {
  return [
    ...PAPER_INTERACTIVE_LLM_OPERATION_VALUES,
    ...PAPER_REFERENCE_ENRICHMENT_LLM_OPERATION_VALUES,
    ...REFERENCE_ENRICHMENT_PROCESSING_OPERATIONS,
  ];
}
