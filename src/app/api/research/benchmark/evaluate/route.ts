import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";
import { getModelForTier } from "@/lib/llm/auto-process";
import { generateLLMResponse, setLlmContext } from "@/lib/llm/provider";

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
          where: { type: { in: ["observation", "breakthrough", "decision"] } },
          orderBy: { createdAt: "desc" },
          take: 30,
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

    // LLM evaluation
    const { provider, modelId, proxyConfig } = await getModelForTier("reasoning");
    setLlmContext("benchmark-evaluate", userId, { projectId });

    const evaluation = await generateLLMResponse({
      provider, modelId, proxyConfig,
      system: `You are evaluating a research agent's ability to independently rediscover a paper's method. You are given:
1. The GROUND TRUTH: what the actual paper proposed
2. The AGENT'S WORK: hypotheses, experiments, and findings

Score the agent on these dimensions (1-5 each):

- **Problem Identification** (1-5): Did the agent correctly identify the core problem/gap?
- **Method Proximity** (1-5): How close did the agent's proposed approach get to the actual method? 5 = essentially the same technique; 1 = completely different direction.
- **Key Insight Discovery** (1-5): Did the agent discover the paper's key insight(s)?
- **Experimental Design** (1-5): Were the agent's experiments well-designed to test the right things?
- **Novel Contributions** (1-5): Did the agent propose anything the paper DIDN'T do (potentially valuable additions)?

Return JSON:
{
  "scores": { "problemId": N, "methodProximity": N, "insightDiscovery": N, "experimentalDesign": N, "novelContributions": N },
  "overallScore": N,  // 1-5 average
  "summary": "2-3 sentence overall assessment",
  "whatMatched": ["list of things the agent got right"],
  "whatMissed": ["list of things the agent missed"],
  "surprises": ["anything interesting the agent found that the paper didn't"],
  "recommendations": ["how to improve the agent based on this benchmark"]
}`,
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
      maxTokens: 3000,
    });

    let result;
    try {
      const cleaned = evaluation.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      result = JSON.parse(cleaned);
    } catch {
      result = { raw: evaluation, error: "Failed to parse evaluation" };
    }

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
