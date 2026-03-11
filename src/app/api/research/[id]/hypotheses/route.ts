import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";

type Params = { params: Promise<{ id: string }> };

// POST — Create a hypothesis
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;
    const body = await request.json();

    const project = await prisma.researchProject.findFirst({
      where: { id, userId },
    });
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const hypothesis = await prisma.researchHypothesis.create({
      data: {
        projectId: id,
        statement: body.statement,
        rationale: body.rationale || null,
        status: body.status || "PROPOSED",
        evidence: body.evidence ? JSON.stringify(body.evidence) : null,
        parentId: body.parentId || null,
      },
    });

    await prisma.researchLogEntry.create({
      data: {
        projectId: id,
        type: "decision",
        content: `Hypothesis ${body.parentId ? "revised" : "proposed"}: ${body.statement.slice(0, 100)}`,
        metadata: JSON.stringify({ hypothesisId: hypothesis.id }),
      },
    });

    return NextResponse.json(hypothesis, { status: 201 });
  } catch (err) {
    console.error("[api/research/hypotheses] POST error:", err);
    return NextResponse.json({ error: "Failed to create hypothesis" }, { status: 500 });
  }
}

// GET — List hypotheses
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;

    const project = await prisma.researchProject.findFirst({
      where: { id, userId },
    });
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const hypotheses = await prisma.researchHypothesis.findMany({
      where: { projectId: id },
      orderBy: { createdAt: "desc" },
      include: {
        parent: { select: { id: true, statement: true } },
        children: { select: { id: true, statement: true, status: true } },
      },
    });

    return NextResponse.json(hypotheses);
  } catch (err) {
    console.error("[api/research/hypotheses] GET error:", err);
    return NextResponse.json({ error: "Failed to fetch hypotheses" }, { status: 500 });
  }
}
