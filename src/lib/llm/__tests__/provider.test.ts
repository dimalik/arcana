import { beforeEach, describe, expect, it, vi } from "vitest";
import { categorizeRuntimeOutputSchema } from "../runtime-output-schemas";

const hoisted = vi.hoisted(() => ({
  streamText: vi.fn(),
  generateObject: vi.fn(),
  chatModel: vi.fn((modelId: string) => ({ kind: "chat-model", modelId })),
  responsesModel: vi.fn((modelId: string) => ({ kind: "responses-model", modelId })),
  anthropicModel: vi.fn((modelId: string) => ({ kind: "anthropic-model", modelId })),
  logLlmUsage: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("ai", () => ({
  JSONParseError: class JSONParseError extends Error {},
  NoObjectGeneratedError: class NoObjectGeneratedError extends Error {
    static isInstance(error: unknown) {
      return error instanceof NoObjectGeneratedError;
    }
  },
  TypeValidationError: class TypeValidationError extends Error {},
  generateObject: hoisted.generateObject,
  streamText: hoisted.streamText,
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn(() => ({
    chat: hoisted.chatModel,
    responses: hoisted.responsesModel,
  })),
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() => hoisted.anthropicModel),
}));

vi.mock("../proxy-settings", () => ({
  resolveEndpointForModel: vi.fn(() => ({
    baseUrl: "https://proxy.example/v1",
    extraHeaders: {},
    sdkProvider: "openai",
  })),
}));

vi.mock("../../usage", () => ({
  logLlmUsage: hoisted.logLlmUsage,
}));

vi.mock("../../logger", () => ({
  logger: {
    error: hoisted.loggerError,
  },
}));

const proxyConfig = {
  enabled: true,
  vendor: "custom" as const,
  baseUrl: "https://proxy.example/v1",
  anthropicBaseUrl: "",
  apiKey: "",
  headerName: "x-proxy",
  headerValue: "token",
  modelId: "gpt-4o-mini",
  contextWindow: 128000,
  maxTokens: 4096,
  routes: [],
};

describe("llm provider context isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps overlapping generate calls isolated via AsyncLocalStorage", async () => {
    const provider = await import("../provider");
    provider.resetLegacyLlmContextFallbackCountForTests();

    hoisted.streamText.mockImplementation(({ prompt }: { prompt: string }) => {
      const variant = prompt.includes("slow") ? "slow" : "fast";
      const delayMs = variant === "slow" ? 20 : 5;

      return {
        text: new Promise<string>((resolve) => {
          setTimeout(() => resolve(`result-${variant}`), delayMs);
        }),
        usage: Promise.resolve({
          inputTokens: variant === "slow" ? 11 : 7,
          outputTokens: variant === "slow" ? 5 : 3,
          totalTokens: variant === "slow" ? 16 : 10,
        }),
      };
    });

    const [slowResult, fastResult] = await Promise.all([
      provider.withLlmContext(
        {
          operation: "processing_summarize",
          userId: "user-slow",
          metadata: { runtime: "processing", paperId: "paper-slow", step: "summarize" },
        },
        () =>
          provider.generateLLMResponse({
            provider: "proxy",
            modelId: "gpt-4o-mini",
            system: "system",
            prompt: "slow prompt",
            proxyConfig,
          }),
      ),
      provider.withLlmContext(
        {
          operation: "processing_categorize",
          userId: "user-fast",
          metadata: { runtime: "processing", paperId: "paper-fast", step: "categorize" },
        },
        () =>
          provider.generateLLMResponse({
            provider: "proxy",
            modelId: "gpt-4o-mini",
            system: "system",
            prompt: "fast prompt",
            proxyConfig,
          }),
      ),
    ]);

    expect(slowResult).toBe("result-slow");
    expect(fastResult).toBe("result-fast");
    expect(provider.getLegacyLlmContextFallbackCountForTests()).toBe(0);
    expect(hoisted.logLlmUsage).toHaveBeenCalledTimes(2);
    expect(hoisted.logLlmUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-slow",
        operation: "processing_summarize",
        metadata: expect.objectContaining({ paperId: "paper-slow", step: "summarize" }),
      }),
    );
    expect(hoisted.logLlmUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-fast",
        operation: "processing_categorize",
        metadata: expect.objectContaining({ paperId: "paper-fast", step: "categorize" }),
      }),
    );
  });

  it("attributes stream onFinish usage with the active async context", async () => {
    const provider = await import("../provider");
    provider.resetLegacyLlmContextFallbackCountForTests();

    hoisted.streamText.mockImplementation(
      ({
        messages,
        onFinish,
      }: {
        messages: Array<{ content: string }>;
        onFinish?: ({ usage }: { usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }) => void;
      }) => {
        const variant = messages[0]?.content.includes("alpha") ? "alpha" : "beta";
        const delayMs = variant === "alpha" ? 15 : 1;

        setTimeout(() => {
          onFinish?.({
            usage: {
              inputTokens: variant === "alpha" ? 20 : 8,
              outputTokens: variant === "alpha" ? 4 : 2,
              totalTokens: variant === "alpha" ? 24 : 10,
            },
          });
        }, delayMs);

        return { streamId: variant };
      },
    );

    const [alphaResult, betaResult] = await Promise.all([
      provider.withLlmContext(
        {
          operation: "processing_extract",
          userId: "user-alpha",
          metadata: { runtime: "processing", paperId: "paper-alpha", step: "extract" },
        },
        () =>
          provider.streamLLMResponse({
            provider: "proxy",
            modelId: "gpt-4o-mini",
            system: "system",
            messages: [{ role: "user", content: "alpha message" }],
            proxyConfig,
          }),
      ),
      provider.withLlmContext(
        {
          operation: "processing_distill",
          userId: "user-beta",
          metadata: { runtime: "processing", paperId: "paper-beta", step: "distill" },
        },
        () =>
          provider.streamLLMResponse({
            provider: "proxy",
            modelId: "gpt-4o-mini",
            system: "system",
            messages: [{ role: "user", content: "beta message" }],
            proxyConfig,
          }),
      ),
    ]);

    expect(alphaResult).toEqual({ streamId: "alpha" });
    expect(betaResult).toEqual({ streamId: "beta" });

    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(provider.getLegacyLlmContextFallbackCountForTests()).toBe(0);
    expect(hoisted.logLlmUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-alpha",
        operation: "processing_extract",
        metadata: expect.objectContaining({ paperId: "paper-alpha", step: "extract" }),
      }),
    );
    expect(hoisted.logLlmUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-beta",
        operation: "processing_distill",
        metadata: expect.objectContaining({ paperId: "paper-beta", step: "distill" }),
      }),
    );
  });

  it("logs structured object usage with the active async context", async () => {
    const provider = await import("../provider");
    provider.resetLegacyLlmContextFallbackCountForTests();

    hoisted.generateObject.mockResolvedValue({
      object: { tags: ["retrieval", "rag", "evaluation"] },
      usage: { inputTokens: 13, outputTokens: 5, totalTokens: 18 },
    });

    const result = await provider.withLlmContext(
      {
        operation: "processing_categorize",
        userId: "user-structured",
        metadata: {
          runtime: "processing",
          paperId: "paper-structured",
          step: "categorize",
        },
      },
      () =>
        provider.generateStructuredObject({
          provider: "proxy",
          modelId: "gpt-4o-mini",
          system: "categorize-system",
          prompt: "categorize prompt",
          schemaName: "categorize",
          schema: categorizeRuntimeOutputSchema,
          proxyConfig,
        }),
    );

    expect(result.object).toEqual({
      tags: ["retrieval", "rag", "evaluation"],
    });
    expect(result.resultText).toBe(
      JSON.stringify({ tags: ["retrieval", "rag", "evaluation"] }),
    );
    expect(provider.getLegacyLlmContextFallbackCountForTests()).toBe(0);
    expect(hoisted.logLlmUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-structured",
        operation: "processing_categorize",
        metadata: expect.objectContaining({
          paperId: "paper-structured",
          step: "categorize",
        }),
      }),
    );
  });
});
