import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateLLMResponse, truncateText } from "@/lib/llm/provider";
import { buildPrompt, cleanJsonResponse } from "@/lib/llm/prompts";
import { resolveModelConfig } from "@/lib/llm/auto-process";
import { requireUserId } from "@/lib/paper-auth";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await requireUserId();
    const { id } = await params;
    const concepts = await prisma.concept.findMany({
      where: { paperId: id },
      orderBy: [{ depth: "asc" }, { createdAt: "asc" }],
    });

    return NextResponse.json(concepts);
  } catch (error) {
    console.error("Get concepts error:", error);
    return NextResponse.json(
      { error: "Failed to fetch concepts" },
      { status: 500 }
    );
  }
}

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
    const { system, prompt } = buildPrompt("concepts", truncated);

    const result = await generateLLMResponse({
      provider,
      modelId,
      system,
      prompt,
      proxyConfig,
    });

    // Save prompt result for audit
    await prisma.promptResult.create({
      data: {
        paperId: id,
        promptType: "concepts",
        prompt: "Generate key concepts",
        result,
        provider,
        model: modelId,
      },
    });

    // Parse concepts and create records
    const cleaned = cleanJsonResponse(result);
    const parsed = JSON.parse(cleaned) as Array<{
      name: string;
      explanation: string;
      prerequisites?: string[];
    }>;

    // Clear existing concepts first
    await prisma.concept.deleteMany({ where: { paperId: id } });

    const createdConcepts = [];
    for (const concept of parsed) {
      const parent = await prisma.concept.create({
        data: {
          paperId: id,
          name: concept.name,
          explanation: concept.explanation,
          depth: 0,
        },
      });

      // Create placeholder children from prerequisites
      if (concept.prerequisites && concept.prerequisites.length > 0) {
        for (const prereq of concept.prerequisites) {
          await prisma.concept.create({
            data: {
              paperId: id,
              name: prereq,
              explanation: "Click [+] to expand this concept.",
              parentId: parent.id,
              depth: 1,
            },
          });
        }
      }

      createdConcepts.push(parent);
    }

    // Return all concepts
    const allConcepts = await prisma.concept.findMany({
      where: { paperId: id },
      orderBy: [{ depth: "asc" }, { createdAt: "asc" }],
    });

    return NextResponse.json(allConcepts);
  } catch (error) {
    console.error("Generate concepts error:", error);
    return NextResponse.json(
      { error: "Failed to generate concepts" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    await prisma.concept.deleteMany({ where: { paperId: id } });
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Delete concepts error:", error);
    return NextResponse.json(
      { error: "Failed to delete concepts" },
      { status: 500 }
    );
  }
}
