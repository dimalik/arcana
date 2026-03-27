import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";
import { getModelForTier } from "@/lib/llm/auto-process";
import { getModel, setLlmContext } from "@/lib/llm/provider";
import { generateObject } from "ai";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST — Evaluate a benchmark project against its ground truth.
 *
 * Compares the agent's hypotheses, experiments, and findings
 * against the actual paper's method. Returns a structured assessment.
 *
 * Body: { projectId: string }
 */
export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    const { projectId } = await request.json();

    const project = await prisma.researchProject.findFirst({
      where: { id: projectId, userId },
      include: {
        hypotheses: { select: { statement: true, status: true, evidence: true } },
        iterations: {
          include: {
            steps: {
              where: { status: "COMPLETED" },
              select: { type: true, title: true, output: true },
              orderBy: { sortOrder: "asc" },
            },
          },
        },
        log: {
          orderBy: { createdAt: "desc" },
          select: { type: true, content: true, metadata: true },
        },
        collection: {
          include: { papers: { include: { paper: { select: { title: true } } } } },
        },
      },
    });

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // Extract ground truth from log
    const groundTruthLog = project.log.find((l) => {
      try {
        return JSON.parse(l.metadata || "{}").groundTruth === true;
      } catch { return false; }
    });

    if (!groundTruthLog) {
      return NextResponse.json({ error: "No ground truth found — this may not be a benchmark project" }, { status: 400 });
    }

    const groundTruth = groundTruthLog.content.replace("[GROUND TRUTH — HIDDEN FROM AGENT]\n", "");

    // Collect agent's work
    const hypotheses = project.hypotheses.map((h) =>
      `[${h.status}] ${h.statement}${h.evidence ? ` — Evidence: ${h.evidence.slice(0, 200)}` : ""}`
    ).join("\n");

    const experiments: string[] = [];
    for (const iter of project.iterations) {
      for (const step of iter.steps) {
        if (step.type === "run_experiment" || step.type === "generate_code") {
          let result = "";
          if (step.output) {
            try {
              const out = JSON.parse(step.output);
              result = out.stdout?.slice(-500) || out.analysis?.slice(-500) || step.output.slice(0, 500);
            } catch { result = step.output.slice(0, 500); }
          }
          experiments.push(`- ${step.title}${result ? `\n  Result: ${result}` : ""}`);
        }
      }
    }

    const findings = project.log
      .filter((l) => l.type === "observation" || l.type === "breakthrough")
      .filter((l) => { try { return !JSON.parse(l.metadata || "{}").groundTruth; } catch { return true; } })
      .map((l) => `[${l.type}] ${l.content.slice(0, 300)}`)
      .join("\n");

    const papers = project.collection?.papers.map((cp) => cp.paper.title).join(", ") || "none";

    // LLM evaluation with structured output
    const { provider, modelId, proxyConfig } = await getModelForTier("reasoning");
    setLlmContext("benchmark-evaluate", userId, { projectId });
    const model = await getModel(provider, modelId, proxyConfig);

    const evaluationSchema = z.object({
      scores: z.object({
        problemId: z.number().min(1).max(5),
        methodProximity: z.number().min(1).max(5),
        insightDiscovery: z.number().min(1).max(5),
        experimentalDesign: z.number().min(1).max(5),
        novelContributions: z.number().min(1).max(5),
      }),
      overallScore: z.number().min(1).max(5),
      summary: z.string(),
      whatMatched: z.array(z.string()),
      whatMissed: z.array(z.string()),
      surprises: z.array(z.string()),
      recommendations: z.array(z.string()),
    });

    const { object: result } = await generateObject({
      model,
      schema: evaluationSchema,
      system: `You are evaluating a research agent's ability to independently rediscover a paper's method. You are given the ground truth (what the paper proposed) and the agent's work (hypotheses, experiments, findings).

Score on 5 dimensions (1-5 each):
- problemId: Did the agent correctly identify the core problem/gap?
- methodProximity: How close did the agent get to the actual method? 5 = same technique, 1 = completely different
- insightDiscovery: Did the agent discover the paper's key insight(s)?
- experimentalDesign: Were experiments well-designed to test the right things?
- novelContributions: Did the agent propose anything the paper didn't (potentially valuable)?`,
      prompt: `## Ground Truth (actual paper method)
${groundTruth}

## Agent's Hypotheses
${hypotheses || "None formed yet"}

## Agent's Experiments
${experiments.join("\n") || "None run yet"}

## Agent's Findings
${findings || "None recorded yet"}

## Papers the agent found
${papers}

Evaluate how well the agent rediscovered the paper's method.`,
    });

    return NextResponse.json({
      projectId,
      projectTitle: project.title,
      groundTruth,
      agentWork: {
        hypotheses: project.hypotheses.length,
        experiments: experiments.length,
        papers: project.collection?.papers.length || 0,
        phase: project.currentPhase,
      },
      evaluation: result,
    });
  } catch (err) {
    console.error("[benchmark/evaluate] POST error:", err);
    return NextResponse.json({ error: "Evaluation failed" }, { status: 500 });
  }
}
