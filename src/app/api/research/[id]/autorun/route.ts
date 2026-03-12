import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";
import { suggestNextSteps } from "@/lib/research/orchestrator";
import { executeStep } from "@/lib/research/step-executor";
import { classifyTaskCategory } from "@/lib/research/task-classifier";
import { getResourcePreference, CONFIDENCE_THRESHOLD } from "@/lib/research/resource-preferences";

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

    const suggestions = await suggestNextSteps(id);
    if (suggestions.length === 0) {
      return NextResponse.json({ status: "no_suggestions", steps: [] });
    }

    // Create steps — APPROVED for automatable, PROPOSED for user_action
    const createdSteps = [];
    for (const s of suggestions) {
      const isUserAction = s.type === "user_action";

      // Auto-apply learned resource preference if confidence is high enough
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
      const inputStr = Object.keys(input).length > 0 ? JSON.stringify(input) : null;

      const step = await prisma.researchStep.create({
        data: {
          iterationId: activeIteration.id,
          type: s.type,
          title: s.title,
          description: s.description,
          input: inputStr,
          sortOrder: s.sortOrder,
          status: isUserAction ? "PROPOSED" : "APPROVED",
        },
      });
      createdSteps.push(step);
    }

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
