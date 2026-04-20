import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveModelConfig } from "@/lib/llm/auto-process";
import { paperAccessErrorToResponse, requirePaperAccess } from "@/lib/paper-auth";
import { runCrossPaperAnalysisCapability } from "@/lib/papers/analysis";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const access = await requirePaperAccess(id, {
      mode: "mutate",
      select: { id: true },
    });
    if (!access) {
      return NextResponse.json({ error: "Paper not found" }, { status: 404 });
    }
    const body = await request.json();
    const { provider, modelId, proxyConfig } = await resolveModelConfig(body);
    const parsed = await runCrossPaperAnalysisCapability({
      capability: "gaps",
      paperId: id,
      provider,
      modelId,
      proxyConfig,
      userId: access.userId,
    });

    const promptResult = await prisma.promptResult.create({
      data: {
        paperId: id,
        promptType: "findGaps",
        prompt: "Find research gaps",
        result: JSON.stringify(parsed),
        provider,
        model: modelId,
      },
    });

    return NextResponse.json(promptResult);
  } catch (error) {
    const response = paperAccessErrorToResponse(error);
    if (response) return response;
    if (error instanceof Error && error.message.includes("No related papers found")) {
      return NextResponse.json({ error: error.message }, { status: 400 });
    }
    console.error("Gap finder error:", error);
    return NextResponse.json(
      { error: "Failed to find research gaps" },
      { status: 500 }
    );
  }
}
