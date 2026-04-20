import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateLLMResponse, truncateText } from "@/lib/llm/provider";
import {
  PAPER_INTERACTIVE_LLM_OPERATIONS,
  withPaperLlmContext,
} from "@/lib/llm/paper-llm-context";
import { buildPrompt, cleanJsonResponse } from "@/lib/llm/prompts";
import { resolveModelConfig } from "@/lib/llm/auto-process";
import { paperAccessErrorToResponse, requirePaperAccess } from "@/lib/paper-auth";
import {
  serializePaperAuthors,
  updatePaperWithAuthorIndex,
} from "@/lib/papers/authors";

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
    const body = await request.json().catch(() => ({}));
    const { provider, modelId, proxyConfig } = await resolveModelConfig(body);
    const paper = access.paper;

    const text = paper.fullText || paper.abstract || "";
    if (!text) {
      return NextResponse.json(
        { error: "No text available" },
        { status: 400 }
      );
    }

    const truncated = truncateText(text, modelId, proxyConfig);
    const { system, prompt } = buildPrompt("extract", truncated);

    const result = await withPaperLlmContext(
      {
        operation: PAPER_INTERACTIVE_LLM_OPERATIONS.EXTRACT,
        paperId: id,
        userId: access.userId,
        runtime: "interactive",
        source: "papers.llm.extract",
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
        promptType: "extract",
        prompt: "Extract key information",
        result,
        provider,
        model: modelId,
      },
    });

    // Try to parse and update paper metadata
    try {
      const parsed = JSON.parse(cleanJsonResponse(result));
      const updateData: Record<string, unknown> = {};
      if (parsed.title) updateData.title = parsed.title;
      if (parsed.authors) updateData.authors = serializePaperAuthors(parsed.authors);
      if (parsed.year) updateData.year = parsed.year;
      if (parsed.venue) updateData.venue = parsed.venue;
      if (parsed.abstract) updateData.abstract = parsed.abstract;
      if (parsed.keyFindings)
        updateData.keyFindings = JSON.stringify(parsed.keyFindings);

      if (Object.keys(updateData).length > 0) {
        await updatePaperWithAuthorIndex({
          where: { id },
          data: updateData,
        });
      }
    } catch {
      // JSON parsing failed, that's ok - we still have the raw result
    }

    return NextResponse.json(promptResult);
  } catch (error) {
    const response = paperAccessErrorToResponse(error);
    if (response) return response;
    console.error("Extract error:", error);
    return NextResponse.json(
      { error: "Failed to extract info" },
      { status: 500 }
    );
  }
}
