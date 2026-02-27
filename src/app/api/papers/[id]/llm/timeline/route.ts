import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateLLMResponse } from "@/lib/llm/provider";
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

    const paper = await prisma.paper.findUnique({
      where: { id },
      select: { id: true, title: true, abstract: true, summary: true, keyFindings: true, year: true },
    });

    if (!paper) {
      return NextResponse.json({ error: "Paper not found" }, { status: 404 });
    }

    // Fetch related papers via PaperRelation (exclude "cites" relations, cap at 10)
    const relations = await prisma.paperRelation.findMany({
      where: { sourcePaperId: id, relationType: { not: "cites" } },
      orderBy: { confidence: "desc" },
      take: 10,
      select: { targetPaperId: true },
    });

    if (relations.length === 0) {
      return NextResponse.json(
        { error: "No related papers found. Run analysis first to link papers." },
        { status: 400 }
      );
    }

    const relatedPaperIds = relations.map((r) => r.targetPaperId);
    const relatedPapers = await prisma.paper.findMany({
      where: { id: { in: relatedPaperIds } },
      select: { id: true, title: true, abstract: true, summary: true, keyFindings: true, year: true },
    });

    // Order chronologically for the timeline prompt
    const allPapers = [paper, ...relatedPapers].sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999));

    const papersContext = allPapers.map((p) => {
      const parts = [`id: ${p.id}`, `title: ${p.title}`];
      if (p.year) parts.push(`year: ${p.year}`);
      if (p.abstract) parts.push(`abstract: ${p.abstract.slice(0, 300)}`);
      if (p.summary) parts.push(`summary: ${p.summary.slice(0, 500)}`);
      if (p.keyFindings) parts.push(`keyFindings: ${p.keyFindings}`);
      return parts.join(" | ");
    }).join("\n\n");

    const timelinePrompt = `PAPERS (chronological order):\n\n${papersContext}`;
    const { system } = buildPrompt("buildTimeline", "");
    const result = await generateLLMResponse({ provider, modelId, system, prompt: timelinePrompt, maxTokens: 3000, proxyConfig });

    const promptResult = await prisma.promptResult.create({
      data: {
        paperId: id,
        promptType: "buildTimeline",
        prompt: "Build idea timeline",
        result,
        provider,
        model: modelId,
      },
    });

    return NextResponse.json(promptResult);
  } catch (error) {
    console.error("Timeline builder error:", error);
    return NextResponse.json(
      { error: "Failed to build timeline" },
      { status: 500 }
    );
  }
}
