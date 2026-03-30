import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * GET — Return all artifacts of type "figure" for a project, linked to experiments.
 * Triggers background captioning for any new uncaptioned figures.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;

    const project = await prisma.researchProject.findFirst({
      where: { id, userId },
      select: { id: true, outputFolder: true },
    });
    if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // Return figure artifacts with their linked experiment
    const figures = await prisma.artifact.findMany({
      where: { projectId: id, type: "figure" },
      include: { result: { select: { id: true, scriptName: true, verdict: true } } },
      orderBy: { createdAt: "desc" },
    });

    // Trigger background captioning for new figures (non-blocking)
    if (project.outputFolder) {
      import("@/lib/research/figure-captioner").then(({ captionNewFigures }) => {
        captionNewFigures(id, project.outputFolder!).catch(() => {});
      }).catch(() => {});
    }

    return NextResponse.json({ figures });
  } catch (err) {
    console.error("[figures] GET error:", err);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
