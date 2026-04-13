import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";
import { suggestNextSteps } from "@/lib/research/orchestrator";
import { executeStep } from "@/lib/research/step-executor";
import { classifyTaskCategory } from "@/lib/research/task-classifier";
import { getResourcePreference, CONFIDENCE_THRESHOLD } from "@/lib/research/resource-preferences";
import { reserveResearchStepSortOrders } from "@/lib/research/step-order";

type Params = { params: Promise<{ id: string }> };

/**
 * POST — Suggest steps, create them as APPROVED, and auto-execute the first non-user_action step.
 * This is the "auto-advance" endpoint: one call does suggest → create → execute.
 */
export async function POST(_request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;

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

    // Check if there are already running or approved steps — don't pile on
    const existingActive = await prisma.researchStep.findFirst({
      where: {
        iterationId: activeIteration.id,
        status: { in: ["RUNNING", "APPROVED"] },
      },
    });
    if (existingActive) {
      return NextResponse.json({
        status: "already_active",
        message: "Steps are already running or queued",
      });
    }

    const queuedExperimentObligation = await prisma.researchStep.findFirst({
      where: {
        iterationId: activeIteration.id,
        type: "claim_experiment_required",
        status: "PROPOSED",
      },
      orderBy: { sortOrder: "asc" },
    });
    if (queuedExperimentObligation) {
      await prisma.researchStep.update({
        where: { id: queuedExperimentObligation.id },
        data: { status: "APPROVED" },
      });
      executeStep(id, queuedExperimentObligation.id, userId).catch((err) => {
        console.error("[autorun] Failed to kick off coordinator experiment step:", err);
      });
      return NextResponse.json({
        status: "started_existing",
        steps: [queuedExperimentObligation],
        executingStepId: queuedExperimentObligation.id,
      });
    }

    const suggestions = await suggestNextSteps(id);
    if (suggestions.length === 0) {
      return NextResponse.json({ status: "no_suggestions", steps: [] });
    }

    const stepInputs = await Promise.all(suggestions.map(async (s) => {
      let input = s.input || {};
      try {
        const taskCat = classifyTaskCategory(s.title);
        const pref = await getResourcePreference(userId, taskCat, id);
        if (pref.confidence >= CONFIDENCE_THRESHOLD && pref.preference !== "auto") {
          input = { ...input, resourcePreference: pref.preference };
        }
      } catch {
        // Non-critical
      }
      return Object.keys(input).length > 0 ? JSON.stringify(input) : null;
    }));

    const createdSteps = await prisma.$transaction(async (tx) => {
      const sortOrders = await reserveResearchStepSortOrders(tx, activeIteration.id, suggestions.length);
      const created = [];
      for (let index = 0; index < suggestions.length; index += 1) {
        const s = suggestions[index];
        created.push(await tx.researchStep.create({
          data: {
            iterationId: activeIteration.id,
            type: s.type,
            title: s.title,
            description: s.description,
            input: stepInputs[index],
            sortOrder: sortOrders[index],
            status: s.type === "user_action" ? "PROPOSED" : "APPROVED",
          },
        }));
      }
      return created;
    });

    // Auto-execute the first APPROVED step (fire-and-forget)
    const firstApproved = createdSteps.find((s) => s.status === "APPROVED");
    if (firstApproved) {
      executeStep(id, firstApproved.id, userId).catch((err) => {
        console.error("[autorun] Failed to kick off step:", err);
      });
    }

    return NextResponse.json({
      status: "started",
      steps: createdSteps,
      executingStepId: firstApproved?.id || null,
    });
  } catch (err) {
    console.error("[api/research/autorun] POST error:", err);
    return NextResponse.json({ error: "Autorun failed" }, { status: 500 });
  }
}
