import { NextRequest, NextResponse } from "next/server";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { streamText } from "ai";
import { isAnthropicModel, VENDOR_PRESETS, type ProxyVendor } from "@/lib/llm/proxy-settings";

/**
 * POST — test LLM connectivity during onboarding.
 *
 * For direct providers (openai / anthropic), sends a minimal prompt using the
 * provided API key. For proxy, delegates to the proxy test route logic.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const provider = body.provider as string; // "openai" | "anthropic" | "proxy"
    const apiKey = body.apiKey as string;
    const modelId = body.modelId as string;

    // ── Direct providers ────────────────────────────────────────
    if (provider === "openai") {
      if (!apiKey) {
        return NextResponse.json({ ok: false, error: "API key is required" }, { status: 400 });
      }
      const openai = createOpenAI({ apiKey });
      const result = streamText({
        model: openai(modelId || "gpt-4o"),
        prompt: "Say 'ok' and nothing else.",
        maxOutputTokens: 10,
      });
      const text = await result.text;
      return NextResponse.json({ ok: true, response: text.trim() });
    }

    if (provider === "anthropic") {
      if (!apiKey) {
        return NextResponse.json({ ok: false, error: "API key is required" }, { status: 400 });
      }
      const anthropic = createAnthropic({ apiKey });
      const result = streamText({
        model: anthropic(modelId || "claude-sonnet-4-20250514"),
        prompt: "Say 'ok' and nothing else.",
        maxOutputTokens: 10,
      });
      const text = await result.text;
      return NextResponse.json({ ok: true, response: text.trim() });
    }

    // ── Proxy ───────────────────────────────────────────────────
    if (provider === "proxy") {
      const vendor = (body.vendor || "custom") as ProxyVendor;
      const baseUrl = body.baseUrl as string;
      const headerName = body.headerName as string || "Authorization";
      const headerValue = body.headerValue as string;
      const proxyModelId = body.modelId as string || "gpt-3.5-turbo";

      if (!headerValue) {
        return NextResponse.json({ ok: false, error: "Auth header value is required" }, { status: 400 });
      }

      let model;
      if (isAnthropicModel(proxyModelId)) {
        const anthropicBaseUrl = body.anthropicBaseUrl as string;
        if (!anthropicBaseUrl) {
          return NextResponse.json({ ok: false, error: "Anthropic Base URL is required for Claude models" }, { status: 400 });
        }
        const anthropic = createAnthropic({
          baseURL: anthropicBaseUrl,
          apiKey: "not-needed",
          headers: { [headerName]: headerValue },
        });
        model = anthropic(proxyModelId);
      } else {
        if (!baseUrl) {
          return NextResponse.json({ ok: false, error: "Base URL is required" }, { status: 400 });
        }
        const preset = VENDOR_PRESETS[vendor] || VENDOR_PRESETS.custom;
        void preset; // used for reference only
        const proxy = createOpenAI({
          baseURL: baseUrl.replace(/\/chat\/completions$/, ""),
          apiKey: "not-needed",
          headers: { [headerName]: headerValue },
        });
        model = proxy(proxyModelId);
      }

      const result = streamText({
        model,
        prompt: "Say 'ok' and nothing else.",
        maxOutputTokens: 10,
      });
      const text = await result.text;
      return NextResponse.json({ ok: true, response: text.trim() });
    }

    return NextResponse.json({ ok: false, error: `Unknown provider: ${provider}` }, { status: 400 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[onboarding/test-llm] Test failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }
}
