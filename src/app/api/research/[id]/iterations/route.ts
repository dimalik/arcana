import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";

type Params = { params: Promise<{ id: string }> };

// POST — Start a new iteration
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;
    const body = await request.json();

    const project = await prisma.researchProject.findFirst({
      where: { id, userId },
      include: { iterations: { orderBy: { number: "desc" }, take: 1 } },
    });
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const lastIteration = project.iterations[0];
    const nextNumber = lastIteration ? lastIteration.number + 1 : 1;

    // Complete the current iteration if it's still active
    if (lastIteration && lastIteration.status === "ACTIVE") {
      await prisma.researchIteration.update({
        where: { id: lastIteration.id },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          reflection: body.reflection || null,
        },
      });
    }

    const iteration = await prisma.researchIteration.create({
      data: {
        projectId: id,
        number: nextNumber,
        goal: body.goal || `Iteration ${nextNumber}`,
      },
    });

    // Reset phase to literature or hypothesis depending on body
    await prisma.researchProject.update({
      where: { id },
      data: { currentPhase: body.startPhase || "literature" },
    });

    await prisma.researchLogEntry.create({
      data: {
        projectId: id,
        type: "decision",
        content: `Started iteration #${nextNumber}: ${iteration.goal}`,
      },
    });

    return NextResponse.json(iteration, { status: 201 });
  } catch (err) {
    console.error("[api/research/iterations] POST error:", err);
    return NextResponse.json({ error: "Failed to create iteration" }, { status: 500 });
  }
}

// PATCH — Complete/reflect on an iteration (using query param for iterId)
export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;
    const body = await request.json();
    const { iterationId, reflection, nextActions, status } = body as {
      iterationId: string;
      reflection?: string;
      nextActions?: string;
      status?: string;
    };

    if (!iterationId) {
      return NextResponse.json({ error: "iterationId is required" }, { status: 400 });
    }

    const project = await prisma.researchProject.findFirst({
      where: { id, userId },
    });
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const iteration = await prisma.researchIteration.update({
      where: { id: iterationId },
      data: {
        ...(status ? { status } : {}),
        ...(reflection ? { reflection } : {}),
        ...(nextActions ? { nextActions } : {}),
        ...(status === "COMPLETED" ? { completedAt: new Date() } : {}),
      },
    });

    return NextResponse.json(iteration);
  } catch (err) {
    console.error("[api/research/iterations] PATCH error:", err);
    return NextResponse.json({ error: "Failed to update iteration" }, { status: 500 });
  }
}
