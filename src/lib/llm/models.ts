export type LLMProvider = "openai" | "anthropic" | "proxy";

export interface ModelInfo {
  id: string;
  name: string;
  provider: LLMProvider;
  maxTokens: number;
  contextWindow: number;
}

const BASE_MODELS: ModelInfo[] = [
  {
    id: "gpt-4o",
    name: "GPT-4o",
    provider: "openai",
    maxTokens: 4096,
    contextWindow: 128000,
  },
  {
    id: "gpt-4o-mini",
    name: "GPT-4o Mini",
    provider: "openai",
    maxTokens: 4096,
    contextWindow: 128000,
  },
  {
    id: "gpt-4-turbo",
    name: "GPT-4 Turbo",
    provider: "openai",
    maxTokens: 4096,
    contextWindow: 128000,
  },
  {
    id: "claude-sonnet-4-20250514",
    name: "Claude Sonnet 4",
    provider: "anthropic",
    maxTokens: 8192,
    contextWindow: 200000,
  },
  {
    id: "claude-haiku-4-5-20251001",
    name: "Claude Haiku 4.5",
    provider: "anthropic",
    maxTokens: 8192,
    contextWindow: 200000,
  },
  {
    id: "claude-opus-4-20250514",
    name: "Claude Opus 4",
    provider: "anthropic",
    maxTokens: 8192,
    contextWindow: 200000,
  },
];

export function buildProxyModelInfo(modelId: string, contextWindow = 128000, maxTokens = 4096): ModelInfo {
  return {
    id: modelId,
    name: `${modelId} (Proxy)`,
    provider: "proxy",
    maxTokens,
    contextWindow,
  };
}

export const AVAILABLE_MODELS: ModelInfo[] = BASE_MODELS;

export function getAllModels(proxyModel?: ModelInfo | null): ModelInfo[] {
  if (proxyModel) {
    return [...BASE_MODELS, proxyModel];
  }
  return BASE_MODELS;
}

export function getModelInfo(modelId: string): ModelInfo | undefined {
  return getAllModels().find((m) => m.id === modelId);
}

export function getModelsByProvider(provider: LLMProvider): ModelInfo[] {
  return getAllModels().filter((m) => m.provider === provider);
}
