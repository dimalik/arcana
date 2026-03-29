import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";
import { cleanupStaleJobs } from "@/lib/research/remote-executor";

type Params = { params: Promise<{ id: string }> };

// GET — Full project with iterations, hypotheses, recent log
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;

    // Auto-cleanup stale remote jobs for this project (non-blocking)
    cleanupStaleJobs(id).catch((err) =>
      console.warn("[research/[id]] stale cleanup error:", err)
    );

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
        approaches: {
          include: {
            results: { select: { id: true, verdict: true, metrics: true } },
            children: { include: { results: { select: { id: true, verdict: true, metrics: true } } } },
          },
          orderBy: { createdAt: "asc" },
        },
        experimentResults: {
          include: {
            branch: { select: { name: true, status: true } },
          },
          orderBy: { createdAt: "asc" },
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

    // Compute phase gate status (must match checkPhaseGate in agent.ts)
    const gates: Record<string, { met: boolean; progress: string }> = {};
    const paperCount = project.collection?.papers?.length || 0;
    const scoutCount = await prisma.agentTask.count({ where: { projectId: id, role: "scout" } });
    const synthCount = await prisma.agentTask.count({ where: { projectId: id, role: "synthesizer", status: "COMPLETED" } });
    gates["hypothesis"] = {
      met: (paperCount >= 3 || scoutCount > 0) && synthCount > 0,
      progress: `${paperCount}/3 papers, ${synthCount} syntheses`,
    };

    const hypCount = project.hypotheses?.length || 0;
    const architectCount = await prisma.agentTask.count({ where: { projectId: id, role: "architect", status: "COMPLETED" } });
    const mechDesignCount = await prisma.researchLogEntry.count({ where: { projectId: id, type: "decision", content: { contains: "echanism" } } });
    gates["experiment"] = {
      met: hypCount > 0 && architectCount > 0 && mechDesignCount > 0,
      progress: `${hypCount} hypotheses, ${architectCount} architect, ${mechDesignCount} mechanism design`,
    };

    const completedJobs = await prisma.remoteJob.count({ where: { projectId: id, status: "COMPLETED" } });
    const reviewCount = await prisma.agentTask.count({ where: { projectId: id, role: "reviewer", status: "COMPLETED" } });
    const critiqueCount = await prisma.researchStep.count({ where: { iteration: { projectId: id }, type: "critique", status: "COMPLETED" } });
    gates["analysis"] = {
      met: completedJobs > 0 && (reviewCount > 0 || critiqueCount > 0),
      progress: `${completedJobs} experiments, ${reviewCount + critiqueCount} reviews`,
    };

    const evidenceHyps = project.hypotheses?.filter((h: { evidence: string | null }) => h.evidence)?.length || 0;
    gates["reflection"] = { met: evidenceHyps > 0, progress: `${evidenceHyps} hypotheses with evidence` };

    // Check if this is a benchmark project (separate query — log take:50 may not include oldest entries)
    const benchmarkLogs = await prisma.researchLogEntry.findMany({
      where: { projectId: id, metadata: { contains: "benchmarkPaperId" } },
      select: { content: true, metadata: true },
      take: 2,
    });
    const benchmarkLog = benchmarkLogs.find((l) => {
      try { return JSON.parse(l.metadata!).benchmarkPaperId && !JSON.parse(l.metadata!).groundTruth; } catch { return false; }
    });
    const groundTruthLog = benchmarkLogs.find((l) => {
      try { return JSON.parse(l.metadata!).groundTruth === true; } catch { return false; }
    });

    const benchmark = benchmarkLog ? {
      isBenchmark: true,
      sourcePaperId: (() => { try { return JSON.parse(benchmarkLog.metadata!).benchmarkPaperId; } catch { return null; } })(),
      groundTruth: groundTruthLog ? groundTruthLog.content.replace("[GROUND TRUTH — HIDDEN FROM AGENT]\n", "") : null,
    } : null;

    // Fetch experiment jobs with host info for experiment cards
    const experimentJobs = await prisma.remoteJob.findMany({
      where: { projectId: id },
      include: { host: { select: { alias: true, gpuType: true } } },
      orderBy: { createdAt: "desc" },
      take: 100,
    });

    // Fetch hypotheses by ID for quick lookup in experiment cards
    const hypothesesById: Record<string, string> = {};
    for (const h of project.hypotheses) {
      hypothesesById[h.id] = h.statement;
    }

    return NextResponse.json({ ...project, benchmark, gates, experimentJobs, hypothesesById });
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
