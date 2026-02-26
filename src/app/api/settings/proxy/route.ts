import { NextRequest, NextResponse } from "next/server";
import { getProxyConfig, saveProxyConfig, VENDOR_PRESETS, type ProxyVendor } from "@/lib/llm/proxy-settings";
import { createOpenAI } from "@ai-sdk/openai";
import { generateText } from "ai";

/**
 * GET — return proxy config with API key masked.
 */
export async function GET() {
  const config = await getProxyConfig();

  return NextResponse.json({
    enabled: config.enabled,
    vendor: config.vendor,
    baseUrl: config.baseUrl,
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
      enabled: Boolean(body.enabled),
      vendor,
      baseUrl: body.baseUrl || "",
      apiKey: body.apiKey ?? null, // null = keep existing
      headerName: body.headerName || "Authorization",
      headerValue: body.headerValue || "",
      modelId: body.modelId || "",
      contextWindow: parseInt(body.contextWindow, 10) || 128000,
      maxTokens: parseInt(body.maxTokens, 10) || 4096,
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("[proxy settings] PUT error:", e);
    return NextResponse.json({ error: "Failed to save proxy config" }, { status: 500 });
  }
}

/**
 * POST — test proxy connectivity with a minimal LLM call.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const baseUrl = body.baseUrl;
    const headerName = body.headerName || "Authorization";
    const headerValue = body.headerValue || "";
    const modelId = body.modelId || "gpt-3.5-turbo";

    if (!baseUrl) {
      return NextResponse.json({ error: "Base URL is required" }, { status: 400 });
    }
    if (!headerValue) {
      return NextResponse.json({ error: "Header value / API key is required" }, { status: 400 });
    }

    const proxy = createOpenAI({
      baseURL: baseUrl.replace(/\/chat\/completions$/, ""),
      apiKey: "not-needed",
      headers: {
        [headerName]: headerValue,
      },
    });

    const { text } = await generateText({
      model: proxy(modelId),
      prompt: "Say 'ok' and nothing else.",
      maxOutputTokens: 10,
    });

    return NextResponse.json({ ok: true, response: text.trim() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error("[proxy settings] Test failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 400 });
  }
}
