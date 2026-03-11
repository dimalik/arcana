import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";

type Params = { params: Promise<{ id: string; hId: string }> };

// PATCH — Update hypothesis status/evidence
export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id, hId } = await params;
    const body = await request.json();

    const project = await prisma.researchProject.findFirst({
      where: { id, userId },
    });
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const data: Record<string, unknown> = {};
    if (body.statement !== undefined) data.statement = body.statement;
    if (body.rationale !== undefined) data.rationale = body.rationale;
    if (body.status !== undefined) data.status = body.status;
    if (body.evidence !== undefined) data.evidence = typeof body.evidence === "string" ? body.evidence : JSON.stringify(body.evidence);

    const hypothesis = await prisma.researchHypothesis.update({
      where: { id: hId },
      data,
    });

    if (body.status) {
      await prisma.researchLogEntry.create({
        data: {
          projectId: id,
          type: "decision",
          content: `Hypothesis status → ${body.status}: ${hypothesis.statement.slice(0, 80)}`,
          metadata: JSON.stringify({ hypothesisId: hId }),
        },
      });
    }

    return NextResponse.json(hypothesis);
  } catch (err) {
    console.error("[api/research/hypotheses/[hId]] PATCH error:", err);
    return NextResponse.json({ error: "Failed to update hypothesis" }, { status: 500 });
  }
}
