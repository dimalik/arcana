import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";
import { getModelForTier } from "@/lib/llm/auto-process";
import { getModel, setLlmContext } from "@/lib/llm/provider";
import { generateObject } from "ai";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface Move {
  step: number;
  type: string;
  title: string;
  content: string;
  timestamp: string;
}

interface JudgeVerdict {
  move: number;
  score: number; // -2 (cold) to +2 (hot)
  label: "hot" | "warm" | "neutral" | "cool" | "cold";
  comment: string;
}

interface JudgeReport {
  judge: string;
  verdicts: JudgeVerdict[];
  summary: string;
  overallScore: number; // 1-5
}

/**
 * POST — Run the judge panel on a benchmark project.
 *
 * Four LLM judges evaluate each major decision against the hidden ground truth.
 * Returns a scored timeline for each judge.
 *
 * Body: { projectId: string }
 */
export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    const body = await request.json();
    const { projectId, previousVerdicts, previousMoveCount } = body as {
      projectId: string;
      previousVerdicts?: Record<string, JudgeVerdict[]>; // judge name → prior verdicts
      previousMoveCount?: number; // how many moves were already judged
    };

    // Load project with all data
    const project = await prisma.researchProject.findFirst({
      where: { id: projectId, userId },
      include: {
        hypotheses: { orderBy: { createdAt: "asc" }, select: { statement: true, status: true, evidence: true, createdAt: true } },
        iterations: {
          include: {
            steps: {
              where: { status: "COMPLETED" },
              orderBy: { sortOrder: "asc" },
              select: { type: true, title: true, output: true, completedAt: true },
            },
          },
        },
        log: {
          orderBy: { createdAt: "asc" },
          select: { type: true, content: true, metadata: true, createdAt: true },
        },
        collection: {
          include: { papers: { include: { paper: { select: { title: true, year: true } } } } },
        },
      },
    });

    if (!project) return NextResponse.json({ error: "Project not found" }, { status: 404 });

    // Extract ground truth
    const gtLog = project.log.find((l) => {
      try { return JSON.parse(l.metadata || "{}").groundTruth === true; } catch { return false; }
    });
    if (!gtLog) return NextResponse.json({ error: "No ground truth — not a benchmark project" }, { status: 400 });
    const groundTruth = gtLog.content.replace("[GROUND TRUTH — HIDDEN FROM AGENT]\n", "");

    // Build the move timeline
    const moves: Move[] = [];
    let moveNum = 0;

    // Hypotheses as moves
    for (const h of project.hypotheses) {
      moves.push({
        step: ++moveNum,
        type: "hypothesis",
        title: `Hypothesis: ${h.statement.slice(0, 80)}`,
        content: `[${h.status}] ${h.statement}${h.evidence ? `\nEvidence: ${h.evidence.slice(0, 300)}` : ""}`,
        timestamp: h.createdAt.toISOString(),
      });
    }

    // Steps as moves (experiments, code generation, searches)
    for (const iter of project.iterations) {
      for (const step of iter.steps) {
        let output = "";
        if (step.output) {
          try {
            const parsed = JSON.parse(step.output);
            output = parsed.stdout?.slice(-300) || parsed.analysis?.slice(-300) || step.output.slice(0, 300);
          } catch { output = step.output.slice(0, 300); }
        }
        moves.push({
          step: ++moveNum,
          type: step.type,
          title: step.title.slice(0, 100),
          content: `${step.title}\n${output}`,
          timestamp: step.completedAt?.toISOString() || "",
        });
      }
    }

    // Key log entries as moves
    for (const entry of project.log) {
      if (entry.type === "breakthrough" || entry.type === "dead_end") {
        try { if (JSON.parse(entry.metadata || "{}").groundTruth) continue; } catch { /* skip */ }
        moves.push({
          step: ++moveNum,
          type: entry.type,
          title: `${entry.type === "breakthrough" ? "Breakthrough" : "Dead end"}: ${entry.content.slice(0, 60)}`,
          content: entry.content.slice(0, 400),
          timestamp: entry.createdAt.toISOString(),
        });
      }
    }

    // Sort by timestamp
    moves.sort((a, b) => (a.timestamp || "").localeCompare(b.timestamp || ""));
    // Re-number
    moves.forEach((m, i) => { m.step = i + 1; });

    if (moves.length === 0) {
      return NextResponse.json({ error: "No moves to evaluate yet — let the agent run first" }, { status: 400 });
    }

    // Incremental: only judge new moves (skip already-judged ones)
    const startFrom = previousMoveCount || 0;
    const newMoves = moves.filter((m) => m.step > startFrom);

    if (newMoves.length === 0 && startFrom > 0) {
      return NextResponse.json({ error: `No new moves since last judge run (${startFrom} already judged)` }, { status: 400 });
    }

    // Build context: summary of prior moves + full detail of new moves
    const priorSummary = startFrom > 0
      ? `[Moves 1-${startFrom} were already judged. Summary of the trajectory so far: the agent has taken ${startFrom} steps.]\n\n`
      : "";
    const moveSummary = priorSummary + newMoves.map((m) => `Move ${m.step} [${m.type}]: ${m.content.slice(0, 200)}`).join("\n\n");

    // Run all 4 judges in parallel
    const { provider, modelId, proxyConfig } = await getModelForTier("standard");
    setLlmContext("benchmark-judges", userId, { projectId });

    const judgePrompts: { name: string; system: string }[] = [
      {
        name: "Direction",
        system: `You are the DIRECTION JUDGE in a research rediscovery benchmark. You see the ground truth (the actual paper's method) and the agent's moves. For each move, assess: is the agent getting WARMER (closer to the ground truth) or COLDER (further away)?

Score each move:
+2 = HOT (directly toward the key insight)
+1 = WARM (in a promising direction)
 0 = NEUTRAL (neither helpful nor harmful)
-1 = COOL (moving away from the solution)
-2 = COLD (actively counterproductive)

Return JSON: { "verdicts": [{"move": 1, "score": N, "label": "hot|warm|neutral|cool|cold", "comment": "why"}], "summary": "overall trajectory assessment", "overallScore": N (1-5) }`,
      },
      {
        name: "Efficiency",
        system: `You are the EFFICIENCY JUDGE. You evaluate whether the agent is taking the SHORTEST PATH to the ground truth or wasting steps. A perfect agent would go: identify problem → search relevant literature → form the right hypothesis → validate with experiment. Every detour, redundant search, or unnecessary experiment is inefficiency.

Score each move:
+2 = ESSENTIAL (couldn't have reached the solution without this)
+1 = USEFUL (contributes, even if not the shortest path)
 0 = NEUTRAL (doesn't help or hurt)
-1 = WASTEFUL (could have been skipped)
-2 = COUNTERPRODUCTIVE (actively cost time/resources for no gain)

Return JSON: { "verdicts": [{"move": 1, "score": N, "label": "hot|warm|neutral|cool|cold", "comment": "why"}], "summary": "efficiency assessment", "overallScore": N (1-5) }`,
      },
      {
        name: "Rigor",
        system: `You are the RIGOR JUDGE. You evaluate the SCIENTIFIC QUALITY of each move — are hypotheses testable? Are experiments well-controlled? Are conclusions justified by evidence? Would this pass peer review?

Score each move:
+2 = EXCELLENT (rigorous, well-designed, properly controlled)
+1 = GOOD (reasonable but could be stronger)
 0 = ADEQUATE (acceptable but not notable)
-1 = WEAK (methodological issues)
-2 = POOR (fundamentally flawed — wrong controls, invalid conclusions, etc.)

Return JSON: { "verdicts": [{"move": 1, "score": N, "label": "hot|warm|neutral|cool|cold", "comment": "why"}], "summary": "rigor assessment", "overallScore": N (1-5) }`,
      },
      {
        name: "Completeness",
        system: `You are the COMPLETENESS JUDGE. You track what PERCENTAGE of the ground truth's key elements the agent has discovered at each step. Extract the 5-7 most important elements from the ground truth, then for each move, assess whether it discovered or contributed to discovering any of them.

Score each move:
+2 = KEY DISCOVERY (found a core element of the ground truth)
+1 = PARTIAL (got close to or partially discovered an element)
 0 = NO PROGRESS (didn't discover any new elements)
-1 = DISTRACTION (focused on something irrelevant to the ground truth)
-2 = WRONG DIRECTION (formed a conclusion that contradicts the ground truth)

Also track cumulative coverage: after each move, what % of the ground truth elements have been found?

Return JSON: { "verdicts": [{"move": 1, "score": N, "label": "hot|warm|neutral|cool|cold", "comment": "why — mention which ground truth element if relevant"}], "summary": "completeness assessment with final coverage %", "overallScore": N (1-5) }`,
      },
    ];

    // Structured output schema — guarantees valid JSON
    const verdictSchema = z.object({
      verdicts: z.array(z.object({
        move: z.number(),
        score: z.number().min(-2).max(2),
        label: z.enum(["hot", "warm", "neutral", "cool", "cold"]),
        comment: z.string(),
      })),
      summary: z.string(),
      overallScore: z.number().min(1).max(5),
    });

    const model = await getModel(provider, modelId, proxyConfig);

    const judgeResults = await Promise.all(
      judgePrompts.map(async (judge) => {
        try {
          const { object } = await generateObject({
            model,
            schema: verdictSchema,
            system: judge.system,
            prompt: `## Ground Truth (the actual paper's method — HIDDEN from the agent)\n${groundTruth}\n\n## Agent's Moves (in chronological order)\n${moveSummary}`,
          });

          // Merge with previous verdicts if incremental
          const priorVerdicts = previousVerdicts?.[judge.name] || [];
          const mergedVerdicts = [...priorVerdicts, ...object.verdicts];

          return { judge: judge.name, verdicts: mergedVerdicts, summary: object.summary, overallScore: object.overallScore } as JudgeReport;
        } catch (err) {
          return { judge: judge.name, verdicts: [], summary: `Judge failed: ${(err as Error).message}`, overallScore: 0 } as JudgeReport;
        }
      })
    );

    return NextResponse.json({
      projectId,
      moveCount: moves.length,
      moves: moves.map((m) => ({ step: m.step, type: m.type, title: m.title })),
      judges: judgeResults,
    });
  } catch (err) {
    console.error("[benchmark/judges] POST error:", err);
    return NextResponse.json({ error: "Judge panel failed" }, { status: 500 });
  }
}
