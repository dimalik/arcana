import { generateText, streamText, LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { getModelInfo, type LLMProvider } from "./models";
import type { ProxyConfig } from "./proxy-settings";

export function getModel(provider: LLMProvider, modelId: string, proxyConfig?: ProxyConfig): LanguageModel {
  if (provider === "proxy") {
    // Use provided proxyConfig, or fall back to env vars
    const baseUrl = proxyConfig?.baseUrl || process.env.LLM_PROXY_URL;
    const headerName = proxyConfig?.headerName || process.env.LLM_PROXY_HEADER_NAME || "X-LLM-Proxy-Calling-Service";
    const headerValue = proxyConfig?.headerValue || process.env.LLM_PROXY_HEADER_VALUE;

    if (!baseUrl || !headerValue) {
      throw new Error("Proxy provider is not configured. Configure it in Settings or set LLM_PROXY_URL and LLM_PROXY_HEADER_VALUE in .env");
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

export function truncateText(text: string, modelId: string, proxyConfig?: ProxyConfig): string {
  const model = getModelInfo(modelId);
  const contextWindow = proxyConfig?.contextWindow || model?.contextWindow || 128000;
  // Budget: 50% of context for paper text, rest for system prompt + output.
  // Conservative estimate: ~4 chars per token for English text.
  const maxChars = Math.floor(contextWindow * 0.5 * 4);
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n\n[Text truncated due to length...]";
}

export function truncateTextMultiPaper(
  primaryText: string,
  additionalTexts: { title: string; text: string }[],
  modelId: string,
  proxyConfig?: ProxyConfig
): { primary: string; additional: { title: string; text: string }[] } {
  const model = getModelInfo(modelId);
  const contextWindow = proxyConfig?.contextWindow || model?.contextWindow || 128000;
  const totalBudget = Math.floor(contextWindow * 0.5 * 4);
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

export async function generateLLMResponse(params: {
  provider: LLMProvider;
  modelId: string;
  system: string;
  prompt: string;
  maxTokens?: number;
  proxyConfig?: ProxyConfig;
}): Promise<string> {
  const model = getModel(params.provider, params.modelId, params.proxyConfig);

  const { text } = await generateText({
    model,
    system: params.system,
    prompt: params.prompt,
    ...(params.maxTokens ? { maxTokens: params.maxTokens } : {}),
  });

  return text;
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
