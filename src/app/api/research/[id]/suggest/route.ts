import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";
import { suggestNextSteps } from "@/lib/research/orchestrator";

type Params = { params: Promise<{ id: string }> };

// POST — Get agent suggestions for current phase
export async function POST(_request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;

    const project = await prisma.researchProject.findFirst({
      where: { id, userId },
    });
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const suggestions = await suggestNextSteps(id);

    return NextResponse.json({ suggestions });
  } catch (err) {
    console.error("[api/research/suggest] POST error:", err);
    return NextResponse.json({ error: "Failed to generate suggestions" }, { status: 500 });
  }
}
