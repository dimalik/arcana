import { prisma } from "@/lib/prisma";
import { buildProjectContext } from "./context-builder";
import { generateLLMResponse, setLlmContext } from "@/lib/llm/provider";
import { getDefaultModel } from "@/lib/llm/auto-process";
import { classifyTaskCategory } from "./task-classifier";
import { getResourcePreference, CONFIDENCE_THRESHOLD } from "./resource-preferences";

export interface StepSuggestion {
  type: string;
  title: string;
  description: string;
  input?: Record<string, unknown>;
  sortOrder: number;
}

/**
 * Core orchestrator: suggests next steps for a research project based on current phase.
 */
export async function suggestNextSteps(projectId: string): Promise<StepSuggestion[]> {
  const project = await prisma.researchProject.findUnique({
    where: { id: projectId },
    include: {
      iterations: {
        where: { status: "ACTIVE" },
        take: 1,
        include: {
          steps: { orderBy: { sortOrder: "asc" } },
        },
      },
      hypotheses: true,
      collection: {
        include: {
          papers: {
            include: {
              paper: {
                select: { id: true, title: true, summary: true, abstract: true },
              },
            },
          },
        },
      },
      log: {
        orderBy: { createdAt: "desc" },
        take: 20,
      },
    },
  });

  if (!project) return [];

  const papers = project.collection?.papers.map((cp) => cp.paper) || [];
  const activeIteration = project.iterations[0];
  const existingSteps = activeIteration?.steps || [];
  const pendingSteps = existingSteps.filter((s) => s.status === "PROPOSED" || s.status === "APPROVED");

  // Don't suggest if there are already pending steps
  if (pendingSteps.length >= 3) return [];

  const phase = project.currentPhase;

  // Rule-based suggestions first (fast, no LLM needed)
  const ruleSuggestions = getRuleBasedSuggestions(phase, papers.length, project.hypotheses, existingSteps);
  if (ruleSuggestions.length > 0) return ruleSuggestions;

  // Fall back to LLM-based suggestions for nuanced cases
  return getLLMSuggestions(project, papers, phase);
}

function getRuleBasedSuggestions(
  phase: string,
  paperCount: number,
  hypotheses: { id: string; status: string; statement: string }[],
  existingSteps: { type: string; status: string }[],
): StepSuggestion[] {
  const suggestions: StepSuggestion[] = [];
  const completedTypes = new Set(existingSteps.filter((s) => s.status === "COMPLETED").map((s) => s.type));

  switch (phase) {
    case "literature": {
      if (paperCount < 5) {
        suggestions.push({
          type: paperCount === 0 ? "search_papers" : "discover_papers",
          title: "Search for related papers",
          description: `Your project has ${paperCount} paper${paperCount !== 1 ? "s" : ""}. Discovering more related work will strengthen the literature foundation.`,
          sortOrder: 0,
        });
      }
      if (paperCount >= 2 && !completedTypes.has("synthesize")) {
        suggestions.push({
          type: "synthesize",
          title: "Cross-paper analysis",
          description: "Analyze relationships, contradictions, and gaps across your collected papers.",
          sortOrder: 1,
        });
      }
      if (paperCount >= 3) {
        suggestions.push({
          type: "user_action",
          title: "Move to hypothesis phase",
          description: "You have enough literature to start forming hypotheses. Review your papers and proceed when ready.",
          sortOrder: 2,
        });
      }
      break;
    }
    case "hypothesis": {
      if (hypotheses.length === 0) {
        suggestions.push({
          type: "critique",
          title: "Generate hypothesis suggestions",
          description: "The agent will analyze your papers and propose research hypotheses based on identified gaps and patterns.",
          sortOrder: 0,
        });
      }
      const untested = hypotheses.filter((h) => h.status === "PROPOSED");
      if (untested.length > 0 && hypotheses.length > 0) {
        suggestions.push({
          type: "user_action",
          title: "Move to experiment phase",
          description: `You have ${untested.length} proposed hypothesis(es) ready to test.`,
          sortOrder: 1,
        });
      }
      break;
    }
    case "experiment": {
      const testing = hypotheses.filter((h) => h.status === "TESTING");
      if (testing.length > 0 || hypotheses.some((h) => h.status === "PROPOSED")) {
        suggestions.push({
          type: "generate_code",
          title: "Generate experiment code",
          description: "Create code to test your hypotheses based on the methodology from your papers.",
          sortOrder: 0,
        });
      }
      break;
    }
    case "analysis": {
      if (!completedTypes.has("analyze_results")) {
        suggestions.push({
          type: "analyze_results",
          title: "Analyze experiment results",
          description: "Compare your results against hypotheses and literature claims.",
          sortOrder: 0,
        });
      }
      break;
    }
    case "reflection": {
      suggestions.push({
        type: "critique",
        title: "Reflect on this iteration",
        description: "Summarize what was learned, what worked, and what to try next.",
        sortOrder: 0,
      });
      break;
    }
  }

  return suggestions;
}

async function getLLMSuggestions(
  project: {
    id: string;
    title: string;
    brief: string;
    currentPhase: string;
    methodology: string | null;
    hypotheses: { statement: string; status: string }[];
  },
  papers: { id: string; title: string; summary: string | null; abstract: string | null }[],
  phase: string,
): Promise<StepSuggestion[]> {
  try {
    const { provider, modelId, proxyConfig } = await getDefaultModel();
    setLlmContext("research-suggest", undefined, { projectId: project.id });

    const brief = JSON.parse(project.brief);
    const paperSummaries = papers
      .slice(0, 10)
      .map((p) => `- ${p.title}: ${p.summary || p.abstract || "No summary"}`.slice(0, 300))
      .join("\n");
    const hypothesisList = project.hypotheses
      .map((h) => `- [${h.status}] ${h.statement}`)
      .join("\n");

    const result = await generateLLMResponse({
      provider,
      modelId,
      proxyConfig,
      system: "You are a research methodology advisor. Suggest concrete next steps. Respond in JSON array format only.",
      prompt: `Research project: "${project.title}"
Question: ${brief.question}
Phase: ${phase}
Methodology: ${project.methodology || "not specified"}

Papers (${papers.length}):
${paperSummaries || "None yet"}

Hypotheses:
${hypothesisList || "None yet"}

Suggest 1-3 next steps for the "${phase}" phase. Each step should be actionable.

Respond as JSON array:
[{ "type": "<search_papers|discover_papers|synthesize|generate_code|analyze_results|critique|user_action>", "title": "...", "description": "..." }]`,
      maxTokens: 800,
    });

    const jsonMatch = result.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const parsed = JSON.parse(jsonMatch[0]) as { type: string; title: string; description: string }[];
    return parsed.map((s, i) => ({ ...s, sortOrder: i }));
  } catch (err) {
    console.error("[orchestrator] LLM suggestion failed:", err);
    return [];
  }
}

/**
 * Create proposed steps in the database from suggestions.
 */
export async function createProposedSteps(
  projectId: string,
  iterationId: string,
  suggestions: StepSuggestion[],
  userId?: string,
): Promise<void> {
  for (const s of suggestions) {
    // Auto-apply learned resource preference if confidence is high enough
    let input = s.input || {};
    if (userId) {
      try {
        const taskCat = classifyTaskCategory(s.title);
        const pref = await getResourcePreference(userId, taskCat, projectId);
        if (pref.confidence >= CONFIDENCE_THRESHOLD && pref.preference !== "auto") {
          input = { ...input, resourcePreference: pref.preference };
        }
      } catch {
        // Non-critical — proceed without preference
      }
    }

    const inputStr = Object.keys(input).length > 0 ? JSON.stringify(input) : null;
    await prisma.researchStep.create({
      data: {
        iterationId,
        type: s.type,
        title: s.title,
        description: s.description,
        input: inputStr,
        sortOrder: s.sortOrder,
        status: "PROPOSED",
      },
    });
  }
}
