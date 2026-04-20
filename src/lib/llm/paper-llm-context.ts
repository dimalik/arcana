import { withLlmContext } from "./provider";
export {
  PAPER_INTERACTIVE_LLM_OPERATIONS,
  PAPER_ANALYSIS_LLM_OPERATIONS,
  PAPER_REFERENCE_ENRICHMENT_LLM_OPERATIONS,
  PAPER_INTERACTIVE_LLM_OPERATION_VALUES,
  PAPER_ANALYSIS_LLM_OPERATION_VALUES,
  PAPER_REFERENCE_ENRICHMENT_LLM_OPERATION_VALUES,
} from "./paper-llm-operations";
import type { PaperLlmOperation } from "./paper-llm-operations";

export type PaperLlmRuntime = "interactive" | "reference_enrichment";

export function withPaperLlmContext<T>(
  params: {
    operation: PaperLlmOperation;
    paperId: string;
    userId?: string;
    runtime: PaperLlmRuntime;
    source: string;
    metadata?: Record<string, unknown>;
  },
  fn: () => T,
): T {
  return withLlmContext(
    {
      operation: params.operation,
      userId: params.userId,
      metadata: {
        runtime: params.runtime,
        source: params.source,
        paperId: params.paperId,
        ...(params.metadata ?? {}),
      },
    },
    fn,
  );
}
