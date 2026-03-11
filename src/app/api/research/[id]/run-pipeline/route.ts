import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";
import { executeStep } from "@/lib/research/step-executor";

type Params = { params: Promise<{ id: string }> };

/**
 * POST — Run the full research pipeline autonomously.
 *
 * This is the "Start" button: it creates and executes all steps needed
 * for a complete research cycle. Steps execute sequentially via auto-chain.
 */
export async function POST(_request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;

    const project = await prisma.researchProject.findFirst({
      where: { id, userId },
      include: {
        iterations: { where: { status: "ACTIVE" }, take: 1 },
        collection: {
          include: { papers: { select: { paperId: true }, take: 1 } },
        },
        hypotheses: { select: { id: true } },
      },
    });
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const activeIteration = project.iterations[0];
    if (!activeIteration) {
      return NextResponse.json({ error: "No active iteration" }, { status: 400 });
    }

    // Check no steps are already running
    const existingActive = await prisma.researchStep.findFirst({
      where: {
        iterationId: activeIteration.id,
        status: { in: ["RUNNING", "APPROVED"] },
      },
    });
    if (existingActive) {
      return NextResponse.json({
        status: "already_running",
        message: "Pipeline is already running",
      });
    }

    // Determine what steps we need based on current state
    const hasPapers = (project.collection?.papers.length || 0) > 0;
    const hasHypotheses = project.hypotheses.length > 0;

    const steps: { type: string; title: string; description: string; sortOrder: number }[] = [];
    let order = 0;

    // 1. Find papers — search by topic if none exist, discover via citations if we have seeds
    if (!hasPapers) {
      steps.push({
        type: "search_papers",
        title: "Find key papers",
        description: "Searching academic databases for foundational papers on this topic",
        sortOrder: order++,
      });
    }

    // 2. Cross-paper analysis
    steps.push({
      type: "synthesize",
      title: "Analyze literature",
      description: "Cross-paper analysis to identify themes, gaps, and contradictions",
      sortOrder: order++,
    });

    // 3. Generate hypotheses
    if (!hasHypotheses) {
      steps.push({
        type: "critique",
        title: "Generate hypotheses",
        description: "Propose testable hypotheses based on literature gaps",
        sortOrder: order++,
      });
    }

    // 4. Generate experiment code
    steps.push({
      type: "generate_code",
      title: "Design experiment",
      description: "Generate experiment code to test the hypotheses",
      sortOrder: order++,
    });

    // Create first step as APPROVED (executed immediately), rest as PROPOSED (user reviews + continues)
    const createdSteps = [];
    for (let i = 0; i < steps.length; i++) {
      const step = await prisma.researchStep.create({
        data: {
          iterationId: activeIteration.id,
          ...steps[i],
          status: i === 0 ? "APPROVED" : "PROPOSED",
        },
      });
      createdSteps.push(step);
    }

    // Update project phase to literature
    await prisma.researchProject.update({
      where: { id },
      data: { currentPhase: "literature" },
    });

    await prisma.researchLogEntry.create({
      data: {
        projectId: id,
        type: "decision",
        content: `Full pipeline started: ${steps.map((s) => s.title).join(" → ")}`,
      },
    });

    // Kick off the first step directly (no internal HTTP needed)
    const firstStep = createdSteps[0];
    if (firstStep) {
      executeStep(id, firstStep.id, userId).catch((err) => {
        console.error("[run-pipeline] Failed to kick off first step:", err);
      });
    }

    return NextResponse.json({
      status: "started",
      steps: createdSteps.map((s) => ({ id: s.id, type: s.type, title: s.title })),
    });
  } catch (err) {
    console.error("[api/research/run-pipeline] POST error:", err);
    return NextResponse.json({ error: "Pipeline failed to start" }, { status: 500 });
  }
}
