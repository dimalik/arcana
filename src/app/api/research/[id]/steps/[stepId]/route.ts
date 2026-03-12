import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";

type Params = { params: Promise<{ id: string; stepId: string }> };

// PATCH — Approve/skip/complete a step
export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id, stepId } = await params;
    const body = await request.json();

    const project = await prisma.researchProject.findFirst({
      where: { id, userId },
    });
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const data: Record<string, unknown> = {};
    if (body.status) data.status = body.status;
    if (body.output !== undefined) data.output = typeof body.output === "string" ? body.output : JSON.stringify(body.output);
    if (body.input !== undefined) data.input = typeof body.input === "string" ? body.input : JSON.stringify(body.input);
    if (body.agentSessionId !== undefined) data.agentSessionId = body.agentSessionId;
    if (body.discoveryId !== undefined) data.discoveryId = body.discoveryId;
    if (body.synthesisId !== undefined) data.synthesisId = body.synthesisId;
    if (body.status === "COMPLETED" || body.status === "FAILED") {
      data.completedAt = new Date();
    }

    const step = await prisma.researchStep.update({
      where: { id: stepId },
      data,
    });

    // Log step completion
    if (body.status === "COMPLETED") {
      await prisma.researchLogEntry.create({
        data: {
          projectId: id,
          type: "decision",
          content: `Step completed: ${step.title}`,
        },
      });
    }

    return NextResponse.json(step);
  } catch (err) {
    console.error("[api/research/steps/[stepId]] PATCH error:", err);
    return NextResponse.json({ error: "Failed to update step" }, { status: 500 });
  }
}
