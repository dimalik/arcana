export const PAPER_INTERACTIVE_LLM_OPERATIONS = {
  CHAT: "paper_chat",
  CHAT_AGENT_PLAN: "paper_chat_agent_plan",
  CHAT_AGENT_CODE: "paper_chat_agent_code",
  CONVERSATION_MESSAGE: "paper_conversation_message",
  DISTILL: "paper_distill",
  RELATED_RERANK: "paper_related_rerank",
  SUMMARIZE: "paper_summarize",
  CATEGORIZE: "paper_categorize",
  EXTRACT: "paper_extract",
  CUSTOM: "paper_custom",
  CODE: "paper_code",
  REWRITE_SECTION: "paper_rewrite_section",
  COMPARE_METHODOLOGIES: "paper_compare_methodologies",
  GAP_FINDER: "paper_gap_finder",
  TIMELINE: "paper_timeline",
} as const;

export const PAPER_REFERENCE_ENRICHMENT_LLM_OPERATIONS = {
  EXTRACT_CONTEXTS: "paper_reference_extract_contexts",
} as const;

export const PAPER_ANALYSIS_LLM_OPERATIONS = {
  EXTRACT_CLAIMS: "paper_extract_claims",
  DETECT_CONTRADICTIONS: "paper_detect_contradictions",
  FIND_GAPS: PAPER_INTERACTIVE_LLM_OPERATIONS.GAP_FINDER,
  BUILD_TIMELINE: PAPER_INTERACTIVE_LLM_OPERATIONS.TIMELINE,
  COMPARE_METHODOLOGIES: PAPER_INTERACTIVE_LLM_OPERATIONS.COMPARE_METHODOLOGIES,
} as const;

export const PAPER_INTERACTIVE_LLM_OPERATION_VALUES = Object.values(
  PAPER_INTERACTIVE_LLM_OPERATIONS,
);

export const PAPER_REFERENCE_ENRICHMENT_LLM_OPERATION_VALUES = Object.values(
  PAPER_REFERENCE_ENRICHMENT_LLM_OPERATIONS,
);

export const PAPER_ANALYSIS_LLM_OPERATION_VALUES = Object.values(
  PAPER_ANALYSIS_LLM_OPERATIONS,
);

export type PaperInteractiveLlmOperation =
  (typeof PAPER_INTERACTIVE_LLM_OPERATIONS)[keyof typeof PAPER_INTERACTIVE_LLM_OPERATIONS];

export type PaperReferenceEnrichmentLlmOperation =
  (typeof PAPER_REFERENCE_ENRICHMENT_LLM_OPERATIONS)[keyof typeof PAPER_REFERENCE_ENRICHMENT_LLM_OPERATIONS];

export type PaperAnalysisLlmOperation =
  (typeof PAPER_ANALYSIS_LLM_OPERATIONS)[keyof typeof PAPER_ANALYSIS_LLM_OPERATIONS];

export type PaperLlmOperation =
  | PaperInteractiveLlmOperation
  | PaperReferenceEnrichmentLlmOperation
  | PaperAnalysisLlmOperation;
