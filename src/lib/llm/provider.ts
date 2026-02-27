import { streamText, LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { getModelInfo, type LLMProvider } from "./models";
import { isAnthropicModel, type ProxyConfig } from "./proxy-settings";

export function getModel(provider: LLMProvider, modelId: string, proxyConfig?: ProxyConfig): LanguageModel {
  if (provider === "proxy") {
    // Use provided proxyConfig, or fall back to env vars
    const baseUrl = proxyConfig?.baseUrl || process.env.LLM_PROXY_URL;
    const headerName = proxyConfig?.headerName || process.env.LLM_PROXY_HEADER_NAME || "X-LLM-Proxy-Calling-Service";
    const headerValue = proxyConfig?.headerValue || process.env.LLM_PROXY_HEADER_VALUE;

    if (!headerValue) {
      throw new Error("Proxy provider is not configured. Configure it in Settings or set LLM_PROXY_HEADER_VALUE in .env");
    }

    // Route Claude models through the Anthropic SDK with the Anthropic proxy URL
    if (isAnthropicModel(modelId)) {
      const anthropicUrl = proxyConfig?.anthropicBaseUrl;
      if (!anthropicUrl) {
        throw new Error("Anthropic proxy base URL is not configured. Set it in Settings.");
      }
      const anthropic = createAnthropic({
        baseURL: anthropicUrl,
        apiKey: "not-needed",
        headers: {
          [headerName]: headerValue,
          "X-LLM-Proxy-Target-URL": "https://api.anthropic.com",
        },
      });
      return anthropic(modelId);
    }

    if (!baseUrl) {
      throw new Error("Proxy base URL is not configured. Configure it in Settings or set LLM_PROXY_URL in .env");
    }

    const proxy = createOpenAI({
      baseURL: baseUrl.replace(/\/chat\/completions$/, ""),
      apiKey: "not-needed",
      headers: {
        [headerName]: headerValue,
      },
    });
    return proxy(modelId);
  }

  if (provider === "openai") {
    const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });
    return openai(modelId);
  } else {
    const anthropic = createAnthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    return anthropic(modelId);
  }
}

/**
 * Hard cap per LLM call: 20,000 chars ≈ 5,000 tokens. Keeps requests
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

export async function generateLLMResponse(params: {
  provider: LLMProvider;
  modelId: string;
  system: string;
  prompt: string;
  maxTokens?: number;
  proxyConfig?: ProxyConfig;
}): Promise<string> {
  const model = getModel(params.provider, params.modelId, params.proxyConfig);

  console.log(`[llm] generateText: model=${params.modelId} system=${params.system.length}chars prompt=${params.prompt.length}chars maxTokens=${params.maxTokens ?? "unset"}`);

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

      console.log(`[llm] generateText OK: ${text.length} chars returned`);
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

      console.error(`[llm] generateText FAILED: status=${status} error=${msg.slice(0, 500)}`);
      throw err;
    }
  }
  throw lastErr;
}

type MessageContent = string | Array<{ type: string; text?: string; image?: string; mediaType?: string }>;

export function streamLLMResponse(params: {
  provider: LLMProvider;
  modelId: string;
  system: string;
  messages: { role: "user" | "assistant" | "system"; content: MessageContent }[];
  proxyConfig?: ProxyConfig;
}) {
  const model = getModel(params.provider, params.modelId, params.proxyConfig);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages = params.messages as any[];

  return streamText({
    model,
    system: params.system,
    messages,
  });
}
