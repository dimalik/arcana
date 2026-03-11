import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";

type Params = { params: Promise<{ id: string }> };

// POST — Create a step (proposed by agent or user)
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;
    const body = await request.json();

    const project = await prisma.researchProject.findFirst({
      where: { id, userId },
      include: { iterations: { where: { status: "ACTIVE" }, take: 1 } },
    });
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const activeIteration = project.iterations[0];
    if (!activeIteration) {
      return NextResponse.json({ error: "No active iteration" }, { status: 400 });
    }

    const step = await prisma.researchStep.create({
      data: {
        iterationId: activeIteration.id,
        type: body.type,
        title: body.title,
        description: body.description || null,
        input: body.input ? JSON.stringify(body.input) : null,
        status: body.status || "PROPOSED",
        sortOrder: body.sortOrder || 0,
      },
    });

    return NextResponse.json(step, { status: 201 });
  } catch (err) {
    console.error("[api/research/steps] POST error:", err);
    return NextResponse.json({ error: "Failed to create step" }, { status: 500 });
  }
}
