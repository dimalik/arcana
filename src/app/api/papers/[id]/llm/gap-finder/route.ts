import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateLLMResponse } from "@/lib/llm/provider";
import { buildPrompt } from "@/lib/llm/prompts";
import { resolveModelConfig } from "@/lib/llm/auto-process";
import { requireUserId } from "@/lib/paper-auth";
import { listProjectedTargetPaperIds } from "@/lib/assertions/relation-reader";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await requireUserId();
    const { id } = await params;
    const body = await request.json();
    const { provider, modelId, proxyConfig } = await resolveModelConfig(body);

    const paper = await prisma.paper.findFirst({
      where: { id, userId },
      select: { id: true, title: true, abstract: true, summary: true, keyFindings: true },
    });

    if (!paper) {
      return NextResponse.json({ error: "Paper not found" }, { status: 404 });
    }

    // Fetch related papers via PaperRelation (exclude "cites" relations, cap at 10)
    const relatedPaperIds = await listProjectedTargetPaperIds(
      id,
      { excludeRelationTypes: ["cites"], limit: 10 },
    );

    if (relatedPaperIds.length === 0) {
      return NextResponse.json(
        { error: "No related papers found. Run analysis first to link papers." },
        { status: 400 }
      );
    }
    const relatedPapers = await prisma.paper.findMany({
      where: { id: { in: relatedPaperIds } },
      select: { id: true, title: true, abstract: true, summary: true, keyFindings: true },
    });

    // Build prompt context
    const papersContext = [paper, ...relatedPapers].map((p) => {
      const parts = [`id: ${p.id}`, `title: ${p.title}`];
      if (p.abstract) parts.push(`abstract: ${p.abstract.slice(0, 300)}`);
      if (p.summary) parts.push(`summary: ${p.summary.slice(0, 500)}`);
      if (p.keyFindings) parts.push(`keyFindings: ${p.keyFindings}`);
      return parts.join(" | ");
    }).join("\n\n");

    const gapPrompt = `PAPERS IN TOPIC CLUSTER:\n\n${papersContext}`;
    const { system } = buildPrompt("findGaps", "");
    const result = await generateLLMResponse({ provider, modelId, system, prompt: gapPrompt, maxTokens: 3000, proxyConfig });

    const promptResult = await prisma.promptResult.create({
      data: {
        paperId: id,
        promptType: "findGaps",
        prompt: "Find research gaps",
        result,
        provider,
        model: modelId,
      },
    });

    return NextResponse.json(promptResult);
  } catch (error) {
    console.error("Gap finder error:", error);
    return NextResponse.json(
      { error: "Failed to find research gaps" },
      { status: 500 }
    );
  }
}
