/**
 * Generates a human-readable research summary (paper-style writeup) from
 * the project's database state using structured LLM generation.
 *
 * Unlike research-state.ts (a structured data dump for the agent), this
 * produces a polished markdown document suitable for human consumption.
 */

import { prisma } from "@/lib/prisma";
import { writeFile } from "fs/promises";
import path from "path";
import { z } from "zod";

// ── Schema ───────────────────────────────────────────────────────

const summarySchema = z.object({
  introduction: z
    .string()
    .describe(
      "1-2 paragraphs: research question, motivation, what we're investigating",
    ),
  keyFindings: z
    .array(
      z.object({
        finding: z.string(),
        evidence: z
          .string()
          .describe("Which experiment(s) support this"),
        confidence: z.enum(["strong", "moderate", "preliminary"]),
      }),
    )
    .describe("3-7 key findings, ordered by importance"),
  methods: z
    .string()
    .describe(
      "1 paragraph: what approaches were tried, how many experiments, what models/datasets",
    ),
  openQuestions: z
    .array(z.string())
    .describe("2-5 unresolved questions or next steps"),
  currentStatus: z
    .string()
    .describe("1 sentence: overall status of the research"),
  tldr: z
    .string()
    .describe("One paragraph (2-3 sentences) executive summary of the entire research so far — key question, best result, main insight. This is shown when collapsed."),
});

// ── Public API ────────────────────────────────────────────────────

/**
 * Query the full project state from the database, call an LLM to produce
 * a structured research summary, format it as markdown, write it to
 * RESEARCH_SUMMARY.md in workDir, and return the markdown string.
 */
export interface ResearchSummaryData {
  short: string;  // 2-3 sentence executive summary
  full: string;   // full markdown document
}

export async function generateResearchSummary(
  projectId: string,
  workDir: string,
): Promise<ResearchSummaryData> {
  // ── 1. Fetch project with all relations ──────────────────────
  const project = await prisma.researchProject.findUnique({
    where: { id: projectId },
    include: {
      hypotheses: {
        orderBy: { updatedAt: "desc" },
      },
      experimentResults: {
        include: { branch: true },
        orderBy: { createdAt: "asc" },
      },
      approaches: {
        include: {
          children: { include: { results: true } },
          results: true,
        },
      },
      log: {
        orderBy: { createdAt: "desc" },
        take: 50,
      },
      collection: {
        include: {
          papers: {
            include: { paper: { select: { title: true, authors: true } } },
            take: 20,
          },
        },
      },
    },
  });

  if (!project) {
    const empty: ResearchSummaryData = { short: "Project not found.", full: "# Research Summary\n\nProject not found.\n" };
    await safeWriteFile(workDir, JSON.stringify(empty));
    return empty;
  }

  // ── 2. Categorize log entries ─────────────────────────────────
  const breakthroughs = project.log.filter((e) => e.type === "breakthrough");
  const decisions = project.log.filter((e) => e.type === "decision");
  const adversarialReviews = project.log.filter(
    (e) => e.type === "observation" && e.content.toLowerCase().includes("review"),
  );

  // ── 3. Build the prompt ───────────────────────────────────────
  const prompt = buildPrompt({
    project,
    hypotheses: project.hypotheses,
    experiments: project.experimentResults,
    approaches: project.approaches,
    breakthroughs,
    decisions,
    adversarialReviews,
    papers: project.collection?.papers.map((cp) => cp.paper) ?? [],
  });

  // ── 4. Call generateObject ────────────────────────────────────
  const { generateObject } = await import("ai");
  const { getModelForTier } = await import("@/lib/llm/auto-process");
  const { getModel, setLlmContext } = await import("@/lib/llm/provider");

  const { provider, modelId, proxyConfig } = await getModelForTier("standard");
  setLlmContext("research-summary", "system", { projectId });
  const model = await getModel(provider, modelId, proxyConfig);

  const { object } = await generateObject({
    model,
    schema: summarySchema,
    system:
      "You are a research analyst. Given the full state of a research project, " +
      "produce a clear, honest summary suitable for a research report. " +
      "Focus on what was learned, what evidence supports each finding, and what remains open. " +
      "Be specific about experiment names and metrics. Do not fabricate results.",
    prompt,
  });

  // ── 5. Format as markdown ─────────────────────────────────────
  const totalExperiments = project.experimentResults.length;
  const totalApproaches = project.approaches.filter((a) => !a.parentId).length;
  const now = new Date().toISOString().replace("T", " ").slice(0, 16);

  const md = formatMarkdown(object, totalExperiments, totalApproaches, now);
  const short = object.tldr || object.currentStatus || md.split("\n\n").find(p => !p.startsWith("#") && p.trim().length > 20) || "";

  const result: ResearchSummaryData = { short, full: md };

  // ── 6. Write to disk as JSON ────────────────────────────────
  await safeWriteFile(workDir, JSON.stringify(result));
  // Also write markdown for the agent's context
  try {
    await writeFile(path.join(workDir, "RESEARCH_SUMMARY.md"), md, "utf-8");
  } catch { /* non-fatal */ }

  return result;
}

/**
 * Safe wrapper that catches errors and returns null on failure,
 * suitable for optional display contexts.
 */
export async function getResearchSummaryForDisplay(
  projectId: string,
  workDir: string,
): Promise<ResearchSummaryData | null> {
  try {
    return await generateResearchSummary(projectId, workDir);
  } catch {
    return null;
  }
}

// ── Prompt builder ───────────────────────────────────────────────

interface PromptData {
  project: {
    title: string;
    brief: string;
    currentPhase: string;
    methodology: string | null;
  };
  hypotheses: Array<{
    statement: string;
    status: string;
    theme: string | null;
    evidence: string | null;
  }>;
  experiments: Array<{
    scriptName: string;
    metrics: string | null;
    verdict: string | null;
    reflection: string | null;
    branch: { name: string } | null;
  }>;
  approaches: Array<{
    name: string;
    status: string;
    parentId: string | null;
    children: Array<{ name: string; status: string; results: unknown[] }>;
    results: unknown[];
  }>;
  breakthroughs: Array<{ content: string }>;
  decisions: Array<{ content: string }>;
  adversarialReviews: Array<{ content: string }>;
  papers: Array<{ title: string; authors: string | null }>;
}

function buildPrompt(data: PromptData): string {
  const sections: string[] = [];

  // Project brief
  let briefText = "";
  try {
    const brief = JSON.parse(data.project.brief) as {
      question?: string;
      methodology?: string;
      subQuestions?: string[];
      domains?: string[];
    };
    briefText = [
      brief.question ? `Research question: ${brief.question}` : "",
      brief.methodology ? `Methodology: ${brief.methodology}` : "",
      brief.subQuestions?.length
        ? `Sub-questions: ${brief.subQuestions.join("; ")}`
        : "",
      brief.domains?.length ? `Domains: ${brief.domains.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  } catch {
    briefText = data.project.brief;
  }

  sections.push(
    `PROJECT: ${data.project.title}`,
    `Phase: ${data.project.currentPhase}`,
    briefText,
  );

  // Hypotheses
  if (data.hypotheses.length > 0) {
    const lines = data.hypotheses.map((h) => {
      const theme = h.theme ? ` [${h.theme}]` : "";
      const evidence = parseEvidence(h.evidence);
      return `- [${h.status}]${theme} ${h.statement}${evidence ? ` — Evidence: ${evidence}` : ""}`;
    });
    sections.push(`\nHYPOTHESES:\n${lines.join("\n")}`);
  }

  // Experiment results
  if (data.experiments.length > 0) {
    const lines = data.experiments.map((e, i) => {
      const metrics = parseMetrics(e.metrics);
      const approach = e.branch ? ` (${e.branch.name})` : "";
      const verdict = e.verdict ? ` → ${e.verdict}` : "";
      const reflection = e.reflection ? ` | Reflection: ${e.reflection}` : "";
      return `${i + 1}. ${e.scriptName}${approach}: ${metrics}${verdict}${reflection}`;
    });
    sections.push(`\nEXPERIMENT RESULTS:\n${lines.join("\n")}`);
  }

  // Approach tree
  const topApproaches = data.approaches.filter((a) => !a.parentId);
  if (topApproaches.length > 0) {
    const lines: string[] = [];
    for (const a of topApproaches) {
      lines.push(`- ${a.name} [${a.status}] (${a.results.length} experiments)`);
      for (const child of a.children) {
        lines.push(
          `  - ${child.name} [${child.status}] (${child.results.length} experiments)`,
        );
      }
    }
    sections.push(`\nAPPROACH TREE:\n${lines.join("\n")}`);
  }

  // Breakthroughs
  if (data.breakthroughs.length > 0) {
    const lines = data.breakthroughs
      .slice(0, 5)
      .map((b) => `- ${b.content}`);
    sections.push(`\nBREAKTHROUGHS:\n${lines.join("\n")}`);
  }

  // Decisions
  if (data.decisions.length > 0) {
    const lines = data.decisions.slice(0, 5).map((d) => `- ${d.content}`);
    sections.push(`\nKEY DECISIONS:\n${lines.join("\n")}`);
  }

  // Adversarial reviews
  if (data.adversarialReviews.length > 0) {
    const lines = data.adversarialReviews
      .slice(0, 3)
      .map((r) => `- ${r.content}`);
    sections.push(`\nADVERSARIAL REVIEWS:\n${lines.join("\n")}`);
  }

  // Papers
  if (data.papers.length > 0) {
    const lines = data.papers.map((p) => {
      const authors = p.authors ? ` (${p.authors})` : "";
      return `- ${p.title}${authors}`;
    });
    sections.push(`\nREFERENCED PAPERS:\n${lines.join("\n")}`);
  }

  return sections.join("\n");
}

// ── Markdown formatter ───────────────────────────────────────────

function formatMarkdown(
  summary: z.infer<typeof summarySchema>,
  totalExperiments: number,
  totalApproaches: number,
  timestamp: string,
): string {
  const sections: string[] = [];

  sections.push("# Research Summary");
  if (summary.tldr) {
    sections.push(`\n> ${summary.tldr}`);
  }
  sections.push(`\n## Introduction\n${summary.introduction}`);

  // Key Findings
  if (summary.keyFindings.length > 0) {
    const findings = summary.keyFindings.map((f, i) => {
      return `${i + 1}. **${f.finding}** (confidence: ${f.confidence})\n   Evidence: ${f.evidence}`;
    });
    sections.push(`\n## Key Findings\n${findings.join("\n")}`);
  }

  sections.push(`\n## Methods\n${summary.methods}`);

  // Open Questions
  if (summary.openQuestions.length > 0) {
    const questions = summary.openQuestions.map((q) => `- ${q}`);
    sections.push(`\n## Open Questions\n${questions.join("\n")}`);
  }

  sections.push(`\n## Status\n${summary.currentStatus}`);

  // Footer
  const expLabel =
    totalExperiments === 1 ? "1 experiment" : `${totalExperiments} experiments`;
  const appLabel =
    totalApproaches === 1 ? "1 approach" : `${totalApproaches} approaches`;
  sections.push(
    `\n---\n*Auto-generated from ${expLabel} across ${appLabel}. Last updated: ${timestamp}*`,
  );

  return sections.join("\n");
}

// ── Helpers ──────────────────────────────────────────────────────

async function safeWriteFile(
  workDir: string,
  content: string,
): Promise<void> {
  try {
    await writeFile(
      path.join(workDir, "RESEARCH_SUMMARY.md"),
      content,
      "utf-8",
    );
  } catch {
    // Non-fatal — the workDir might not exist yet
  }
}

function parseEvidence(evidenceJson: string | null): string {
  if (!evidenceJson) return "";
  try {
    const items = JSON.parse(evidenceJson) as Array<{
      ref?: string;
      summary?: string;
      supports?: boolean;
    }>;
    if (!Array.isArray(items) || items.length === 0) return "";
    return items
      .slice(0, 3)
      .map((e) => {
        const ref = e.ref ?? "?";
        const summary = e.summary ? `: ${e.summary}` : "";
        return `${ref}${summary}`;
      })
      .join("; ");
  } catch {
    return "";
  }
}

function parseMetrics(metricsJson: string | null): string {
  if (!metricsJson) return "no metrics";
  try {
    const obj = JSON.parse(metricsJson) as Record<string, unknown>;
    const entries = Object.entries(obj).slice(0, 5);
    if (entries.length === 0) return "no metrics";
    return entries
      .map(([k, v]) => {
        if (typeof v === "number") {
          return `${k}=${Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;
        }
        return `${k}=${String(v)}`;
      })
      .join(", ");
  } catch {
    return "no metrics";
  }
}
