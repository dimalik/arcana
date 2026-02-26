import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateLLMResponse, truncateText } from "@/lib/llm/provider";
import { buildPrompt, cleanJsonResponse } from "@/lib/llm/prompts";
import { resolveModelConfig } from "@/lib/llm/auto-process";
import { resolveAndAssignTags, getExistingTagNames } from "@/lib/tags/auto-tag";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { provider, modelId, proxyConfig } = await resolveModelConfig(body);
    const autoTag = body.autoTag ?? false;

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
    const existingTags = await getExistingTagNames();
    const { system, prompt } = buildPrompt("categorize", truncated, undefined, { existingTags });

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
        promptType: "categorize",
        prompt: "Categorize this paper",
        result,
        provider,
        model: modelId,
      },
    });

    // Auto-tag if requested (with fuzzy matching)
    if (autoTag) {
      try {
        const parsed = JSON.parse(cleanJsonResponse(result));
        const tagNames = (parsed.tags || []) as string[];
        await resolveAndAssignTags(id, tagNames);
      } catch {
        // JSON parsing failed
      }
    }

    return NextResponse.json(promptResult);
  } catch (error) {
    console.error("Categorize error:", error);
    return NextResponse.json(
      { error: "Failed to categorize" },
      { status: 500 }
    );
  }
}
