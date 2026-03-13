import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";

type Params = { params: Promise<{ id: string }> };

/**
 * POST — Cleanup a stuck project and prepare it for a fresh agent run.
 *
 * What it does:
 * - Deletes FAILED, RUNNING, and PROPOSED steps (they're stale)
 * - Keeps COMPLETED and SKIPPED steps (useful work)
 * - Builds a "prior work summary" from completed steps, hypotheses, and results
 * - Resets project phase to "literature" (or keeps it if further along)
 * - Creates a log entry noting the restart
 * - Returns the summary so the frontend can pass it to the agent as context
 */
export async function POST(_request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;

    const project = await prisma.researchProject.findFirst({
      where: { id, userId },
      include: {
        iterations: {
          include: {
            steps: { orderBy: { sortOrder: "asc" } },
          },
        },
        hypotheses: true,
        log: {
          where: {
            type: { in: ["observation", "breakthrough", "decision"] },
          },
          orderBy: { createdAt: "desc" },
          take: 20,
        },
        collection: {
          include: {
            papers: {
              include: {
                paper: {
                  select: { id: true, title: true, summary: true, processingStatus: true },
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

    // Gather completed work before cleanup
    const completedSteps: { type: string; title: string; output: string | null }[] = [];
    const failedSteps: { type: string; title: string }[] = [];
    let stepsDeleted = 0;

    for (const iteration of project.iterations) {
      for (const step of iteration.steps) {
        if (step.status === "COMPLETED") {
          completedSteps.push({ type: step.type, title: step.title, output: step.output });
        } else if (step.status === "FAILED") {
          failedSteps.push({ type: step.type, title: step.title });
        }

        // Delete non-completed steps
        if (step.status !== "COMPLETED" && step.status !== "SKIPPED") {
          await prisma.researchStep.delete({ where: { id: step.id } });
          stepsDeleted++;
        }
      }
    }

    // Build prior work summary for agent context
    const summaryParts: string[] = [];

    // Papers
    const papers = project.collection?.papers.map((cp) => cp.paper) || [];
    const completedPapers = papers.filter((p) => p.processingStatus === "COMPLETED");
    if (papers.length > 0) {
      summaryParts.push(`## Papers Collected: ${papers.length} (${completedPapers.length} fully processed)`);
    }

    // Completed searches
    const searches = completedSteps.filter((s) => s.type === "search_papers");
    if (searches.length > 0) {
      summaryParts.push(`## Literature Search: ${searches.length} searches completed`);
    }

    // Hypotheses
    if (project.hypotheses.length > 0) {
      summaryParts.push(
        `## Hypotheses:\n${project.hypotheses.map((h) => `- [${h.status}] ${h.statement}`).join("\n")}`
      );
    }

    // Experiment results
    const experiments = completedSteps.filter(
      (s) => s.type === "run_experiment" || s.type === "generate_code"
    );
    if (experiments.length > 0) {
      const expSummaries: string[] = [];
      for (const exp of experiments) {
        if (!exp.output) continue;
        try {
          const out = JSON.parse(exp.output);
          if (out.stdout) {
            expSummaries.push(`- ${exp.title}: ${out.stdout.slice(0, 300)}`);
          } else if (out.analysis) {
            expSummaries.push(`- ${exp.title}: ${out.analysis.slice(0, 300)}`);
          }
        } catch {
          expSummaries.push(`- ${exp.title}`);
        }
      }
      summaryParts.push(`## Completed Experiments:\n${expSummaries.join("\n")}`);
    }

    // Failed experiments (so agent knows what went wrong)
    const failedExps = failedSteps.filter((s) => s.type === "run_experiment");
    if (failedExps.length > 0) {
      summaryParts.push(
        `## Previously Failed (${failedExps.length} runs):\n${failedExps.map((s) => `- ${s.title}`).join("\n")}\nThese failed in a prior run. Fix the code before re-running.`
      );
    }

    // Key findings from log
    const findings = project.log.filter((l) => l.type === "observation" || l.type === "breakthrough");
    if (findings.length > 0) {
      summaryParts.push(
        `## Key Findings:\n${findings.slice(0, 5).map((f) => `- ${f.content.slice(0, 200)}`).join("\n")}`
      );
    }

    const priorWorkSummary = summaryParts.join("\n\n");

    // Reset project state — keep the current phase (don't reset to literature)
    await prisma.researchProject.update({
      where: { id },
      data: {
        status: "ACTIVE",
      },
    });

    // Log the restart
    await prisma.researchLogEntry.create({
      data: {
        projectId: id,
        type: "decision",
        content: `Project restarted. Cleaned ${stepsDeleted} stale steps, keeping ${completedSteps.length} completed. Agent will continue with prior work context.`,
      },
    });

    return NextResponse.json({
      ok: true,
      stepsDeleted,
      stepsKept: completedSteps.length,
      priorWorkSummary,
    });
  } catch (err) {
    console.error("[api/research/[id]/restart] POST error:", err);
    return NextResponse.json({ error: "Failed to restart project" }, { status: 500 });
  }
}
