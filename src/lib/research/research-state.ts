/**
 * Generates a structured markdown research-state document from database state.
 * Designed for injection into the agent's context so it can reason about
 * the current project status, hypotheses, approaches, and experiment results.
 */

import { prisma } from "@/lib/prisma";
import { writeFile } from "fs/promises";
import path from "path";

// ── Public API ────────────────────────────────────────────────────

/**
 * Query the database and produce a concise markdown summary of the project's
 * current research state.  Writes the result to RESEARCH_STATE.md in workDir
 * and returns the markdown string.
 */
export async function generateResearchState(
  projectId: string,
  workDir: string,
): Promise<string> {
  // ── 1. Fetch project with relations ──────────────────────────
  const project = await prisma.researchProject.findUnique({
    where: { id: projectId },
    include: {
      hypotheses: { orderBy: { updatedAt: "desc" } },
      iterations: { orderBy: { number: "desc" }, take: 1 },
      experimentResults: {
        include: { branch: true },
        orderBy: { createdAt: "asc" },
      },
      approaches: {
        include: {
          results: true,
          children: { include: { results: true } },
        },
      },
    },
  });

  if (!project) {
    const empty = `# Research State\n\nProject not found (${projectId}).\n`;
    await safeWriteFile(workDir, empty);
    return empty;
  }

  // ── 2. Job counts ────────────────────────────────────────────
  const [completedJobs, failedJobs, runningJobs] = await Promise.all([
    prisma.remoteJob.count({ where: { projectId, status: "COMPLETED" } }),
    prisma.remoteJob.count({ where: { projectId, status: "FAILED" } }),
    prisma.remoteJob.count({ where: { projectId, status: "RUNNING" } }),
  ]);

  // ── 3. Step count for current iteration ──────────────────────
  const currentIteration = project.iterations[0] ?? null;
  let stepCount = 0;
  if (currentIteration) {
    stepCount = await prisma.researchStep.count({
      where: { iterationId: currentIteration.id },
    });
  }

  // ── 4. Pending (running) jobs with details ───────────────────
  const pendingJobs = await prisma.remoteJob.findMany({
    where: { projectId, status: { in: ["RUNNING", "SYNCING", "QUEUED"] } },
    include: { host: true },
    orderBy: { createdAt: "asc" },
  });

  // ── 5. Build markdown ────────────────────────────────────────
  const sections: string[] = [];

  // Header
  const iterNum = currentIteration?.number ?? 1;
  const phase = project.currentPhase.toUpperCase();
  const expSummary = buildExperimentSummary(completedJobs, failedJobs, runningJobs);

  sections.push(
    `# Research State: ${project.title}`,
    `**Phase:** ${phase} (Iteration ${iterNum}) | **Steps:** ${stepCount} | **Experiments:** ${expSummary}`,
  );

  // Hypotheses table
  if (project.hypotheses.length > 0) {
    const rows = project.hypotheses.map((h) => {
      const evidence = summarizeEvidence(h.evidence);
      return `| ${h.status} | ${escapePipe(h.statement)} | ${escapePipe(evidence)} |`;
    });
    sections.push(
      `## Hypotheses`,
      `| Status | Statement | Evidence |`,
      `|--------|-----------|----------|`,
      ...rows,
    );
  }

  // Key Insights (from Mind Palace) — top insights by usage for papers in this project
  if (project.collectionId) {
    try {
      const insights = await prisma.insight.findMany({
        where: {
          paper: {
            collections: { some: { collectionId: project.collectionId } },
          },
        },
        include: {
          paper: { select: { title: true } },
        },
        orderBy: { usageCount: "desc" },
        take: 8,
      });
      if (insights.length > 0) {
        const insightLines = insights.map((ins) => {
          const title = ins.paper.title.length > 60
            ? ins.paper.title.slice(0, 57) + "..."
            : ins.paper.title;
          return `- [${title}]: ${ins.learning} (${ins.significance})`;
        });
        sections.push(`## Key Insights (from Mind Palace)`, ...insightLines);
      }
    } catch {
      // Non-fatal — skip insights if query fails
    }
  }

  // Active Lessons (from process memory) — top lessons by usage for this project's user
  try {
    const lessons = await prisma.agentMemory.findMany({
      where: { userId: project.userId },
      orderBy: { usageCount: "desc" },
      take: 5,
      select: { category: true, lesson: true },
    });
    if (lessons.length > 0) {
      const lessonLines = lessons.map(
        (l) => `- [${l.category}] ${l.lesson}`,
      );
      sections.push(`## Active Lessons`, ...lessonLines);
    }
  } catch {
    // Non-fatal — skip lessons if query fails
  }

  // Approach tree
  const topLevelApproaches = project.approaches.filter((a) => !a.parentId);
  if (topLevelApproaches.length > 0) {
    const lines: string[] = [];
    for (const branch of topLevelApproaches) {
      lines.push(formatApproachLine(branch, 0));
      for (const child of branch.children) {
        lines.push(formatApproachLine(child, 1));
      }
    }
    sections.push(`## Approach Tree`, ...lines);
  }

  // Results table
  if (project.experimentResults.length > 0) {
    const header = [
      `## Results`,
      `| # | Script | Approach | Key Metrics | vs Baseline | Verdict |`,
      `|---|--------|----------|-------------|-------------|---------|`,
    ];
    const rows = project.experimentResults.map((r, i) => {
      const num = i + 1;
      const script = escapePipe(r.scriptName);
      const approach = escapePipe(r.branch?.name ?? "-");
      const metrics = summarizeMetrics(r.metrics);
      const comparison = summarizeComparison(r.comparison);
      const verdict = r.verdict ?? "-";
      return `| ${num} | ${script} | ${approach} | ${metrics} | ${comparison} | ${verdict} |`;
    });
    sections.push(...header, ...rows);
  }

  // Pending jobs
  if (pendingJobs.length > 0) {
    const lines = pendingJobs.map((j) => {
      const shortId = j.id.slice(0, 8);
      const alias = j.host.alias;
      const cmd = j.command;
      return `- Job ${shortId} ${j.status.toLowerCase()} on ${alias}: ${cmd}`;
    });
    sections.push(`## Pending`, ...lines);
  }

  const markdown = sections.join("\n");

  await safeWriteFile(workDir, markdown);

  // Trigger summary generation in background (non-blocking, rate-limited)
  triggerSummaryIfNeeded(projectId, workDir);

  return markdown;
}

/**
 * Safe wrapper for context injection — returns empty string on any failure
 * so the agent can still operate without a state document.
 */
export async function getResearchStateForContext(
  projectId: string,
  workDir: string,
): Promise<string> {
  try {
    return await generateResearchState(projectId, workDir);
  } catch {
    return "";
  }
}

// ── Helpers ───────────────────────────────────────────────────────

async function safeWriteFile(workDir: string, content: string): Promise<void> {
  try {
    await writeFile(path.join(workDir, "RESEARCH_STATE.md"), content, "utf-8");
  } catch {
    // Non-fatal — the workDir might not exist yet
  }
}

/**
 * Trigger summary generation alongside state. Runs in background (non-blocking).
 * Only generates when there are 2+ experiment results to summarize.
 */
export function triggerSummaryIfNeeded(projectId: string, workDir: string): void {
  // Check experiment count before making an LLM call
  prisma.experimentResult.count({ where: { projectId } }).then(count => {
    if (count < 2) return;
    // Check if summary exists and is recent (don't regenerate within 10 minutes)
    import("fs/promises").then(({ stat, readFile: rf }) => {
      const summaryPath = path.join(workDir, "RESEARCH_SUMMARY.md");
      stat(summaryPath).then(s => {
        const ageMs = Date.now() - s.mtimeMs;
        if (ageMs < 600_000) return; // Less than 10 min old, skip
        import("./research-summary").then(({ generateResearchSummary }) => {
          generateResearchSummary(projectId, workDir).catch(e =>
            console.warn("[research-state] Summary generation failed:", e)
          );
        });
      }).catch(() => {
        // File doesn't exist — generate it
        import("./research-summary").then(({ generateResearchSummary }) => {
          generateResearchSummary(projectId, workDir).catch(e =>
            console.warn("[research-state] Summary generation failed:", e)
          );
        });
      });
    });
  }).catch(() => {});
}

/** Build a compact "5 completed, 2 failed, 1 running" string. */
function buildExperimentSummary(completed: number, failed: number, running: number): string {
  const parts: string[] = [];
  if (completed > 0) parts.push(`${completed} completed`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (running > 0) parts.push(`${running} running`);
  return parts.length > 0 ? parts.join(", ") : "none yet";
}

/** Parse the JSON evidence array on a hypothesis into a compact string. */
function summarizeEvidence(evidenceJson: string | null): string {
  if (!evidenceJson) return "-";
  try {
    const items = JSON.parse(evidenceJson) as Array<{
      ref?: string;
      summary?: string;
      supports?: boolean;
    }>;
    if (!Array.isArray(items) || items.length === 0) return "-";
    return items
      .slice(0, 3)
      .map((e) => {
        const ref = e.ref ?? "?";
        const summary = e.summary ? `: ${e.summary}` : "";
        return `${ref}${summary}`;
      })
      .join("; ");
  } catch {
    return "-";
  }
}

/** Parse JSON metrics into a compact "key=value" string. */
function summarizeMetrics(metricsJson: string | null): string {
  if (!metricsJson) return "-";
  try {
    const obj = JSON.parse(metricsJson) as Record<string, unknown>;
    const entries = Object.entries(obj).slice(0, 4);
    if (entries.length === 0) return "-";
    return entries
      .map(([k, v]) => {
        const val = typeof v === "number" ? formatNum(v) : String(v);
        return `${k}=${val}`;
      })
      .join(", ");
  } catch {
    return "-";
  }
}

/** Parse JSON comparison into a compact delta string. */
function summarizeComparison(comparisonJson: string | null): string {
  if (!comparisonJson) return "-";
  try {
    const obj = JSON.parse(comparisonJson) as Record<string, unknown>;
    const entries = Object.entries(obj).slice(0, 3);
    if (entries.length === 0) return "-";
    return entries
      .map(([k, v]) => {
        if (typeof v === "number") {
          const sign = v >= 0 ? "+" : "";
          return `${k}:${sign}${formatNum(v)}`;
        }
        return `${k}:${String(v)}`;
      })
      .join(", ");
  } catch {
    return "-";
  }
}

type ApproachWithResults = {
  name: string;
  status: string;
  results: unknown[];
};

/** Format a single approach tree line with indentation. */
function formatApproachLine(branch: ApproachWithResults, depth: number): string {
  const indent = "  ".repeat(depth);
  const status = branch.status;
  const expCount = branch.results.length;
  const expLabel = expCount === 1 ? "1 experiment" : `${expCount} experiments`;
  return `${indent}- ${branch.name} [${status}] (${expLabel})`;
}

/** Escape pipe characters for markdown table cells. */
function escapePipe(s: string): string {
  return s.replace(/\|/g, "\\|");
}

/** Format a number to reasonable precision. */
function formatNum(n: number): string {
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}
