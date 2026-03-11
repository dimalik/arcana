/**
 * Step execution engine — all research step logic lives here.
 *
 * Both the API route handler and the pipeline can call these directly,
 * avoiding fragile internal HTTP calls.
 */

import { prisma } from "@/lib/prisma";
import { runDiscovery } from "@/lib/discovery/engine";
import { generateLLMResponse, setLlmContext } from "@/lib/llm/provider";
import { getDefaultModel } from "@/lib/llm/auto-process";
import { buildProjectContext, formatContextForPrompt } from "@/lib/research/context-builder";
import { searchAllSources } from "@/lib/import/semantic-scholar";
import { findAndDownloadPdf } from "@/lib/import/pdf-finder";
import { processingQueue } from "@/lib/processing/queue";

// ── Public API ───────────────────────────────────────────────────

/**
 * Execute a step by ID. Marks it RUNNING and dispatches to the correct handler.
 * Steps complete independently — the UI shows results and a "Continue" button
 * so the user can review before proceeding.
 *
 * Returns immediately — callers don't need to await the full execution.
 */
export async function executeStep(projectId: string, stepId: string, userId: string): Promise<void> {
  const step = await prisma.researchStep.findUnique({ where: { id: stepId } });
  if (!step) throw new Error("Step not found");
  if (step.status !== "APPROVED") throw new Error("Step must be APPROVED");

  // Mark as running
  await prisma.researchStep.update({
    where: { id: stepId },
    data: { status: "RUNNING" },
  });

  // Dispatch to handler (all run in background)
  switch (step.type) {
    case "search_papers":
      runSearchPapers(projectId, stepId, userId, step.input).catch(handleBgError(projectId, stepId, "search_papers"));
      break;
    case "discover_papers":
      runDiscoverPapers(projectId, stepId).catch(handleBgError(projectId, stepId, "discover_papers"));
      break;
    case "generate_code":
      runCodeGen(projectId, stepId, userId, step.input).catch(handleBgError(projectId, stepId, "generate_code"));
      break;
    case "user_action":
      await prisma.researchStep.update({
        where: { id: stepId },
        data: { status: "COMPLETED", completedAt: new Date() },
      });
      // Step done — UI will show results and "Continue" button
      break;
    default:
      // LLM-backed steps: synthesize, critique, analyze_results, etc.
      runLLMStep(projectId, stepId, userId, step.type).catch(handleBgError(projectId, stepId, step.type));
      break;
  }
}

function handleBgError(projectId: string, stepId: string, stepType: string) {
  return (err: unknown) => {
    console.error(`[step-executor] ${stepType} background error for step ${stepId}:`, err);
  };
}

// ── Step failure helper ──────────────────────────────────────────

async function failStep(projectId: string, stepId: string, message: string, logType = "dead_end") {
  await prisma.researchStep.update({
    where: { id: stepId },
    data: {
      status: "FAILED",
      completedAt: new Date(),
      output: JSON.stringify({ error: message }),
    },
  });
  await prisma.researchLogEntry.create({
    data: { projectId, type: logType, content: message },
  });
}

// ── Search papers (topic-based, no seed papers needed) ───────────

async function runSearchPapers(
  projectId: string,
  stepId: string,
  userId: string,
  rawInput: string | null,
) {
  try {
    const input = rawInput ? JSON.parse(rawInput) : {};

    const project = await prisma.researchProject.findUnique({
      where: { id: projectId },
      select: { title: true, brief: true, collectionId: true },
    });
    if (!project) throw new Error("Project not found");

    // Extract the research question from brief
    let question = project.title;
    try {
      const brief = JSON.parse(project.brief);
      question = brief.question || brief.topic || project.title;
    } catch {
      question = project.brief || project.title;
    }

    const query = input.query || question;
    const maxPapers = input.maxPapers || 8;

    console.log(`[search_papers] Searching for: "${query}" (max ${maxPapers})`);

    const results = await searchAllSources(query);
    const toImport = results.slice(0, maxPapers);

    if (toImport.length === 0) {
      await prisma.researchStep.update({
        where: { id: stepId },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          output: JSON.stringify({ query, imported: 0, message: "No papers found" }),
        },
      });
      // Step done — UI will show results and "Continue" button
      return;
    }

    // Ensure project has a collection
    let collectionId = project.collectionId;
    if (!collectionId) {
      const collection = await prisma.collection.create({
        data: { name: `Research: ${project.title}` },
      });
      collectionId = collection.id;
      await prisma.researchProject.update({
        where: { id: projectId },
        data: { collectionId },
      });
    }

    const imported: string[] = [];
    const skipped: string[] = [];

    for (const result of toImport) {
      try {
        // Check for existing paper by DOI or arXiv ID
        if (result.doi || result.arxivId) {
          const existing = await prisma.paper.findFirst({
            where: {
              userId,
              OR: [
                ...(result.doi ? [{ doi: result.doi }] : []),
                ...(result.arxivId ? [{ arxivId: result.arxivId }] : []),
              ],
            },
          });
          if (existing) {
            await prisma.collectionPaper.upsert({
              where: { paperId_collectionId: { collectionId, paperId: existing.id } },
              create: { collectionId, paperId: existing.id },
              update: {},
            });
            imported.push(existing.id);
            continue;
          }
        }

        // Try to download PDF
        let filePath: string | undefined;
        try {
          const pdfResult = await findAndDownloadPdf({
            doi: result.doi,
            arxivId: result.arxivId,
            existingPdfUrl: result.openAccessPdfUrl,
          });
          if (pdfResult) filePath = pdfResult.filePath;
        } catch {
          // PDF download is optional
        }

        const paper = await prisma.paper.create({
          data: {
            title: result.title,
            userId,
            abstract: result.abstract ?? null,
            authors: result.authors ? JSON.stringify(result.authors) : null,
            year: result.year ?? null,
            venue: result.venue ?? null,
            doi: result.doi ?? null,
            arxivId: result.arxivId ?? null,
            sourceType: result.arxivId ? "ARXIV" : result.externalUrl ? "URL" : "UPLOAD",
            sourceUrl: result.externalUrl ?? null,
            filePath,
            processingStatus: filePath ? "EXTRACTING_TEXT" : "PENDING",
          },
        });

        await prisma.collectionPaper.create({
          data: { collectionId, paperId: paper.id },
        });

        if (filePath) {
          processingQueue.enqueue(paper.id);
        }

        imported.push(paper.id);
        console.log(`[search_papers] Imported: ${result.title.slice(0, 60)}`);
      } catch (err) {
        console.error(`[search_papers] Failed to import "${result.title}":`, err);
        skipped.push(result.title);
      }
    }

    await prisma.researchStep.update({
      where: { id: stepId },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        output: JSON.stringify({
          query,
          imported: imported.length,
          skipped: skipped.length,
          paperIds: imported,
        }),
      },
    });

    await prisma.researchLogEntry.create({
      data: {
        projectId,
        type: "observation",
        content: `Found and imported ${imported.length} paper(s) on "${query}"${skipped.length > 0 ? ` (${skipped.length} skipped)` : ""}`,
      },
    });

    // Step done — UI will show results and "Continue" button
  } catch (err) {
    const message = err instanceof Error ? err.message : "Paper search failed";
    console.error(`[search_papers] Failed:`, message);
    await failStep(projectId, stepId, `Paper search failed: ${message}`);
  }
}

// ── Discovery (citation-graph, needs seed papers) ────────────────

async function runDiscoverPapers(projectId: string, stepId: string) {
  try {
    const project = await prisma.researchProject.findUnique({
      where: { id: projectId },
      select: { collectionId: true, title: true, userId: true },
    });
    if (!project) throw new Error("Project not found");

    const collectionPapers = project.collectionId
      ? await prisma.collectionPaper.findMany({
          where: { collectionId: project.collectionId },
          select: { paperId: true },
          take: 5,
        })
      : [];

    const seedPaperIds = collectionPapers.map((cp) => cp.paperId);
    if (seedPaperIds.length === 0) {
      await failStep(projectId, stepId, "No seed papers in project");
      return;
    }

    const step = await prisma.researchStep.findUnique({ where: { id: stepId } });
    const input = step?.input ? JSON.parse(step.input) : {};

    const discoverySession = await prisma.discoverySession.create({
      data: {
        userId: project.userId,
        title: input.query || `Research: ${project.title}`,
        depth: input.depth || 1,
        seedPapers: {
          create: seedPaperIds.map((paperId: string) => ({ paperId })),
        },
      },
    });

    await prisma.researchStep.update({
      where: { id: stepId },
      data: { discoveryId: discoverySession.id },
    });

    const depth = input.depth || 1;
    let totalFound = 0;
    for await (const event of runDiscovery(discoverySession.id, seedPaperIds, depth, project.userId)) {
      if (event.type === "done") totalFound = event.totalFound;
      if (event.type === "proposal") totalFound++;
    }

    await prisma.researchStep.update({
      where: { id: stepId },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        output: JSON.stringify({ totalFound, sessionId: discoverySession.id }),
      },
    });

    await prisma.researchLogEntry.create({
      data: {
        projectId,
        type: "observation",
        content: `Discovery completed: found ${totalFound} related paper(s)`,
      },
    });

    // Step done — UI will show results and "Continue" button
  } catch (err) {
    const message = err instanceof Error ? err.message : "Discovery failed";
    console.error("[step-executor] Discovery failed:", message);
    await failStep(projectId, stepId, `Discovery failed: ${message}`);
  }
}

// ── LLM-backed steps ────────────────────────────────────────────

const STEP_PROMPTS: Record<string, (ctx: string) => string> = {
  synthesize: (ctx) => `You are analyzing a research project. Based on the project context below, perform a cross-paper synthesis.

${ctx}

Analyze the papers in this project and produce:
1. **Common themes**: What topics and methods appear across multiple papers?
2. **Contradictions**: Where do papers disagree or report conflicting results?
3. **Gaps**: What important questions remain unanswered by the current literature?
4. **Methodology comparison**: How do the papers differ in their approaches?
5. **Key takeaways**: What are the most important findings for this research question?

Be specific — reference papers by title when making claims.`,

  critique: (ctx) => `You are a research methodology advisor. Based on the project context below, propose research hypotheses.

${ctx}

Based on the papers collected, gaps identified, and the research question, propose 2-4 testable hypotheses.

You MUST respond with ONLY a JSON object (no markdown fences, no extra text) in this exact format:
{
  "summary": "Brief overview of what the hypotheses address (2-3 sentences)",
  "hypotheses": [
    {
      "statement": "A clear, falsifiable hypothesis statement",
      "rationale": "Which papers/gaps support this hypothesis and why it matters",
      "testApproach": "How this could be tested experimentally",
      "evidence": "What evidence would support or refute it"
    }
  ]
}`,

  analyze_results: (ctx) => `You are analyzing experiment results for a research project.

${ctx}

Based on any completed experiment steps, the hypotheses being tested, and the literature:
1. Compare results against each hypothesis — does evidence support or refute it?
2. Compare results against claims in the literature — any discrepancies?
3. Identify any unexpected findings
4. Suggest which hypotheses should be updated based on the evidence
5. Recommend next steps

Be specific and reference concrete data points where possible.`,
};

async function runLLMStep(
  projectId: string,
  stepId: string,
  userId: string,
  stepType: string,
) {
  try {
    const ctx = await buildProjectContext(projectId);
    if (!ctx) throw new Error("Could not build project context");

    const contextStr = formatContextForPrompt(ctx);
    const promptBuilder = STEP_PROMPTS[stepType];
    const prompt = promptBuilder
      ? promptBuilder(contextStr)
      : `Analyze the following research project and provide insights relevant to the "${stepType}" step.\n\n${contextStr}`;

    const { provider, modelId, proxyConfig } = await getDefaultModel();
    setLlmContext(`research-${stepType}`, userId, { projectId });

    const isCritique = stepType === "critique";
    const result = await generateLLMResponse({
      provider,
      modelId,
      proxyConfig,
      system: isCritique
        ? "You are an expert research advisor. Respond ONLY with valid JSON, no markdown fences or extra text."
        : "You are an expert research advisor. Provide thorough, specific analysis grounded in the papers and data provided. Use markdown formatting.",
      prompt,
      maxTokens: 4000,
    });

    if (isCritique) {
      const { hypotheses, analysisText } = await parseCritiqueAndCreateHypotheses(projectId, result);
      await prisma.researchStep.update({
        where: { id: stepId },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          output: JSON.stringify({ analysis: analysisText, hypothesesCreated: hypotheses }),
        },
      });
    } else {
      await prisma.researchStep.update({
        where: { id: stepId },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          output: JSON.stringify({ analysis: result }),
        },
      });
    }

    await prisma.researchLogEntry.create({
      data: {
        projectId,
        type: "observation",
        content: `${stepType} step completed: ${result.slice(0, 150)}...`,
      },
    });

    // Step done — UI will show results and "Continue" button
  } catch (err) {
    const message = err instanceof Error ? err.message : "Step execution failed";
    console.error(`[step-executor] LLM step ${stepType} failed:`, message);
    await failStep(projectId, stepId, `${stepType} step failed: ${message}`);
  }
}

async function parseCritiqueAndCreateHypotheses(
  projectId: string,
  llmOutput: string,
): Promise<{ hypotheses: number; analysisText: string }> {
  const cleaned = llmOutput.trim().replace(/^```json?\n?|\n?```$/g, "");

  let parsed: { summary?: string; hypotheses?: { statement: string; rationale: string; testApproach?: string; evidence?: string }[] };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    console.error("[step-executor] Critique response was not valid JSON, storing as text.");
    await fallbackExtractHypotheses(projectId, llmOutput);
    return { hypotheses: 0, analysisText: llmOutput };
  }

  const hypothesesArr = parsed.hypotheses || [];
  let created = 0;

  for (const h of hypothesesArr) {
    if (!h.statement || h.statement.length < 10) continue;
    await prisma.researchHypothesis.create({
      data: {
        projectId,
        statement: h.statement.slice(0, 500),
        rationale: [h.rationale, h.testApproach ? `Test: ${h.testApproach}` : ""].filter(Boolean).join("\n\n") || "Generated from cross-paper analysis",
        status: "PROPOSED",
      },
    });
    created++;
  }

  if (created > 0) {
    await prisma.researchLogEntry.create({
      data: {
        projectId,
        type: "agent_suggestion",
        content: `Generated ${created} hypothesis suggestion(s) from paper analysis`,
      },
    });
  }

  const analysisLines: string[] = [];
  if (parsed.summary) analysisLines.push(parsed.summary);
  for (let i = 0; i < hypothesesArr.length; i++) {
    const h = hypothesesArr[i];
    analysisLines.push(`\n**H${i + 1}: ${h.statement}**`);
    if (h.rationale) analysisLines.push(`Rationale: ${h.rationale}`);
    if (h.testApproach) analysisLines.push(`Test approach: ${h.testApproach}`);
    if (h.evidence) analysisLines.push(`Evidence criteria: ${h.evidence}`);
  }

  return { hypotheses: created, analysisText: analysisLines.join("\n") };
}

async function fallbackExtractHypotheses(projectId: string, text: string) {
  try {
    const patterns = [
      /\*\*H\d+[:.]\s*(.+?)\*\*/g,
      /\*\*Hypothesis[:\s]+(.+?)\*\*/gi,
      /[""\u201C]statement[""\u201D]:\s*[""\u201C](.+?)[""\u201D]/g,
    ];

    const found = new Set<string>();
    for (const pattern of patterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const s = match[1].trim();
        if (s.length > 10 && s.length < 500) found.add(s);
      }
    }

    for (const statement of Array.from(found)) {
      await prisma.researchHypothesis.create({
        data: { projectId, statement, rationale: "Extracted from analysis", status: "PROPOSED" },
      });
    }

    if (found.size > 0) {
      await prisma.researchLogEntry.create({
        data: { projectId, type: "agent_suggestion", content: `Extracted ${found.size} hypothesis(es) via fallback` },
      });
    }
  } catch (err) {
    console.error("[step-executor] Fallback hypothesis extraction failed:", err);
  }
}

// ── Code generation ──────────────────────────────────────────────

async function runCodeGen(
  projectId: string,
  stepId: string,
  userId: string,
  rawInput: string | null,
) {
  try {
    const input = rawInput ? JSON.parse(rawInput) : {};
    const ctx = await buildProjectContext(projectId);
    if (!ctx) throw new Error("Could not build project context");

    const contextStr = formatContextForPrompt(ctx);
    const customPrompt = input.prompt || "";

    const prompt = `You are an expert research programmer producing publication-quality experiment code.

${contextStr}

${customPrompt ? `Additional instructions: ${customPrompt}\n\n` : ""}Generate a complete, self-contained Python experiment that meets publication standards:

## Requirements
1. **Reproduce methods from the papers**: Reference specific algorithms, metrics, and evaluation protocols described in the literature above. Use the exact method names, loss functions, and hyperparameter ranges mentioned in the papers.
2. **Proper experimental design**: Include train/validation/test splits, cross-validation or bootstrap confidence intervals, random seed control, and statistical significance tests (e.g., paired t-test, Wilcoxon).
3. **Standard datasets**: Use publicly available benchmark datasets appropriate for the domain (e.g., from sklearn, torchvision, HuggingFace datasets, UCI repository). Include download/loading code.
4. **Baselines**: Implement at least one baseline method for comparison alongside the main hypothesis being tested.
5. **Metrics**: Report standard metrics for the domain (accuracy, F1, BLEU, RMSE, etc.) with confidence intervals or standard deviations across runs.
6. **Reproducibility**: Set all random seeds, log hyperparameters, save results to JSON/CSV. Include a \`requirements.txt\` comment block at the top listing all dependencies with versions.
7. **Structure**: Use functions/classes with docstrings. Include \`if __name__ == "__main__":\` entry point. Use argparse for configurable parameters.
8. **Results output**: Print a formatted results table comparing methods, and save detailed results to a JSON file.

## Format
Return the full code in a single Python code block. After the code block, provide:
- **Hypothesis tested**: Which hypothesis this experiment addresses
- **Expected outcome**: What result would support vs. refute the hypothesis
- **How to run**: Exact command line with any arguments
- **Dependencies**: pip install command for all required packages`;

    const { provider, modelId, proxyConfig } = await getDefaultModel();
    setLlmContext("research-generate_code", userId, { projectId });

    const result = await generateLLMResponse({
      provider,
      modelId,
      proxyConfig,
      system: "You are an expert research programmer producing publication-quality code. Generate complete, runnable experiments with proper experimental design, statistical rigor, and reproducibility. Use markdown formatting with code blocks.",
      prompt,
      maxTokens: 8000,
    });

    await prisma.researchStep.update({
      where: { id: stepId },
      data: {
        status: "COMPLETED",
        completedAt: new Date(),
        output: JSON.stringify({ analysis: result }),
      },
    });

    await prisma.researchLogEntry.create({
      data: {
        projectId,
        type: "observation",
        content: `Experiment code generated`,
      },
    });

    // Step done — UI will show results and "Continue" button
  } catch (err) {
    const message = err instanceof Error ? err.message : "Code generation failed";
    console.error(`[step-executor] Code gen failed:`, message);
    await failStep(projectId, stepId, `Code generation failed: ${message}`);
  }
}
