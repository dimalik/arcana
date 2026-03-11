import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";
import { generateLLMResponse, setLlmContext } from "@/lib/llm/provider";
import { getDefaultModel } from "@/lib/llm/auto-process";

type Params = { params: Promise<{ id: string }> };

// POST — LLM refines the research question
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;
    const body = await request.json();
    const { question, domains } = body as { question: string; domains?: string[] };

    if (!question?.trim()) {
      return NextResponse.json({ error: "Question is required" }, { status: 400 });
    }

    // Allow refining without an existing project (during wizard)
    if (id !== "new") {
      const project = await prisma.researchProject.findFirst({
        where: { id, userId },
      });
      if (!project) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
      }
    }

    const { provider, modelId, proxyConfig } = await getDefaultModel();
    setLlmContext("research-refine-brief", userId);

    const result = await generateLLMResponse({
      provider,
      modelId,
      proxyConfig,
      system: `You are a research methodology expert. Help refine research questions into well-structured research briefs. Respond in JSON format only.`,
      prompt: `Given this research question:
"${question.trim()}"
${domains?.length ? `\nDomains: ${domains.join(", ")}` : ""}

Generate a refined research brief with:
1. A clearer, more specific version of the main question
2. 3-5 sub-questions that break down the investigation
3. Suggested keywords for literature search (5-10)
4. Recommended methodology type (one of: experimental, analytical, survey, design_science, exploratory)

Respond as JSON:
{
  "refinedQuestion": "...",
  "subQuestions": ["...", "..."],
  "keywords": ["...", "..."],
  "methodology": "...",
  "reasoning": "Brief explanation of why this structure helps"
}`,
      maxTokens: 1000,
    });

    // Parse JSON from response
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return NextResponse.json({ error: "Failed to parse LLM response" }, { status: 500 });
    }

    const refinement = JSON.parse(jsonMatch[0]);
    return NextResponse.json(refinement);
  } catch (err) {
    console.error("[api/research/refine-brief] POST error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to refine brief" },
      { status: 500 }
    );
  }
}
