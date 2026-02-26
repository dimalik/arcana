import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateLLMResponse, truncateText } from "@/lib/llm/provider";
import { buildPrompt } from "@/lib/llm/prompts";
import { resolveModelConfig } from "@/lib/llm/auto-process";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { provider, modelId, proxyConfig } = await resolveModelConfig(body);
    const customPrompt = body.customPrompt;

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
    const { system, prompt } = buildPrompt("code", truncated, customPrompt);

    const result = await generateLLMResponse({
      provider,
      modelId,
      system,
      prompt,
      proxyConfig,
    });

    const promptResult = await prisma.promptResult.create({
      data: {
        paperId: id,
        promptType: "code",
        prompt: customPrompt || "Generate code from paper",
        result,
        provider,
        model: modelId,
      },
    });

    return NextResponse.json(promptResult);
  } catch (error) {
    console.error("Code generation error:", error);
    return NextResponse.json(
      { error: "Failed to generate code" },
      { status: 500 }
    );
  }
}
