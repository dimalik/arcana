import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";
import {
  attachClaimEvidence,
  createClaim,
  getClaimLedger,
  promoteClaimToMemory,
  reviewClaim,
  transitionClaimMemory,
  type ClaimEvidenceInput,
} from "@/lib/research/claim-ledger";
import { listClaimCoordinatorQueue, syncClaimCoordinator } from "@/lib/research/claim-coordinator";
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
    const claims = await getClaimLedger(projectId);
    const queue = await listClaimCoordinatorQueue(projectId, { activeOnly: true });
    return NextResponse.json({ claims, queue });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch claims";
    const status = message === "Project not found" ? 404 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function POST(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id: projectId } = await params;
    await requireProject(projectId, userId);
    const body = await request.json();

    const claimId = await createClaim({
      projectId,
      statement: body.statement,
      summary: body.summary,
      type: body.type || "finding",
      status: body.status,
      confidence: body.confidence,
      createdBy: body.createdBy || "user",
      createdFrom: body.createdFrom || "claims_api",
      notes: body.notes,
      hypothesisId: body.hypothesisId,
      resultId: body.resultId,
      taskId: body.taskId,
      evidence: Array.isArray(body.evidence) ? body.evidence : [],
    });
    await syncClaimCoordinator(projectId, { autoDispatch: true });

    return NextResponse.json({ id: claimId }, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create claim";
    const status = message === "Project not found" ? 404 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id: projectId } = await params;
    await requireProject(projectId, userId);
    const body = await request.json();

    if (!body.id) {
      return NextResponse.json({ error: "id is required" }, { status: 400 });
    }

    const claim = await prisma.researchClaim.findFirst({
      where: { id: body.id, projectId },
      select: { id: true },
    });
    if (!claim) {
      return NextResponse.json({ error: "Claim not found" }, { status: 404 });
    }

    if (body.evidence && !body.status) {
      const evidenceRows = Array.isArray(body.evidence) ? body.evidence : [body.evidence];
      const created = await Promise.all(
        evidenceRows.map((evidence: ClaimEvidenceInput) => attachClaimEvidence(body.id, evidence)),
      );
      await syncClaimCoordinator(projectId, { autoDispatch: true });
      return NextResponse.json({ ok: true, evidence: created });
    }

    if (body.action === "promote") {
      const memory = await promoteClaimToMemory({
        claimId: body.id,
        userId,
        category: body.category || "general",
        lesson: body.lesson,
        context: body.context,
        projectId,
      });
      await syncClaimCoordinator(projectId, { autoDispatch: true });
      return NextResponse.json({ ok: true, memory });
    }

    if (body.action === "memory_status") {
      if (!body.memoryId || !body.memoryStatus) {
        return NextResponse.json({ error: "memoryId and memoryStatus are required" }, { status: 400 });
      }
      const memory = await transitionClaimMemory({
        memoryId: body.memoryId,
        userId,
        status: body.memoryStatus,
      });
      await syncClaimCoordinator(projectId, { autoDispatch: true });
      return NextResponse.json({ ok: true, memory });
    }

    const updated = await reviewClaim({
      claimId: body.id,
      status: body.status,
      confidence: body.confidence,
      notes: body.notes,
      createdBy: body.createdBy || "user",
      taskId: body.taskId,
      metadata: body.metadata,
      evidence: Array.isArray(body.evidence) ? body.evidence : undefined,
    });
    await syncClaimCoordinator(projectId, { autoDispatch: true });
    return NextResponse.json(updated);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to update claim";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
