// Compatibility aliases for historical backend ids.
//
// The local Python/external-service reranker path was removed because it was
// tripping lint/runtime constraints in Next dev and hanging on cold starts.
// These backend ids now resolve to the existing OpenAI-compatible LLM reranker
// path inside related-ranker.ts.

export type OpenRelatedRerankerBackendId =
  | "qwen3_reranker_v1"
  | "bge_reranker_v1";
