import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";
import { getModelForTier } from "@/lib/llm/auto-process";
import { getModel, generateLLMResponse, setLlmContext } from "@/lib/llm/provider";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * POST — Create a rediscovery benchmark from a paper.
 *
 * Takes a paper already in the library (with references extracted).
 * 1. Uses LLM to extract a blinded research question (the gap, not the solution)
 * 2. Collects the paper's references as seed papers
 * 3. Creates a research project with seeds + blinded question
 * 4. Stores the ground truth (actual method) for later comparison
 *
 * Body: { paperId: string }
 */
export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    const { paperId } = await request.json();

    if (!paperId) {
      return NextResponse.json({ error: "paperId required" }, { status: 400 });
    }

    // Load the target paper with its references
    const paper = await prisma.paper.findFirst({
      where: { id: paperId, userId },
      select: {
        id: true,
        title: true,
        abstract: true,
        summary: true,
        fullText: true,
        authors: true,
        year: true,
        doi: true,
        arxivId: true,
        references: {
          select: {
            id: true,
            title: true,
            authors: true,
            year: true,
            doi: true,
            arxivId: true,
            matchedPaperId: true,
          },
        },
      },
    });

    if (!paper) {
      return NextResponse.json({ error: "Paper not found" }, { status: 404 });
    }

    if (!paper.abstract && !paper.summary && !paper.fullText) {
      return NextResponse.json({ error: "Paper has no text content — process it first" }, { status: 400 });
    }

    // Use LLM to extract blinded question + ground truth method
    const { provider, modelId, proxyConfig } = await getModelForTier("standard");
    setLlmContext("benchmark-extract", userId, { paperId });

    const paperContent = paper.fullText
      ? paper.fullText.slice(0, 8000)
      : `Title: ${paper.title}\n\nAbstract: ${paper.abstract || ""}\n\nSummary: ${paper.summary || ""}`;

    const extraction = await generateLLMResponse({
      provider, modelId, proxyConfig,
      system: `You are helping set up a research rediscovery benchmark. Given a paper, extract two things:

1. **Blinded Research Question**: The research gap or question the paper addresses, worded so that it does NOT reveal the paper's specific method or solution. It should be the kind of question a researcher would ask BEFORE reading this paper. Good: "How can we improve credit assignment in RL fine-tuning of diffusion models?" Bad: "How does branching from intermediate denoising states improve training?" (that reveals the method).

2. **Ground Truth Method**: A concise but specific description of what the paper actually proposes — the method, key insights, and main results. This is the answer the benchmark agent should ideally rediscover.

3. **Key Constraints**: Any important context the researcher would know going in (e.g., "focus on masked diffusion models, not autoregressive" or "the setting is low-resource multilingual").

Return JSON:
{
  "blindedQuestion": "...",
  "groundTruth": "...",
  "constraints": "...",
  "suggestedTitle": "..." // a neutral project title that doesn't reveal the method
}`,
      prompt: paperContent,
      maxTokens: 2000,
    });

    // Parse extraction
    let parsed: { blindedQuestion: string; groundTruth: string; constraints: string; suggestedTitle: string };
    try {
      const cleaned = extraction.replace(/```json\s*/g, "").replace(/```\s*/g, "").trim();
      parsed = JSON.parse(cleaned);
    } catch {
      return NextResponse.json({ error: "Failed to extract benchmark data from paper", raw: extraction }, { status: 500 });
    }

    // Collect seed papers from references (only those matched to library papers)
    const seedPaperIds = paper.references
      .filter((r) => r.matchedPaperId)
      .map((r) => r.matchedPaperId!)
      .filter((id, i, arr) => arr.indexOf(id) === i); // dedupe

    // Also try to import unmatched references by DOI/arXiv
    const unmatchedRefs = paper.references.filter((r) => !r.matchedPaperId && (r.doi || r.arxivId));

    // Create the benchmark project
    const brief = JSON.stringify({
      question: parsed.blindedQuestion,
      constraints: parsed.constraints,
      subQuestions: [],
      domains: [],
      keywords: [],
    });

    const collection = await prisma.collection.create({
      data: { name: `Benchmark: ${parsed.suggestedTitle.slice(0, 60)}` },
    });

    // Add seed papers to collection
    for (const seedId of seedPaperIds) {
      await prisma.collectionPaper.create({
        data: { paperId: seedId, collectionId: collection.id },
      }).catch(() => {}); // skip dupes
    }

    const project = await prisma.researchProject.create({
      data: {
        userId,
        title: parsed.suggestedTitle,
        brief,
        methodology: "experimental",
        collectionId: collection.id,
        status: "SETUP", // don't auto-start
        iterations: {
          create: {
            number: 1,
            goal: parsed.blindedQuestion,
          },
        },
        log: {
          create: [
            {
              type: "decision",
              content: `Benchmark created from paper: "${paper.title}"`,
              metadata: JSON.stringify({ benchmarkPaperId: paper.id }),
            },
            {
              type: "decision",
              content: `[GROUND TRUTH — HIDDEN FROM AGENT]\n${parsed.groundTruth}`,
              metadata: JSON.stringify({ groundTruth: true, benchmarkPaperId: paper.id }),
            },
          ],
        },
      },
      include: { iterations: true },
    });

    return NextResponse.json({
      projectId: project.id,
      title: parsed.suggestedTitle,
      blindedQuestion: parsed.blindedQuestion,
      constraints: parsed.constraints,
      groundTruth: parsed.groundTruth,
      seedPapers: seedPaperIds.length,
      unmatchedRefs: unmatchedRefs.length,
      refTitles: paper.references.map((r) => r.title).slice(0, 20),
    });
  } catch (err) {
    console.error("[benchmark] POST error:", err);
    return NextResponse.json({ error: "Failed to create benchmark" }, { status: 500 });
  }
}

/**
 * GET — List benchmark projects with their ground truth for evaluation.
 */
export async function GET() {
  try {
    const userId = await requireUserId();

    // Find projects that have benchmark log entries
    const benchmarkLogs = await prisma.researchLogEntry.findMany({
      where: {
        metadata: { contains: "benchmarkPaperId" },
        project: { userId },
      },
      select: {
        projectId: true,
        content: true,
        metadata: true,
        project: {
          select: {
            id: true,
            title: true,
            status: true,
            brief: true,
            methodology: true,
            currentPhase: true,
            hypotheses: {
              select: { statement: true, status: true, evidence: true },
            },
            iterations: {
              include: {
                steps: {
                  where: { type: { in: ["run_experiment", "generate_code"] } },
                  select: { title: true, status: true, output: true },
                },
              },
            },
          },
        },
      },
    });

    // Group by project
    const projectMap = new Map<string, {
      project: typeof benchmarkLogs[0]["project"];
      groundTruth: string | null;
      sourcePaperId: string | null;
    }>();

    for (const log of benchmarkLogs) {
      const pid = log.projectId;
      if (!projectMap.has(pid)) {
        projectMap.set(pid, { project: log.project, groundTruth: null, sourcePaperId: null });
      }
      const entry = projectMap.get(pid)!;
      try {
        const meta = JSON.parse(log.metadata || "{}");
        if (meta.groundTruth) {
          entry.groundTruth = log.content.replace("[GROUND TRUTH — HIDDEN FROM AGENT]\n", "");
        }
        if (meta.benchmarkPaperId) {
          entry.sourcePaperId = meta.benchmarkPaperId;
        }
      } catch { /* skip */ }
    }

    const benchmarks = Array.from(projectMap.values()).map((b) => ({
      ...b.project,
      groundTruth: b.groundTruth,
      sourcePaperId: b.sourcePaperId,
    }));

    return NextResponse.json(benchmarks);
  } catch (err) {
    console.error("[benchmark] GET error:", err);
    return NextResponse.json({ error: "Failed to fetch benchmarks" }, { status: 500 });
  }
}
