import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateLLMResponse, truncateText } from "@/lib/llm/provider";
import {
  PAPER_INTERACTIVE_LLM_OPERATIONS,
  withPaperLlmContext,
} from "@/lib/llm/paper-llm-context";
import { buildPrompt } from "@/lib/llm/prompts";
import { resolveModelConfig } from "@/lib/llm/auto-process";
import { paperAccessErrorToResponse, requirePaperAccess } from "@/lib/paper-auth";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const access = await requirePaperAccess(id, { mode: "mutate" });
    if (!access) {
      return NextResponse.json({ error: "Paper not found" }, { status: 404 });
    }
    const body = await request.json();
    const { provider, modelId, proxyConfig } = await resolveModelConfig(body);
    const customPrompt = body.customPrompt;
    const paper = access.paper;

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
        userId: access.userId,
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
    const response = paperAccessErrorToResponse(error);
    if (response) return response;
    console.error("Code generation error:", error);
    return NextResponse.json(
      { error: "Failed to generate code" },
      { status: 500 }
    );
  }
}
