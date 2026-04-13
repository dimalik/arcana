import { NextRequest, NextResponse } from "next/server";
import { requireUserId } from "@/lib/paper-auth";
import { prisma } from "@/lib/prisma";
import { getProjectTraceAudit } from "@/lib/research/trace-audit";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const limitParam = Number(searchParams.get("limit") || "200");
    const limit = Number.isFinite(limitParam) ? limitParam : 200;
    const runId = searchParams.get("runId");

    const project = await prisma.researchProject.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const audit = await getProjectTraceAudit({ projectId: id, runId, limit });
    return NextResponse.json(audit);
  } catch (err) {
    console.error("[api/research/trace] GET error:", err);
    return NextResponse.json({ error: "Failed to fetch agent trace" }, { status: 500 });
  }
}
