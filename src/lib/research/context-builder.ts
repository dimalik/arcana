import { prisma } from "@/lib/prisma";
import { isPlanningNotebookEntry } from "./research-log-policy";

export interface ProjectContext {
  title: string;
  question: string;
  subQuestions: string[];
  methodology: string | null;
  domains: string[];
  keywords: string[];
  currentPhase: string;
  iterationNumber: number;
  iterationGoal: string;
  paperSummaries: { title: string; summary: string }[];
  hypotheses: { statement: string; status: string; rationale: string | null }[];
  completedAnalyses: { title: string; analysis: string }[];
  recentLog: { type: string; content: string }[];
  previousIterations: { number: number; goal: string; reflection: string | null }[];
}

type ProjectBrief = {
  question?: string;
  topic?: string;
  subQuestions?: string[];
  domains?: string[];
  keywords?: string[];
};

function parseProjectBrief(rawBrief: string | null, fallbackTitle: string): Required<ProjectBrief> {
  const fallbackQuestion = rawBrief?.trim() || fallbackTitle;
  if (!rawBrief) {
    return {
      question: fallbackQuestion,
      topic: fallbackQuestion,
      subQuestions: [],
      domains: [],
      keywords: [],
    };
  }

  try {
    const parsed = JSON.parse(rawBrief) as ProjectBrief | string | null;
    if (typeof parsed === "string") {
      const question = parsed.trim() || fallbackQuestion;
      return {
        question,
        topic: question,
        subQuestions: [],
        domains: [],
        keywords: [],
      };
    }
    if (!parsed || typeof parsed !== "object") {
      throw new Error("brief JSON must decode to an object");
    }
    const question = parsed.question?.trim() || parsed.topic?.trim() || fallbackQuestion;
    return {
      question,
      topic: parsed.topic?.trim() || question,
      subQuestions: Array.isArray(parsed.subQuestions)
        ? parsed.subQuestions.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : [],
      domains: Array.isArray(parsed.domains)
        ? parsed.domains.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : [],
      keywords: Array.isArray(parsed.keywords)
        ? parsed.keywords.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : [],
    };
  } catch (err) {
    console.warn("[context-builder] Failed to parse project brief; falling back to raw text.", err);
    return {
      question: fallbackQuestion,
      topic: fallbackQuestion,
      subQuestions: [],
      domains: [],
      keywords: [],
    };
  }
}

/**
 * Builds a compact context object from a research project for LLM prompts.
 * Keeps within reasonable token limits by using summaries, not full text.
 */
export async function buildProjectContext(projectId: string): Promise<ProjectContext | null> {
  const project = await prisma.researchProject.findUnique({
    where: { id: projectId },
    include: {
      iterations: {
        orderBy: { number: "desc" },
        include: {
          steps: {
            where: { status: "COMPLETED" },
            select: { title: true, output: true },
          },
        },
      },
      hypotheses: {
        select: { statement: true, status: true, rationale: true },
      },
      collection: {
        include: {
          papers: {
            include: {
              paper: {
                select: { title: true, summary: true, abstract: true },
              },
            },
          },
        },
      },
      log: {
        where: {
          type: { in: ["decision", "breakthrough", "dead_end"] },
        },
        orderBy: { createdAt: "desc" },
        take: 20,
      },
    },
  });

  if (!project) return null;

  const brief = parseProjectBrief(project.brief, project.title);
  const activeIteration = project.iterations.find((i) => i.status === "ACTIVE") || project.iterations[0];
  const papers = project.collection?.papers.map((cp) => cp.paper) || [];

  // Extract analysis outputs from completed steps (synthesize, critique, analyze_results)
  const completedAnalyses: { title: string; analysis: string }[] = [];
  for (const iter of project.iterations) {
    for (const step of iter.steps) {
      if (step.output) {
        try {
          const parsed = JSON.parse(step.output);
          if (parsed.analysis && typeof parsed.analysis === "string") {
            completedAnalyses.push({
              title: step.title,
              analysis: parsed.analysis.slice(0, 1000),
            });
          }
        } catch { /* not JSON */ }
      }
    }
  }

  return {
    title: project.title,
    question: brief.question,
    subQuestions: brief.subQuestions,
    methodology: project.methodology,
    domains: brief.domains,
    keywords: brief.keywords,
    currentPhase: project.currentPhase,
    iterationNumber: activeIteration?.number || 1,
    iterationGoal: activeIteration?.goal || "",
    paperSummaries: papers.map((p) => ({
      title: p.title,
      summary: (p.summary || p.abstract || "").slice(0, 500),
    })),
    hypotheses: project.hypotheses.map((h) => ({
      statement: h.statement,
      status: h.status,
      rationale: h.rationale,
    })),
    completedAnalyses,
    recentLog: project.log.map((l) => ({
      type: l.type,
      content: l.content,
    })).filter((entry) => !(entry.type === "decision" && isPlanningNotebookEntry(entry.content))),
    previousIterations: project.iterations
      .filter((i) => i.status === "COMPLETED")
      .map((i) => ({
        number: i.number,
        goal: i.goal,
        reflection: i.reflection,
      })),
  };
}

/**
 * Formats project context into a string for LLM system prompts.
 */
export function formatContextForPrompt(ctx: ProjectContext): string {
  const sections: string[] = [];

  sections.push(`# Research Project: ${ctx.title}`);
  sections.push(`## Research Question\n${ctx.question}`);

  if (ctx.subQuestions.length > 0) {
    sections.push(`## Sub-Questions\n${ctx.subQuestions.map((q) => `- ${q}`).join("\n")}`);
  }

  sections.push(`## Current State\n- Phase: ${ctx.currentPhase}\n- Iteration: #${ctx.iterationNumber} — ${ctx.iterationGoal}\n- Methodology: ${ctx.methodology || "not specified"}`);

  if (ctx.paperSummaries.length > 0) {
    const paperList = ctx.paperSummaries
      .slice(0, 15)
      .map((p) => `### ${p.title}\n${p.summary}`)
      .join("\n\n");
    sections.push(`## Papers (${ctx.paperSummaries.length})\n${paperList}`);
  }

  if (ctx.completedAnalyses.length > 0) {
    const analysisList = ctx.completedAnalyses
      .slice(0, 5)
      .map((a) => `### ${a.title}\n${a.analysis}`)
      .join("\n\n");
    sections.push(`## Previous Analyses & Findings\n${analysisList}`);
  }

  if (ctx.hypotheses.length > 0) {
    const hList = ctx.hypotheses
      .map((h) => `- [${h.status}] ${h.statement}${h.rationale ? ` — ${h.rationale}` : ""}`)
      .join("\n");
    sections.push(`## Hypotheses\n${hList}`);
  }

  if (ctx.previousIterations.length > 0) {
    const iterList = ctx.previousIterations
      .map((i) => `### Iteration #${i.number}: ${i.goal}\n${i.reflection || "No reflection recorded."}`)
      .join("\n\n");
    sections.push(`## Previous Iterations\n${iterList}`);
  }

  if (ctx.recentLog.length > 0) {
    const logList = ctx.recentLog
      .slice(0, 10)
      .map((l) => `- [${l.type}] ${l.content}`)
      .join("\n");
    sections.push(`## Recent Log\n${logList}`);
  }

  return sections.join("\n\n");
}
