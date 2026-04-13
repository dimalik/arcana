import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";
import { syncClaimCoordinator } from "@/lib/research/claim-coordinator";
import { getProjectLineage } from "@/lib/research/lineage-audit";
import { ensureProjectMaintenance } from "@/lib/research/project-maintenance";

type Params = { params: Promise<{ id: string }> };

async function requireProject(projectId: string, userId: string) {
  const project = await prisma.researchProject.findFirst({
    where: { id: projectId, userId },
    select: { id: true },
  });
  if (!project) throw new Error("Project not found");
}

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id: projectId } = await params;
    await requireProject(projectId, userId);
    await ensureProjectMaintenance(projectId);
    await syncClaimCoordinator(projectId, { autoDispatch: false, launchTaskRunner: false });
    const lineage = await getProjectLineage(projectId);
    return NextResponse.json(lineage);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch lineage";
    const status = message === "Project not found" ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
