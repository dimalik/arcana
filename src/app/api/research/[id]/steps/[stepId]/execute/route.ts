import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";
import { executeStep } from "@/lib/research/step-executor";

type Params = { params: Promise<{ id: string; stepId: string }> };

// POST — Execute an approved step
export async function POST(_request: NextRequest, { params }: Params) {
  try {
    const { id, stepId } = await params;

    // Allow internal calls (from autorun/auto-chain) to bypass auth
    const isInternal = _request.headers.get("x-internal-call") === "true";
    let userId: string;
    if (isInternal) {
      const proj = await prisma.researchProject.findUnique({
        where: { id },
        select: { userId: true },
      });
      if (!proj) {
        return NextResponse.json({ error: "Project not found" }, { status: 404 });
      }
      userId = proj.userId;
    } else {
      userId = await requireUserId();
    }

    const project = await prisma.researchProject.findFirst({
      where: { id, userId },
    });
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const step = await prisma.researchStep.findUnique({ where: { id: stepId } });
    if (!step) {
      return NextResponse.json({ error: "Step not found" }, { status: 404 });
    }
    if (step.status !== "APPROVED") {
      return NextResponse.json({ error: "Step must be approved before execution" }, { status: 400 });
    }

    // Execute — this returns immediately, work happens in background
    await executeStep(id, stepId, userId);

    return NextResponse.json({ status: "RUNNING" });
  } catch (err) {
    console.error("[api/research/steps/[stepId]/execute] POST error:", err);
    return NextResponse.json({ error: "Failed to execute step" }, { status: 500 });
  }
}
