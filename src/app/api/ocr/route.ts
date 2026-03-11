import { NextRequest, NextResponse } from "next/server";
import { generateLLMResponse } from "@/lib/llm/provider";
import { resolveModelConfig } from "@/lib/llm/auto-process";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { image } = body;

    if (!image || typeof image !== "string") {
      return NextResponse.json(
        { error: "Missing required 'image' field (base64 data URL)" },
        { status: 400 }
      );
    }

    const { provider, modelId, proxyConfig } = await resolveModelConfig({});

    const text = await generateLLMResponse({
      provider,
      modelId,
      system:
        "You are an OCR assistant. Extract all readable text from the provided image. " +
        "Return ONLY the extracted text, preserving the original reading order. " +
        "Do not add any commentary, headers, or formatting beyond what appears in the image.",
      prompt: `[Image attached as base64]\n\nPlease extract all text visible in this image:\n\n<image>${image}</image>`,
      maxTokens: 2000,
      proxyConfig,
    });

    return NextResponse.json({ text: text.trim() });
  } catch (error) {
    console.error("[ocr] Error:", error);
    return NextResponse.json(
      { error: "OCR failed" },
      { status: 500 }
    );
  }
}
