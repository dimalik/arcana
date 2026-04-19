import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateLLMResponse, truncateText } from "@/lib/llm/provider";
import {
  PAPER_INTERACTIVE_LLM_OPERATIONS,
  withPaperLlmContext,
} from "@/lib/llm/paper-llm-context";
import { buildPrompt } from "@/lib/llm/prompts";
import { resolveModelConfig } from "@/lib/llm/auto-process";
import { requireUserId } from "@/lib/paper-auth";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await requireUserId();
    const { id } = await params;
    const body = await request.json();
    const { provider, modelId, proxyConfig } = await resolveModelConfig(body);
    const customPrompt = body.customPrompt;

    const paper = await prisma.paper.findFirst({
      where: { id, userId },
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

    const result = await withPaperLlmContext(
      {
        operation: PAPER_INTERACTIVE_LLM_OPERATIONS.CODE,
        paperId: id,
        userId,
        runtime: "interactive",
        source: "papers.llm.code",
      },
      () =>
        generateLLMResponse({
          provider,
          modelId,
          system,
          prompt,
          proxyConfig,
        }),
    );

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
