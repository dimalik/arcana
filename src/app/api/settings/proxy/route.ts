import { NextRequest, NextResponse } from "next/server";
import { getProxyConfig, saveProxyConfig, isAnthropicModel, VENDOR_PRESETS, type ProxyVendor } from "@/lib/llm/proxy-settings";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { streamText } from "ai";

/**
 * GET — return proxy config with API key masked.
 */
export async function GET() {
  const config = await getProxyConfig();

  return NextResponse.json({
    enabled: config.enabled,
    vendor: config.vendor,
    baseUrl: config.baseUrl,
    anthropicBaseUrl: config.anthropicBaseUrl,
    apiKey: config.apiKey ? `****${config.apiKey.slice(-4)}` : "",
    headerName: config.headerName,
    headerValue: config.headerValue ? `****${config.headerValue.slice(-4)}` : "",
    modelId: config.modelId,
    contextWindow: config.contextWindow,
    maxTokens: config.maxTokens,
  });
}

/**
 * PUT — validate and save proxy config.
 * Accepts apiKey: null to mean "keep existing".
 */
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();

    const vendor = (body.vendor || "custom") as ProxyVendor;
    if (!VENDOR_PRESETS[vendor]) {
      return NextResponse.json({ error: "Invalid vendor" }, { status: 400 });
    }

    await saveProxyConfig({
      vendor,
      baseUrl: body.baseUrl || "",
      anthropicBaseUrl: body.anthropicBaseUrl || "",
      apiKey: body.apiKey ?? null, // null = keep existing
      headerName: body.headerName || "Authorization",
      headerValue: body.headerValue || "",
      modelId: body.modelId || "",
      contextWindow: parseInt(body.contextWindow, 10) || 128000,
      maxTokens: parseInt(body.maxTokens, 10) || 4096,
      routes: body.routes || undefined,
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[proxy settings] PUT error:", e);
    return NextResponse.json({ error: "Failed to save proxy config" }, { status: 500 });
  }
}

/**
 * POST — test proxy connectivity with a minimal LLM call.
 * Supports both simple and gateway modes via resolveEndpointForModel.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const headerName = body.headerName || "Authorization";
    const headerValue = body.headerValue || "";
    const modelId = body.modelId || "gpt-3.5-turbo";

    if (!headerValue) {
      return NextResponse.json({ error: "Header value / API key is required" }, { status: 400 });
    }
    if (!body.baseUrl) {
      return NextResponse.json({ error: "Base URL is required" }, { status: 400 });
    }

    // Build a ProxyConfig for resolveEndpointForModel
    const { resolveEndpointForModel } = await import("@/lib/llm/proxy-settings");
    const testConfig = {
      enabled: true,
      vendor: body.vendor || "custom",
      baseUrl: body.baseUrl,
      anthropicBaseUrl: body.anthropicBaseUrl || "",
      apiKey: "",
      headerName,
      headerValue,
      modelId,
      contextWindow: 128000,
      maxTokens: 4096,
      routes: body.routes || [],
    } as unknown as import("@/lib/llm/proxy-settings").ProxyConfig;

    const { baseUrl: resolvedUrl, extraHeaders, sdkProvider } = resolveEndpointForModel(testConfig, modelId);

    if (!resolvedUrl) {
      return NextResponse.json({ error: `No endpoint URL resolved for model "${modelId}". Check the routes configuration.` }, { status: 400 });
    }

    const headers: Record<string, string> = { [headerName]: headerValue, ...extraHeaders };

    let model;
    if (sdkProvider === "anthropic") {
      const anthropic = createAnthropic({
        baseURL: resolvedUrl,
        apiKey: "not-needed",
        headers,
      });
      model = anthropic(modelId);
    } else {
      const proxy = createOpenAI({
        baseURL: resolvedUrl.replace(/\/chat\/completions$/, ""),
        apiKey: "not-needed",
        headers,
      });
      model = proxy(modelId);
    }

    const result = streamText({
      model,
      prompt: "Say 'ok' and nothing else.",
      maxOutputTokens: 10,
    });
    const text = await result.text;

    return NextResponse.json({ ok: true, response: text.trim() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[proxy settings] Test failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }
}
