import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateLLMResponse, truncateText } from "@/lib/llm/provider";
import { buildConceptExpandPrompt, cleanJsonResponse } from "@/lib/llm/prompts";
import { resolveModelConfig } from "@/lib/llm/auto-process";
import { trackEngagement } from "@/lib/engagement/track";
import { requireUserId } from "@/lib/paper-auth";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; conceptId: string }> }
) {
  try {
    const { id, conceptId } = await params;
    const body = await request.json();
    const { provider, modelId, proxyConfig } = await resolveModelConfig(body);

    const concept = await prisma.concept.findUnique({
      where: { id: conceptId },
    });

    if (!concept || concept.paperId !== id) {
      return NextResponse.json(
        { error: "Concept not found" },
        { status: 404 }
      );
    }

    const userId = await requireUserId();
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
    const { system, prompt } = buildConceptExpandPrompt(
      concept.name,
      truncated
    );

    const result = await generateLLMResponse({
      provider,
      modelId,
      system,
      prompt,
      proxyConfig,
    });

    // Parse sub-concepts
    const cleaned = cleanJsonResponse(result);
    const parsed = JSON.parse(cleaned) as Array<{
      name: string;
      explanation: string;
    }>;

    // Remove existing placeholder children
    await prisma.concept.deleteMany({
      where: { parentId: concept.id },
    });

    // Create real children
    for (const sub of parsed) {
      await prisma.concept.create({
        data: {
          paperId: id,
          name: sub.name,
          explanation: sub.explanation,
          parentId: concept.id,
          depth: concept.depth + 1,
        },
      });
    }

    // Mark parent as expanded
    await prisma.concept.update({
      where: { id: concept.id },
      data: { isExpanded: true },
    });

    trackEngagement(id, "concept_explore").catch(() => {});

    // Return all concepts for the paper
    const allConcepts = await prisma.concept.findMany({
      where: { paperId: id },
      orderBy: [{ depth: "asc" }, { createdAt: "asc" }],
    });

    return NextResponse.json(allConcepts);
  } catch (error) {
    console.error("Expand concept error:", error);
    return NextResponse.json(
      { error: "Failed to expand concept" },
      { status: 500 }
    );
  }
}
