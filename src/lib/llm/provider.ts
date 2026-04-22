import { AsyncLocalStorage } from "node:async_hooks";
import {
  JSONParseError,
  NoObjectGeneratedError,
  TypeValidationError,
  generateObject as aiGenerateObject,
  streamText,
  LanguageModel,
} from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { ZodTypeAny } from "zod";
import { getModelInfo, type LLMProvider } from "./models";
import { resolveEndpointForModel, type ProxyConfig } from "./proxy-settings";
import { logLlmUsage } from "../usage";
import { logger } from "../logger";
import type { ProcessingRuntimeStructuredPromptType } from "./runtime-output-schemas";

// Cache resolved API keys for the lifetime of the process to avoid
// hitting the DB on every single LLM call. Cleared on save.
let _cachedOpenAIKey: string | null | undefined;
let _cachedAnthropicKey: string | null | undefined;
let _legacyContextFallbackCount = 0;

export interface LlmContext {
  operation: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

const llmContextStorage = new AsyncLocalStorage<LlmContext>();

export function clearApiKeyCache() {
  _cachedOpenAIKey = undefined;
  _cachedAnthropicKey = undefined;
}

function getLegacyLlmContext(): LlmContext {
  return {
    operation: _currentOperation,
    userId: _currentUserId,
    metadata: _currentMetadata,
  };
}

function getActiveLlmContext(): LlmContext {
  const context = llmContextStorage.getStore();
  if (context) {
    return context;
  }

  _legacyContextFallbackCount += 1;
  return getLegacyLlmContext();
}

export function withLlmContext<T>(context: LlmContext, fn: () => T): T {
  return llmContextStorage.run(
    {
      operation: context.operation,
      userId: context.userId,
      metadata: context.metadata ? { ...context.metadata } : undefined,
    },
    fn,
  );
}

export function resetLegacyLlmContextFallbackCountForTests() {
  _legacyContextFallbackCount = 0;
}

export function getLegacyLlmContextFallbackCountForTests() {
  return _legacyContextFallbackCount;
}

type LanguageModelUsage = "single-shot" | "tool-loop";

export class StructuredLlmOutputError extends Error {
  readonly code:
    | "json_parse_failed"
    | "schema_validation_failed"
    | "object_generation_failed";
  readonly schemaName: string;
  readonly provider: LLMProvider;
  readonly modelId: string;

  constructor(options: {
    code:
      | "json_parse_failed"
      | "schema_validation_failed"
      | "object_generation_failed";
    schemaName: string;
    provider: LLMProvider;
    modelId: string;
    cause?: unknown;
  }) {
    const reason =
      options.code === "json_parse_failed"
        ? "did not return valid JSON"
        : options.code === "schema_validation_failed"
          ? "returned JSON that did not match the frozen schema"
          : "failed before a validated object was produced";
    super(
      `Structured LLM output for ${options.schemaName} ${reason}`,
      options.cause ? { cause: options.cause } : undefined,
    );
    this.name = "StructuredLlmOutputError";
    this.code = options.code;
    this.schemaName = options.schemaName;
    this.provider = options.provider;
    this.modelId = options.modelId;
  }
}

function classifyStructuredObjectError(
  error: unknown,
): StructuredLlmOutputError["code"] {
  if (error instanceof JSONParseError) {
    return "json_parse_failed";
  }

  if (error instanceof TypeValidationError) {
    return "schema_validation_failed";
  }

  if (NoObjectGeneratedError.isInstance(error)) {
    const cause = error.cause;
    if (cause instanceof JSONParseError) {
      return "json_parse_failed";
    }
    if (cause instanceof TypeValidationError) {
      return "schema_validation_failed";
    }
  }

  return "object_generation_failed";
}

async function getResolvedApiKey(provider: "openai" | "anthropic"): Promise<string | undefined> {
  if (provider === "openai") {
    if (_cachedOpenAIKey === undefined) {
      const { getApiKey } = await import("./api-keys");
      _cachedOpenAIKey = await getApiKey("openai");
    }
    return _cachedOpenAIKey || undefined;
  }
  if (_cachedAnthropicKey === undefined) {
    const { getApiKey } = await import("./api-keys");
    _cachedAnthropicKey = await getApiKey("anthropic");
  }
  return _cachedAnthropicKey || undefined;
}

async function getLanguageModelForUsage(
  provider: LLMProvider,
  modelId: string,
  usage: LanguageModelUsage,
  proxyConfig?: ProxyConfig,
): Promise<LanguageModel> {
  if (provider === "proxy") {
    const headerName = proxyConfig?.headerName || process.env.LLM_PROXY_HEADER_NAME || "X-LLM-Proxy-Calling-Service";
    const headerValue = proxyConfig?.headerValue || process.env.LLM_PROXY_HEADER_VALUE;

    if (!headerValue) {
      throw new Error("Endpoint not configured. Set it up in Settings → LLM.");
    }

    // Resolve the correct endpoint URL and SDK for this model.
    // For gateway proxies: routes each provider to its own URL path.
    // For simple proxies (OpenRouter, LiteLLM): same base URL for all.
    const config = proxyConfig || { baseUrl: process.env.LLM_PROXY_URL || "", anthropicBaseUrl: "", routes: [] } as unknown as ProxyConfig;
    const { baseUrl, extraHeaders, sdkProvider } = resolveEndpointForModel(config, modelId);

    if (!baseUrl) {
      throw new Error(`No endpoint URL configured for ${modelId}. Check Settings → LLM.`);
    }

    const headers: Record<string, string> = { [headerName]: headerValue, ...extraHeaders };

    if (sdkProvider === "anthropic") {
      const anthropic = createAnthropic({
        baseURL: baseUrl,
        apiKey: proxyConfig?.apiKey || "not-needed",
        headers,
      });
      return anthropic(modelId);
    }

    const openaiBaseUrl = baseUrl.replace(/\/responses$/, "").replace(/\/chat\/completions$/, "");
    const openai = createOpenAI({
      baseURL: openaiBaseUrl,
      apiKey: proxyConfig?.apiKey || "not-needed",
      headers,
    });

    if (sdkProvider === "openai-responses" && usage === "single-shot") {
      return openai.responses(modelId);
    }

    if (sdkProvider === "openai-responses" && usage === "tool-loop") {
      return openai.chat(modelId as never);
    }

    // Google models also route through OpenAI-compatible SDK
    // (most proxies expose Gemini via OpenAI-compatible endpoints)
    return openai.chat(modelId as never);
  }

  if (provider === "openai") {
    const apiKey = await getResolvedApiKey("openai");
    if (!apiKey) throw new Error("OpenAI API key not configured. Set it in Settings → LLM.");
    const openai = createOpenAI({ apiKey });
    return openai.chat(modelId as never);
  }

  const apiKey = await getResolvedApiKey("anthropic");
  if (!apiKey) throw new Error("Anthropic API key not configured. Set it in Settings → LLM.");
  const anthropic = createAnthropic({ apiKey });
  return anthropic(modelId);
}

export async function getModel(provider: LLMProvider, modelId: string, proxyConfig?: ProxyConfig): Promise<LanguageModel> {
  return getLanguageModelForUsage(provider, modelId, "single-shot", proxyConfig);
}

/**
 * Tool-heavy agent loops should avoid the Responses API on OpenAI-compatible
 * providers. In Zero Data Retention environments, multi-step tool calls can
 * fail when follow-up requests reference transient response items.
 */
export async function getToolLoopModel(
  provider: LLMProvider,
  modelId: string,
  proxyConfig?: ProxyConfig,
): Promise<LanguageModel> {
  return getLanguageModelForUsage(provider, modelId, "tool-loop", proxyConfig);
}

/**
 * Hard cap per LLM call: 20,000 chars ~ 5,000 tokens. Keeps requests
 * well within proxy gateway timeout limits. Longer papers are handled
 * via chunked map-reduce in the summarize step.
 */
export const MAX_PAPER_CHARS = 20_000;

export function truncateText(text: string, modelId: string, proxyConfig?: ProxyConfig): string {
  const model = getModelInfo(modelId);
  const contextWindow = proxyConfig?.contextWindow || model?.contextWindow || 128000;
  const budgetChars = Math.floor(contextWindow * 0.4 * 4);
  const maxChars = Math.min(budgetChars, MAX_PAPER_CHARS);
  if (text.length <= maxChars) return text;

  // Keep beginning (abstract, intro, methods) and end (results, conclusion)
  // with more weight on the beginning where key ideas are introduced.
  const headChars = Math.floor(maxChars * 0.7);
  const tailChars = maxChars - headChars;
  const head = text.slice(0, headChars);
  const tail = text.slice(-tailChars);
  return head + "\n\n[... middle section omitted for length ...]\n\n" + tail;
}

export function truncateTextMultiPaper(
  primaryText: string,
  additionalTexts: { title: string; text: string }[],
  modelId: string,
  proxyConfig?: ProxyConfig
): { primary: string; additional: { title: string; text: string }[] } {
  const model = getModelInfo(modelId);
  const contextWindow = proxyConfig?.contextWindow || model?.contextWindow || 128000;
  const totalBudget = Math.floor(contextWindow * 0.4 * 4);
  const primaryBudget = Math.floor(totalBudget * 0.6);
  const additionalBudget = totalBudget - primaryBudget;

  const primary =
    primaryText.length <= primaryBudget
      ? primaryText
      : primaryText.slice(0, primaryBudget) + "\n\n[Text truncated due to length...]";

  if (additionalTexts.length === 0) {
    return { primary, additional: [] };
  }

  const perPaperBudget = Math.floor(additionalBudget / additionalTexts.length);
  const additional = additionalTexts.map((p) => ({
    title: p.title,
    text:
      p.text.length <= perPaperBudget
        ? p.text
        : p.text.slice(0, perPaperBudget) + "\n\n[Text truncated due to length...]",
  }));

  return { primary, additional };
}

const LLM_MAX_RETRIES = 3;
const LLM_BASE_DELAY_MS = 5_000; // 5s, 10s, 20s

function isLLMRetryable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  const status = (e.statusCode ?? e.status) as number | undefined;
  // Retry rate limits, server errors, and gateway timeouts (transient proxy issues)
  if (status === 429) return true;
  if (status && status >= 500) return true;
  // Network errors
  const msg = ((e.message ?? "") as string).toLowerCase();
  if (msg.includes("gateway time") || msg.includes("gateway timeout")) return true;
  const code = (e.code ?? "") as string;
  if (["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED"].includes(code)) return true;
  return false;
}

// ── Tracked operation context (set per-request) ──────────────────

let _currentOperation = "unknown";
let _currentUserId: string | undefined;
let _currentMetadata: Record<string, unknown> | undefined;

/**
 * Set the operation context for subsequent LLM calls.
 * Call this at the start of an API route handler.
 */
export function setLlmContext(
  operation: string,
  userId?: string,
  metadata?: Record<string, unknown>
) {
  _currentOperation = operation;
  _currentUserId = userId;
  _currentMetadata = metadata;
}

export async function generateLLMResponse(params: {
  provider: LLMProvider;
  modelId: string;
  system: string;
  prompt: string;
  maxTokens?: number;
  proxyConfig?: ProxyConfig;
}): Promise<string> {
  const model = await getModel(params.provider, params.modelId, params.proxyConfig);
  const startMs = Date.now();
  const activeContext = getActiveLlmContext();

  console.log(`[llm] generateText: model=${params.modelId} op=${activeContext.operation} system=${params.system.length}chars prompt=${params.prompt.length}chars maxTokens=${params.maxTokens ?? "unset"}`);

  let lastErr: unknown;
  for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt++) {
    try {
      // Use streamText so the proxy gateway sees data flowing and doesn't
      // time out waiting for the complete response. We collect the full
      // text at the end.
      const result = streamText({
        model,
        system: params.system,
        prompt: params.prompt,
        ...(params.maxTokens ? { maxOutputTokens: params.maxTokens } : {}),
        maxRetries: 0,
      });

      const text = await result.text;
      const usage = await result.usage;
      const durationMs = Date.now() - startMs;
      const context = getActiveLlmContext();

      console.log(`[llm] generateText OK: ${text.length} chars, ${usage.totalTokens} tokens, ${durationMs}ms`);

      // Log usage asynchronously — don't block response
      logLlmUsage({
        userId: context.userId,
        provider: params.provider,
        modelId: params.modelId,
        operation: context.operation,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        totalTokens: usage.totalTokens ?? 0,
        durationMs,
        success: true,
        metadata: context.metadata,
      });

      return text;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const status = (err as Record<string, unknown>)?.statusCode ?? (err as Record<string, unknown>)?.status ?? "?";

      if (attempt < LLM_MAX_RETRIES && isLLMRetryable(err)) {
        const backoff = LLM_BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(`[llm] generateText attempt ${attempt + 1}/${LLM_MAX_RETRIES + 1} failed (status=${status}), retrying in ${backoff}ms: ${msg.slice(0, 200)}`);
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }

      const durationMs = Date.now() - startMs;
      const context = getActiveLlmContext();
      console.error(`[llm] generateText FAILED: status=${status} error=${msg.slice(0, 500)}`);

      // Log failure
      logLlmUsage({
        userId: context.userId,
        provider: params.provider,
        modelId: params.modelId,
        operation: context.operation,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        durationMs,
        success: false,
        error: msg.slice(0, 2000),
        metadata: context.metadata,
      });

      logger.error(`LLM call failed: ${context.operation}`, {
        category: "llm",
        userId: context.userId,
        error: err,
        metadata: {
          provider: params.provider,
          modelId: params.modelId,
          operation: context.operation,
          status,
          attempt: attempt + 1,
          ...context.metadata,
        },
      });

      throw err;
    }
  }
  throw lastErr;
}

export async function generateStructuredObject<TSchema extends ZodTypeAny>(params: {
  provider: LLMProvider;
  modelId: string;
  system: string;
  prompt: string;
  schema: TSchema;
  schemaName: ProcessingRuntimeStructuredPromptType;
  maxTokens?: number;
  proxyConfig?: ProxyConfig;
}): Promise<{ object: TSchema["_output"]; resultText: string }> {
  const model = await getModel(params.provider, params.modelId, params.proxyConfig);
  const startMs = Date.now();
  const activeContext = getActiveLlmContext();

  console.log(
    `[llm] generateObject: model=${params.modelId} op=${activeContext.operation} schema=${params.schemaName} system=${params.system.length}chars prompt=${params.prompt.length}chars maxTokens=${params.maxTokens ?? "unset"}`,
  );

  let lastErr: unknown;
  for (let attempt = 0; attempt <= LLM_MAX_RETRIES; attempt++) {
    try {
      const result = await aiGenerateObject({
        model,
        schema: params.schema,
        system: params.system,
        prompt: params.prompt,
        ...(params.maxTokens ? { maxOutputTokens: params.maxTokens } : {}),
        maxRetries: 0,
      });

      const durationMs = Date.now() - startMs;
      const context = getActiveLlmContext();
      const resultText = JSON.stringify(params.schema.parse(result.object));

      console.log(
        `[llm] generateObject OK: schema=${params.schemaName}, ${resultText.length} chars, ${result.usage.totalTokens} tokens, ${durationMs}ms`,
      );

      logLlmUsage({
        userId: context.userId,
        provider: params.provider,
        modelId: params.modelId,
        operation: context.operation,
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
        totalTokens: result.usage.totalTokens ?? 0,
        durationMs,
        success: true,
        metadata: context.metadata,
      });

      return {
        object: result.object as TSchema["_output"],
        resultText,
      };
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      const status = (err as Record<string, unknown>)?.statusCode ?? (err as Record<string, unknown>)?.status ?? "?";

      if (attempt < LLM_MAX_RETRIES && isLLMRetryable(err)) {
        const backoff = LLM_BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(
          `[llm] generateObject attempt ${attempt + 1}/${LLM_MAX_RETRIES + 1} failed (status=${status}), retrying in ${backoff}ms: ${msg.slice(0, 200)}`,
        );
        await new Promise((r) => setTimeout(r, backoff));
        continue;
      }

      const durationMs = Date.now() - startMs;
      const context = getActiveLlmContext();
      const structuredError = new StructuredLlmOutputError({
        code: classifyStructuredObjectError(err),
        schemaName: params.schemaName,
        provider: params.provider,
        modelId: params.modelId,
        cause: err,
      });

      console.error(
        `[llm] generateObject FAILED: schema=${params.schemaName} status=${status} error=${msg.slice(0, 500)}`,
      );

      logLlmUsage({
        userId: context.userId,
        provider: params.provider,
        modelId: params.modelId,
        operation: context.operation,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        durationMs,
        success: false,
        error: structuredError.message.slice(0, 2000),
        metadata: context.metadata,
      });

      logger.error(`Structured LLM call failed: ${context.operation}`, {
        category: "llm",
        userId: context.userId,
        error: structuredError,
        metadata: {
          provider: params.provider,
          modelId: params.modelId,
          operation: context.operation,
          status,
          attempt: attempt + 1,
          schemaName: params.schemaName,
          ...context.metadata,
        },
      });

      throw structuredError;
    }
  }

  throw lastErr;
}

type MessageContent =
  | string
  | Array<
      | { type: "text"; text: string }
      | {
          type: "image";
          image: string | Uint8Array;
          mediaType?: string;
          mimeType?: string;
        }
    >;

export async function streamLLMResponse(params: {
  provider: LLMProvider;
  modelId: string;
  system: string;
  messages: { role: "user" | "assistant" | "system"; content: MessageContent }[];
  proxyConfig?: ProxyConfig;
}) {
  const model = await getModel(params.provider, params.modelId, params.proxyConfig);
  const startMs = Date.now();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages = params.messages as any[];

  return streamText({
    model,
    system: params.system,
    messages,
    onFinish: ({ usage }) => {
      const durationMs = Date.now() - startMs;
      const context = getActiveLlmContext();
      logLlmUsage({
        userId: context.userId,
        provider: params.provider,
        modelId: params.modelId,
        operation: context.operation,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        totalTokens: usage.totalTokens ?? 0,
        durationMs,
        success: true,
        metadata: context.metadata,
      });
    },
  });
}
