import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateLLMResponse } from "@/lib/llm/provider";
import { buildPrompt } from "@/lib/llm/prompts";
import { resolveModelConfig } from "@/lib/llm/auto-process";
import { parseSummarySections } from "@/lib/papers/parse-sections";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const body = await request.json();
    const { provider, modelId, proxyConfig } = await resolveModelConfig(body);
    const paperIds: string[] | undefined = body.paperIds;

    const paper = await prisma.paper.findUnique({
      where: { id },
      select: { id: true, title: true, abstract: true, summary: true, keyFindings: true },
    });

    if (!paper) {
      return NextResponse.json({ error: "Paper not found" }, { status: 404 });
    }

    // Use provided paperIds or fall back to related papers via PaperRelation
    let relatedPaperIds: string[];
    if (paperIds && paperIds.length > 0) {
      relatedPaperIds = paperIds.filter((pid) => pid !== id);
    } else {
      const relations = await prisma.paperRelation.findMany({
        where: { sourcePaperId: id, relationType: { not: "cites" } },
        orderBy: { confidence: "desc" },
        take: 8,
        select: { targetPaperId: true },
      });

      if (relations.length === 0) {
        return NextResponse.json(
          { error: "No related papers found. Run analysis first to link papers." },
          { status: 400 }
        );
      }
      relatedPaperIds = relations.map((r) => r.targetPaperId);
    }

    const relatedPapers = await prisma.paper.findMany({
      where: { id: { in: relatedPaperIds } },
      select: { id: true, title: true, abstract: true, summary: true, keyFindings: true },
    });

    if (relatedPapers.length === 0) {
      return NextResponse.json(
        { error: "No related papers found in library." },
        { status: 400 }
      );
    }

    // Build richer context — extract methodology sections from summaries
    const allPapers = [paper, ...relatedPapers];
    const papersContext = allPapers
      .map((p) => {
        const parts = [`id: ${p.id}`, `title: ${p.title}`];
        if (p.summary) {
          const sections = parseSummarySections(p.summary);
          // Include methodology section (richer than just abstract)
          if (sections.methodology) {
            parts.push(`methodology: ${sections.methodology.slice(0, 800)}`);
          }
          if (sections.results) {
            parts.push(`results: ${sections.results.slice(0, 500)}`);
          }
          if (!sections.methodology && !sections.results) {
            parts.push(`summary: ${p.summary.slice(0, 600)}`);
          }
        } else if (p.abstract) {
          parts.push(`abstract: ${p.abstract.slice(0, 400)}`);
        }
        if (p.keyFindings) parts.push(`keyFindings: ${p.keyFindings}`);
        return parts.join(" | ");
      })
      .join("\n\n");

    const comparePrompt = `PAPERS TO COMPARE:\n\n${papersContext}`;
    const { system } = buildPrompt("compareMethodologies", "");
    const result = await generateLLMResponse({
      provider,
      modelId,
      system,
      prompt: comparePrompt,
      maxTokens: 4000,
      proxyConfig,
    });

    const promptResult = await prisma.promptResult.create({
      data: {
        paperId: id,
        promptType: "compareMethodologies",
        prompt: "Compare methodologies",
        result,
        provider,
        model: modelId,
      },
    });

    return NextResponse.json(promptResult);
  } catch (error) {
    console.error("Methodology comparison error:", error);
    return NextResponse.json(
      { error: "Failed to compare methodologies" },
      { status: 500 }
    );
  }
}
