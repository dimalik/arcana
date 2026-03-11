import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";

type Params = { params: Promise<{ id: string }> };

// GET — Full project with iterations, hypotheses, recent log
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;

    const project = await prisma.researchProject.findFirst({
      where: { id, userId },
      include: {
        iterations: {
          orderBy: { number: "desc" },
          include: {
            steps: { orderBy: { sortOrder: "asc" } },
          },
        },
        hypotheses: {
          orderBy: { createdAt: "desc" },
          include: { parent: { select: { id: true, statement: true } } },
        },
        log: {
          orderBy: { createdAt: "desc" },
          take: 50,
        },
        collection: {
          include: {
            papers: {
              include: {
                paper: {
                  select: {
                    id: true,
                    title: true,
                    authors: true,
                    year: true,
                    summary: true,
                    abstract: true,
                    processingStatus: true,
                  },
                },
              },
            },
          },
        },
      },
    });

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    return NextResponse.json(project);
  } catch (err) {
    console.error("[api/research/[id]] GET error:", err);
    return NextResponse.json({ error: "Failed to fetch project" }, { status: 500 });
  }
}

// PATCH — Update project (phase, status, brief, title)
export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;
    const body = await request.json();

    const existing = await prisma.researchProject.findFirst({
      where: { id, userId },
    });
    if (!existing) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const data: Record<string, unknown> = {};
    if (body.title !== undefined) data.title = body.title;
    if (body.brief !== undefined) data.brief = typeof body.brief === "string" ? body.brief : JSON.stringify(body.brief);
    if (body.status !== undefined) data.status = body.status;
    if (body.currentPhase !== undefined) data.currentPhase = body.currentPhase;
    if (body.methodology !== undefined) data.methodology = body.methodology;
    if (body.outputFolder !== undefined) data.outputFolder = body.outputFolder;

    // Log phase transitions
    if (body.currentPhase && body.currentPhase !== existing.currentPhase) {
      await prisma.researchLogEntry.create({
        data: {
          projectId: id,
          type: "decision",
          content: `Phase changed: ${existing.currentPhase} → ${body.currentPhase}`,
        },
      });
    }

    const project = await prisma.researchProject.update({
      where: { id },
      data,
    });

    return NextResponse.json(project);
  } catch (err) {
    console.error("[api/research/[id]] PATCH error:", err);
    return NextResponse.json({ error: "Failed to update project" }, { status: 500 });
  }
}

// DELETE — Archive project
export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;

    const existing = await prisma.researchProject.findFirst({
      where: { id, userId },
    });
    if (!existing) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    await prisma.researchProject.update({
      where: { id },
      data: { status: "ARCHIVED" },
    });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[api/research/[id]] DELETE error:", err);
    return NextResponse.json({ error: "Failed to archive project" }, { status: 500 });
  }
}
