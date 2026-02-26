import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateLLMResponse, truncateText } from "@/lib/llm/provider";
import { SYSTEM_PROMPTS } from "@/lib/llm/prompts";
import { resolveModelConfig } from "@/lib/llm/auto-process";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { provider, modelId, proxyConfig } = await resolveModelConfig(body);
    const userPrompt = body.prompt;

    if (!userPrompt) {
      return NextResponse.json(
        { error: "prompt is required" },
        { status: 400 }
      );
    }

    const paper = await prisma.paper.findUnique({
      where: { id },
    });

    if (!paper) {
      return NextResponse.json({ error: "Paper not found" }, { status: 404 });
    }

    const text = paper.fullText || paper.abstract || "";
    if (!text) {
      return NextResponse.json(
        { error: "No text available" },
        { status: 400 }
      );
    }

    const truncated = truncateText(text, modelId, proxyConfig);

    const result = await generateLLMResponse({
      provider,
      modelId,
      system: SYSTEM_PROMPTS.custom,
      prompt: `Here is the paper text:\n\n${truncated}\n\n---\n\nUser request: ${userPrompt}`,
      proxyConfig,
    });

    const promptResult = await prisma.promptResult.create({
      data: {
        paperId: id,
        promptType: "custom",
        prompt: userPrompt,
        result,
        provider,
        model: modelId,
      },
    });

    return NextResponse.json(promptResult);
  } catch (error) {
    console.error("Custom prompt error:", error);
    return NextResponse.json(
      { error: "Failed to process custom prompt" },
      { status: 500 }
    );
  }
}
