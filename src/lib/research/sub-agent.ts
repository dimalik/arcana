/**
 * Sub-agent runner — spawns focused, lightweight agents (e.g., literature scouts)
 * that run in the background with limited tool sets.
 *
 * Each sub-agent:
 * - Loads its AgentTask from DB, marks RUNNING
 * - Gets a focused system prompt based on role
 * - Calls generateText() with a limited tool set
 * - Writes structured findings to AgentTask.output as JSON
 * - Marks COMPLETED/FAILED
 */

import { streamText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { getToolLoopModel } from "@/lib/llm/provider";
import { getModelForTier } from "@/lib/llm/auto-process";
import { setLlmContext } from "@/lib/llm/provider";
import { prisma } from "@/lib/prisma";
import { searchAllSources } from "@/lib/import/semantic-scholar";
import { searchDuckDuckGo } from "@/lib/import/web-search";
import { processQuery, scoreText, filterByRelevance, stemTerms, scoreWeighted } from "./search-utils";
import { formatSkillCards, querySkillCards } from "./insight-skills";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

type StructuredClaimReview = {
  claimId?: string;
  claimStatement?: string;
  status: "SUPPORTED" | "CONTESTED" | "REPRODUCED" | "RETRACTED";
  confidence?: "PRELIMINARY" | "MODERATE" | "STRONG";
  notes?: string;
};

function normalizeClaimReview(payload: unknown): StructuredClaimReview | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const status = typeof record.status === "string" ? record.status.toUpperCase() : "";
  if (!["SUPPORTED", "CONTESTED", "REPRODUCED", "RETRACTED"].includes(status)) return null;
  const confidence = typeof record.confidence === "string" ? record.confidence.toUpperCase() : undefined;
  return {
    claimId: typeof record.claimId === "string" ? record.claimId : undefined,
    claimStatement: typeof record.claimStatement === "string" ? record.claimStatement : undefined,
    status: status as StructuredClaimReview["status"],
    confidence: confidence && ["PRELIMINARY", "MODERATE", "STRONG"].includes(confidence)
      ? confidence as StructuredClaimReview["confidence"]
      : undefined,
    notes: typeof record.notes === "string" ? record.notes : undefined,
  };
}

function extractStructuredClaimReviews(text: string): StructuredClaimReview[] {
  const matches = Array.from(text.matchAll(/```json\s*([\s\S]*?)```/g)).reverse();
  for (const match of matches) {
    try {
      const parsed = JSON.parse(match[1]);
      if (!parsed || typeof parsed !== "object") continue;
      const claimReviews = (parsed as { claimReviews?: unknown[] }).claimReviews;
      if (!Array.isArray(claimReviews)) continue;
      const normalized = claimReviews
        .map(normalizeClaimReview)
        .filter((review): review is StructuredClaimReview => review !== null);
      if (normalized.length > 0) return normalized;
    } catch {
      continue;
    }
  }
  return [];
}

function trimTrailingSeparators(value: string) {
  return value.replace(/[\\/]+$/, "") || value;
}

function resolveWorkdirPath(workDir: string, relativePath: string) {
  const normalized = relativePath.replace(/\\/g, "/").trim();
  if (!normalized || normalized === ".") return trimTrailingSeparators(workDir);
  if (normalized.startsWith("/") || normalized.includes("\0")) return null;

  const parts = normalized.split("/").filter((part) => part.length > 0 && part !== ".");
  if (parts.some((part) => part === "..")) return null;

  return `${trimTrailingSeparators(workDir)}/${parts.join("/")}`;
}

function reviewJsonInstructions() {
  return `
## Structured Claim Reviews JSON
End your response with a fenced \`json\` block of this exact shape:

\`\`\`json
{
  "claimReviews": [
    {
      "claimId": "optional-claim-id",
      "claimStatement": "optional fallback statement",
      "status": "SUPPORTED | CONTESTED | REPRODUCED | RETRACTED",
      "confidence": "PRELIMINARY | MODERATE | STRONG",
      "notes": "one concise justification"
    }
  ]
}
\`\`\`

Use every reviewed claim exactly once in the JSON block.`;
}

// ── Scout system prompt ─────────────────────────────────────────

function scoutSystemPrompt(angle: string, keywords: string[]): string {
  return `You are a focused literature scout. You search for papers and report findings — you do NOT import papers.

## Your Mission
Search for papers related to: "${angle}"
Keywords to try: ${keywords.join(", ")}

## Instructions
1. Use \`find_papers\` with 2-3 different queries (vary keywords, try synonyms)
2. For promising results, use \`read_paper\` if they're already in the library
3. Synthesize what you found into a structured summary

**IMPORTANT: find_papers does NOT import papers. You are scouting only — the lead researcher decides what to import.**

## Output Format
Return a summary with:
- **Key Papers**: The 3-5 most relevant papers (title, year, authors, why relevant)
- **Methods**: Specific techniques found
- **Key Numbers**: Performance numbers and baselines
- **Gaps**: What the literature doesn't address
- **Import Recommendations**: Which papers the lead researcher SHOULD import (include DOI/arxivId for easy import)

Be specific — include paper titles, years, and concrete numbers.`;
}

// ── Sub-agent tool sets ─────────────────────────────────────────

function scoutTools(userId: string, _projectId: string, bannedPapers?: { title: string; doi?: string | null; arxivId?: string | null }[]) {
  // Filter helper for benchmark blindfolding
  const isBannedPaper = (r: { title: string; doi?: string | null; arxivId?: string | null }) => {
    if (!bannedPapers || bannedPapers.length === 0) return false;
    for (const b of bannedPapers) {
      if (b.doi && r.doi && b.doi === r.doi) return true;
      if (b.arxivId && r.arxivId && b.arxivId === r.arxivId) return true;
      const normB = b.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      const normR = r.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (normB.length > 20 && (normR.includes(normB) || normB.includes(normR))) return true;
    }
    return false;
  };

  return {
    find_papers: tool({
      description: "Search academic databases and return results for evaluation. Does NOT import papers — report findings so the lead researcher can decide what to import.",
      inputSchema: z.object({
        query: z.string(),
        max_results: z.number().min(1).max(5).default(3).optional(),
      }),
      execute: async ({ query, max_results }: { query: string; max_results?: number }) => {
        const results = await searchAllSources(query);
        const relevant = filterByRelevance(results, query)
          .filter((r) => !isBannedPaper(r));
        const toShow = relevant.slice(0, max_results || 3);
        if (toShow.length === 0) {
          return results.length > 0
            ? `Found ${results.length} papers but none were relevant to "${query}".`
            : "No papers found.";
        }

        const terms = stemTerms(query);
        const formatted = toShow.map((r, i) => {
          const score = scoreWeighted(
            [{ text: r.title, weight: 3 }, { text: r.abstract || "", weight: 2 }],
            terms,
          );
          return `${i + 1}. "${r.title}" (${r.year || "?"}) — ${r.citationCount || 0} citations, relevance=${score.toFixed(1)}${r.doi ? `\n   DOI: ${r.doi}` : ""}${r.arxivId ? `\n   arXiv: ${r.arxivId}` : ""}${r.abstract ? `\n   Abstract: ${r.abstract.slice(0, 300)}` : ""}`;
        });

        // Also check which are already in the library
        const existingTitles = new Set<string>();
        for (const r of toShow) {
          if (r.doi || r.arxivId) {
            const existing = await prisma.paper.findFirst({
              where: { userId, OR: [...(r.doi ? [{ doi: r.doi }] : []), ...(r.arxivId ? [{ arxivId: r.arxivId }] : [])] },
              select: { id: true },
            });
            if (existing) existingTitles.add(r.title);
          }
        }

        const libraryNote = existingTitles.size > 0
          ? `\n\nAlready in library: ${Array.from(existingTitles).map(t => `"${t}"`).join(", ")}`
          : "";

        return `Found ${toShow.length} relevant papers (of ${results.length} total):\n\n${formatted.join("\n\n")}${libraryNote}\n\n(These are NOT imported — recommend the best ones in your summary for the lead researcher to import.)`;
      },
    }),

    read_paper: tool({
      description: "Read a paper's abstract, summary, and key findings.",
      inputSchema: z.object({
        title: z.string().describe("Title or partial title"),
      }),
      execute: async ({ title }: { title: string }) => {
        const paper = await prisma.paper.findFirst({
          where: { userId, title: { contains: title } },
          select: {
            title: true, abstract: true, summary: true, keyFindings: true,
            authors: true, year: true, venue: true, processingStatus: true,
            insights: { select: { learning: true, significance: true } },
          },
        });
        if (!paper) return `Paper "${title}" not found.`;
        if (paper.processingStatus && !["COMPLETED", "FAILED", "NEEDS_DEFERRED", "NO_PDF"].includes(paper.processingStatus)) {
          return `Paper "${paper.title}" is still being processed (${paper.processingStatus}). Skip it for now and come back later.`;
        }

        const parts = [`# ${paper.title}`];
        if (paper.authors) parts.push(`Authors: ${paper.authors}`);
        if (paper.year) parts.push(`Year: ${paper.year}`);
        if (paper.abstract) parts.push(`\n## Abstract\n${paper.abstract}`);
        if (paper.summary) parts.push(`\n## Summary\n${paper.summary}`);
        if (paper.keyFindings) parts.push(`\n## Key Findings\n${paper.keyFindings}`);
        if (paper.insights.length > 0) {
          parts.push(`\n## Insights\n${paper.insights.map((i) => `- ${i.learning}`).join("\n")}`);
        }
        return parts.join("\n");
      },
    }),

    search_library: tool({
      description: "Search existing papers in the library.",
      inputSchema: z.object({
        query: z.string(),
      }),
      execute: async ({ query }: { query: string }) => {
        const queryTerms = await processQuery(query);
        const papers = await prisma.paper.findMany({
          where: { userId },
          select: { title: true, abstract: true, summary: true, year: true },
        });

        const scored = papers.map((p) => {
          const text = `${p.title} ${p.abstract || ""} ${p.summary || ""}`;
          return { paper: p, score: scoreText(text, queryTerms) };
        })
          .filter((s) => s.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5);

        if (scored.length === 0) return `No papers match "${query}".`;

        return scored.map((s, i) =>
          `${i + 1}. "${s.paper.title}" (${s.paper.year || "?"})\n   ${(s.paper.summary || s.paper.abstract || "").slice(0, 200)}`
        ).join("\n\n");
      },
    }),
  };
}

// ── Shared library tools (read-only) ────────────────────────────
// Used by: reviewer, synthesizer, architect

function libraryTools(userId: string) {
  return {
    read_paper: tool({
      description: "Read a paper's abstract, summary, and key findings.",
      inputSchema: z.object({
        title: z.string().describe("Title or partial title"),
      }),
      execute: async ({ title }: { title: string }) => {
        const paper = await prisma.paper.findFirst({
          where: { userId, title: { contains: title } },
          select: {
            title: true, abstract: true, summary: true, keyFindings: true,
            authors: true, year: true, venue: true,
            insights: { select: { learning: true, significance: true } },
          },
        });
        if (!paper) return `Paper "${title}" not found in library.`;

        const parts = [`# ${paper.title}`];
        if (paper.authors) parts.push(`Authors: ${paper.authors}`);
        if (paper.year) parts.push(`Year: ${paper.year}`);
        if (paper.abstract) parts.push(`\n## Abstract\n${paper.abstract}`);
        if (paper.summary) parts.push(`\n## Summary\n${paper.summary}`);
        if (paper.keyFindings) parts.push(`\n## Key Findings\n${paper.keyFindings}`);
        if (paper.insights.length > 0) {
          parts.push(`\n## Insights\n${paper.insights.map((i) => `- ${i.learning}`).join("\n")}`);
        }
        return parts.join("\n");
      },
    }),

    search_library: tool({
      description: "Search the paper library for related work.",
      inputSchema: z.object({
        query: z.string(),
      }),
      execute: async ({ query }: { query: string }) => {
        const queryTerms = await processQuery(query);
        const papers = await prisma.paper.findMany({
          where: { userId },
          select: { title: true, abstract: true, summary: true, year: true },
        });

        const scored = papers.map((p) => {
          const text = `${p.title} ${p.abstract || ""} ${p.summary || ""}`;
          return { paper: p, score: scoreText(text, queryTerms) };
        })
          .filter((s) => s.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5);

        if (scored.length === 0) return `No papers match "${query}".`;

        return scored.map((s, i) =>
          `${i + 1}. "${s.paper.title}" (${s.paper.year || "?"})\n   ${(s.paper.summary || s.paper.abstract || "").slice(0, 200)}`
        ).join("\n\n");
      },
    }),

    query_skills: tool({
      description: "Retrieve reusable skill cards distilled from library insights. Returns trigger/mechanism/risk structure instead of raw notes.",
      inputSchema: z.object({
        query: z.string(),
        mode: z.enum(["exploit", "balanced", "explore"]).default("balanced").optional(),
      }),
      execute: async ({ query, mode }: { query: string; mode?: "exploit" | "balanced" | "explore" }) => {
        const { cards } = await querySkillCards({
          userId,
          query,
          mode: mode || "balanced",
          maxResults: 6,
          trackUsage: false,
        });
        if (cards.length === 0) return `No skill cards match "${query}".`;
        return formatSkillCards(cards);
      },
    }),

    query_insights: tool({
      description: "Search the Mind Palace for insights and techniques.",
      inputSchema: z.object({
        query: z.string(),
      }),
      execute: async ({ query }: { query: string }) => {
        const queryTerms = await processQuery(query);
        const insights = await prisma.insight.findMany({
          include: {
            paper: { select: { title: true, year: true } },
            room: { select: { name: true } },
          },
        });

        if (insights.length === 0) return "No insights in the Mind Palace yet.";

        const scored = insights.map((insight) => {
          const searchable = [
            insight.learning, insight.significance,
            insight.applications || "", insight.paper.title, insight.room.name,
          ].join(" ");
          return { insight, score: scoreText(searchable, queryTerms) };
        })
          .filter((s) => s.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 5);

        if (scored.length === 0) return `No insights match "${query}".`;

        return scored.map((s, i) =>
          `${i + 1}. [${s.insight.room.name}] "${s.insight.paper.title}" (${s.insight.paper.year || "?"})\n   ${s.insight.learning}\n   Significance: ${s.insight.significance}`
        ).join("\n\n");
      },
    }),
  };
}

// ── Provocateur tools (library + web search) ─────────────────────

function provocateurTools(userId: string) {
  return {
    ...libraryTools(userId),
    web_search: tool({
      description: "Search the web for techniques, concepts, and approaches from ANY field — not just ML papers. Use this to find inspiration from biology, physics, economics, control theory, etc.",
      inputSchema: z.object({
        query: z.string().describe("Search query — be creative, search outside ML"),
      }),
      execute: async ({ query }: { query: string }) => {
        const results = await searchDuckDuckGo(query, 6);
        if (results.length === 0) return `No results for "${query}".`;
        return results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n\n");
      },
    }),
  };
}

function reproducerTools(userId: string, workDir?: string) {
  return {
    ...libraryTools(userId),
    ...(workDir ? workdirTools(workDir) : {}),
  };
}

// ── Reviewer system prompt ───────────────────────────────────────

function reviewerSystemPrompt(focus: string): string {
  return `You are a skeptical, rigorous peer reviewer for a top-tier venue (NeurIPS, ICML, Nature). Your job is to find flaws, weaknesses, and gaps in the research presented to you.

## Your Mission
Review the following research content with focus on: "${focus}"

## Instructions
1. Read the submitted content carefully
2. Use \`read_paper\` and \`search_library\` to verify claims against the existing literature
3. Use \`query_insights\` and \`query_skills\` to check if known techniques or findings contradict the claims
4. Produce a structured, adversarial review

## Review Structure
1. **Summary**: One-sentence summary of what's being claimed
2. **Strengths**: What's well-done (be brief — 2-3 bullets max)
3. **Weaknesses**: Specific flaws, each with a concrete fix. Reference papers by name when possible.
4. **Missing**: What's absent that a reviewer would expect (baselines, ablations, statistical tests, related work)
5. **Alternative Explanations**: What else could explain these results?
6. **Verdict**: Overall assessment and the 3 highest-priority fixes

Be harsh but fair. Vague praise is useless. Specific criticism saves months of wasted work.
${reviewJsonInstructions()}`;
}

// ── Reproducer system prompt ─────────────────────────────────────

function reproducerSystemPrompt(focus: string, hasWorkspaceAccess: boolean): string {
  return `You are a reproduction auditor. Your job is to verify whether specific research claims actually hold up against the recorded runs, files, and evidence available in this project.

## Focus
${focus}

## Instructions
1. Read the claim context carefully.
2. Use \`read_paper\`, \`search_library\`, \`query_insights\`, and \`query_skills\` when literature context matters.
3. ${hasWorkspaceAccess ? "Use `list_files`, `read_file`, and `run_command` to inspect result files, scripts, and generated artifacts in the workspace." : "If no workspace files are available, stay evidence-bounded to the supplied context and library."}
4. Distinguish between:
   - actually reproduced
   - merely plausible
   - contradicted by the recorded evidence
5. Be conservative. If the evidence is incomplete, say so explicitly.

## Output Format
1. **Audit Scope**: What claim(s) you checked
2. **What You Verified**: Files, runs, or papers examined
3. **Findings**: What the evidence supports or fails to support
4. **Gaps**: What would still need to be rerun or checked
5. **Verdict**: Your bottom-line judgment

Only mark a claim \`REPRODUCED\` if the available evidence genuinely verifies it.
${reviewJsonInstructions()}`;
}

// (Reviewer uses libraryTools — defined above)

// ── Experimenter system prompt ──────────────────────────────────

function experimenterSystemPrompt(goal: string, workDir: string): string {
  return `You are a focused experiment runner. You execute a specific experiment and report structured results.

## Your Mission
${goal}

## Working Directory
${workDir}

## Instructions
1. Use \`list_files\` to understand the project layout
2. Use \`read_file\` to read experiment scripts and configs
3. If needed, use \`write_file\` to create or modify experiment scripts
4. Use \`run_command\` to execute the experiment
5. Use \`read_file\` to read output files and logs
6. Report structured results

## Output Format
Return a structured summary:
- **Setup**: What was configured and run
- **Results**: Key metrics, numbers, and outcomes
- **Logs**: Any errors or warnings encountered
- **Files**: Output files created (paths and brief description)
- **Assessment**: Did the experiment succeed? What do the results mean?

Be precise — include exact numbers, file paths, and command outputs.`;
}

// ── Shared workdir tools ────────────────────────────────────────
// Used by: experimenter, analyst

function workdirTools(workDir: string) {
  return {
    run_command: tool({
      description: "Run a shell command in the experiment directory. For pip install, python scripts, data processing, etc.",
      inputSchema: z.object({
        command: z.string().describe("Shell command to run"),
        timeout_seconds: z.number().default(300).optional().describe("Max execution time (default 300s)"),
      }),
      execute: async ({ command, timeout_seconds }: { command: string; timeout_seconds?: number }) => {
        const timeoutMs = (timeout_seconds || 300) * 1000;
        try {
          const { stdout, stderr } = await execAsync(command, {
            cwd: workDir,
            timeout: timeoutMs,
            env: { ...process.env, PYTHONUNBUFFERED: "1" },
            maxBuffer: 5 * 1024 * 1024,
          });
          const parts: string[] = [];
          if (stdout) parts.push(`stdout:\n${stdout.slice(-3000)}`);
          if (stderr) parts.push(`stderr:\n${stderr.slice(-1000)}`);
          return parts.join("\n\n") || "(no output)";
        } catch (err) {
          const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean; message?: string };
          if (e.killed) return `Command timed out after ${timeout_seconds || 300}s.\nstdout: ${(e.stdout || "").slice(-1000)}\nstderr: ${(e.stderr || "").slice(-500)}`;
          return `Exit code ${e.code || 1}\nstdout: ${(e.stdout || "").slice(-2000)}\nstderr: ${(e.stderr || "").slice(-1000)}`;
        }
      },
    }),

    read_file: tool({
      description: "Read a file from the experiment directory.",
      inputSchema: z.object({
        filepath: z.string().describe("Relative path within the experiment directory"),
      }),
      execute: async ({ filepath }: { filepath: string }) => {
        const fs = await import("fs/promises");
        const fullPath = resolveWorkdirPath(workDir, filepath);
        if (!fullPath) return "Error: path escapes experiment directory.";
        try {
          const handle = await fs.open(fullPath, "r");
          const content = await handle.readFile("utf-8");
          await handle.close();
          if (content.length > 10000) {
            return `${content.slice(0, 5000)}\n\n... [truncated ${content.length - 10000} chars] ...\n\n${content.slice(-5000)}`;
          }
          return content;
        } catch {
          return `File not found: ${filepath}`;
        }
      },
    }),

    write_file: tool({
      description: "Write a file to the experiment directory.",
      inputSchema: z.object({
        filepath: z.string().describe("Relative path within the experiment directory"),
        content: z.string().describe("File content"),
      }),
      execute: async ({ filepath, content }: { filepath: string; content: string }) => {
        const fs = await import("fs/promises");
        const fullPath = resolveWorkdirPath(workDir, filepath);
        if (!fullPath) return "Error: path escapes experiment directory.";
        await fs.writeFile(fullPath, content, "utf-8");
        return `Wrote ${content.length} bytes to ${filepath}`;
      },
    }),

    list_files: tool({
      description: "List files in a directory within the experiment workspace.",
      inputSchema: z.object({
        dir: z.string().default(".").optional().describe("Relative directory path (default: root)"),
      }),
      execute: async ({ dir }: { dir?: string }) => {
        const fs = await import("fs/promises");
        const fullPath = resolveWorkdirPath(workDir, dir || ".");
        if (!fullPath) return "Error: path escapes experiment directory.";
        try {
          const entries = await fs.readdir(fullPath);
          const details = await Promise.all(
            entries.slice(0, 50).map(async (name) => {
              try {
                const s = await fs.stat(`${trimTrailingSeparators(fullPath)}/${name}`);
                return `${s.isDirectory() ? "d" : "-"} ${name}${s.isDirectory() ? "/" : ""} (${s.size}B)`;
              } catch {
                return `? ${name}`;
              }
            }),
          );
          return details.join("\n") + (entries.length > 50 ? `\n... and ${entries.length - 50} more` : "");
        } catch {
          return `Directory not found: ${dir || "."}`;
        }
      },
    }),
  };
}

// ── Synthesizer system prompt ───────────────────────────────────

function synthesizerSystemPrompt(focus: string, paperTitles: string[]): string {
  const papersSection = paperTitles.length > 0
    ? `\n## Papers to Analyze\n${paperTitles.map((t, i) => `${i + 1}. "${t}"`).join("\n")}\n\nRead each of these papers using \`read_paper\`, then synthesize across them.`
    : `\n## Finding Papers\nNo specific papers provided. Use \`search_library\` to find papers related to the focus area, then read the most relevant ones.`;

  return `You are a deep synthesis agent. Your job is to read multiple papers and find what no individual reading reveals: contradictions, complementary techniques, and unexplored combinations.

## Focus
${focus}
${papersSection}

## Instructions
1. Read each paper thoroughly using \`read_paper\`
2. Use \`query_insights\` and \`query_skills\` to find related techniques and known results
3. Use \`search_library\` if you need to find additional related work
4. Produce a structured cross-paper analysis

## Output Format
Your response MUST include these sections:
- **Agreements**: What do these papers converge on? (methods, findings, assumptions)
- **Contradictions**: Where do they disagree? Which has stronger evidence? Be specific — cite paper titles.
- **Complementary Techniques**: Methods from different papers that could be combined but haven't been. For each pair, explain WHY they're complementary.
- **Gaps**: What none of them address
- **Unexplored Combinations**: Specific pairs of techniques that should work together, with theoretical reasoning for why

Be specific — reference papers by name, cite specific techniques and numbers. Vague synthesis is useless.`;
}

// ── Analyst system prompt ───────────────────────────────────────

function analystSystemPrompt(diagnosisType: string, workDir: string): string {
  const diagnosisGuide =
    diagnosisType === "attention"
      ? `Focus on attention analysis:
- Compute attention head importance scores (e.g., head masking or Taylor expansion)
- Calculate pairwise cosine similarity between attention heads to find redundant pairs
- Measure attention entropy per head per layer (low entropy = degenerate attention)
- Save all numerical results to JSON files`
      : diagnosisType === "gradient"
      ? `Focus on gradient analysis:
- Compute layer-wise gradient L2 norms during a forward+backward pass
- Count dead neurons per layer (activation = 0 on >95% of inputs)
- Check for vanishing gradients (norm < 1e-7) or exploding gradients (norm > 1e3)
- Save all numerical results to JSON files`
      : diagnosisType === "errors"
      ? `Focus on error analysis:
- Generate a confusion matrix on the validation/test set
- Compute per-class accuracy and find worst-performing classes
- Extract 10-20 specific examples the model gets wrong — include input, predicted, and actual
- Save all results to JSON files`
      : `Run general diagnostics (abbreviated versions of all):
- Attention head entropy (if attention model)
- Layer-wise gradient norms
- Confusion matrix and per-class accuracy
- 10 worst error examples
- Save all results to JSON files`;

  return `You are a focused experiment diagnostician. You write and run diagnostic scripts to produce RAW DATA about model behavior. You do NOT interpret the results — you report numbers and let the architect interpret them.

## Working Directory
${workDir}

## Diagnosis Type
${diagnosisGuide}

## Instructions
1. Use \`read_file\` to understand the experiment code and results
2. Use \`list_files\` to find model checkpoints and output files
3. Write diagnostic scripts with \`write_file\` — keep them focused and short
4. Run them with \`run_command\`
5. Read the output files and report the raw numbers

## CRITICAL: Report Data, Not Interpretations
Your job is to produce NUMBERS. Do not say "the model seems to struggle with X" — instead say "class X accuracy = 0.23, compared to mean accuracy 0.71." The architect will interpret these numbers in context of the literature.

## Output Format
End your response with a structured summary containing:
- **Diagnosis Type**: What diagnostics were run
- **Raw Data**: Key numbers, matrices, scores (inline or reference files)
- **Diagnostic Files**: Paths to saved JSON/CSV files
- **Summary**: One-paragraph factual summary of what the numbers show (no interpretation)`;
}

// ── Architect system prompt ─────────────────────────────────────

function architectSystemPrompt(goal: string): string {
  return `You are a research architect. You combine insights from literature synthesis and experimental diagnostics to propose NOVEL approaches. You are creative but disciplined — every proposal must be grounded in evidence and include a cheap validation experiment.

## Research Goal
${goal}

## Instructions
1. Read the synthesis and diagnostic reports provided to you
2. Use \`read_paper\` to look up specific implementation details when needed
3. Use \`query_insights\` and \`query_skills\` to find related techniques
4. Propose 2-3 novel approaches

## CRITICAL CONSTRAINTS
- Your proposals will be IMPLEMENTED AND RUN. Bad proposals waste GPU hours and research time.
- Be honest about risk. If you're uncertain, say so.
- ALWAYS propose a cheap validation experiment before a full training run.
- Every proposal must reference specific papers or diagnostic findings as justification.

## Output Format
For each approach:

**Approach N: [Descriptive Name]** (Risk: low|medium|high, Cost: trivial|small|medium|large)
- **Inspiration**: Which papers/findings led to this idea (be specific — paper titles, section numbers)
- **Core Idea**: 1-2 sentences
- **Implementation Sketch**: Specific code changes needed (not full code, but precise enough to implement — e.g., "replace the standard MultiHeadAttention with a gated variant where each head has a learned sigmoid gate on the query projection")
- **Why It Should Work**: Theoretical argument grounded in the literature
- **Risks**: What could go wrong, and how you'd detect it
- **Validation Experiment**: A SMALL, CHEAP experiment that tests the core idea (e.g., "train for 1 epoch on 10% of data and compare head utilization before/after gating")

End with:
**Recommendation**: Which approach to try first and why. Always recommend starting with the cheapest validation experiment.`;
}

// ── Provocateur system prompt ────────────────────────────────────

function provocateurSystemPrompt(currentTrajectory: string): string {
  return `You are a creative research provocateur — a lateral thinker who deliberately breaks from conventional trajectories. The researchers have been following a specific path. Your job is to suggest approaches they would NEVER think of on their own.

## The Current Trajectory
${currentTrajectory}

## Your Mission
Propose 3 wildly different directions. For each:
- Draw from a DIFFERENT field (biology, physics, economics, art, control theory, game theory, information theory, ecology, etc.)
- Find a specific analogy or technique from that field that maps to this problem
- Be concrete: name the technique, cite real work (even outside ML), sketch how it would be applied

## Rules
- Do NOT suggest incremental improvements to the current approach
- Do NOT suggest things the researchers probably already know (standard ML techniques, obvious baselines)
- DO search the web for inspiration from other fields — the best ideas come from unexpected connections
- DO search the library to understand what's already been tried, so you can avoid repeating it
- Be bold. Some ideas should make the researchers uncomfortable. That's the point.
- For each idea, include: WHY it might work (the conceptual bridge), and a quick 1-day experiment to test the core insight

## Output Format
For each direction:

**Direction N: [Provocative Name]**
- **Inspired by**: [Field] — [specific technique/paper/concept]
- **The Analogy**: How this maps to the current research problem (1-2 sentences)
- **The Idea**: What to actually do (be specific enough to implement)
- **Why This Might Work**: The conceptual bridge (why the analogy is more than superficial)
- **Why This Might Fail**: Be honest about the risks
- **Quick Test**: A 1-day experiment to check the core insight

End with: **My top pick and why** — which direction has the best risk/reward ratio.`;
}

// ── Role configuration ──────────────────────────────────────────

type ModelTier = "reasoning" | "standard";

interface RoleConfig {
  tier: ModelTier;
  maxSteps: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getTools: (input: Record<string, any>) => Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getSystemPrompt: (input: Record<string, any>, goal: string) => string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getUserMessage: (input: Record<string, any>, goal: string) => string;
}

const ROLE_CONFIG: Record<string, RoleConfig> = {
  scout: {
    tier: "standard",
    maxSteps: 15,
    getTools: (input) => scoutTools(input.userId || "system", input.projectId || "", input.bannedPapers),
    getSystemPrompt: (input, goal) => scoutSystemPrompt(input.angle || goal, input.keywords || []),
    getUserMessage: (input, goal) => {
      const angle = input.angle || goal;
      const keywords: string[] = input.keywords || [];
      return `Search for papers on: ${angle}\nKeywords: ${keywords.join(", ")}\n\nFind relevant papers, read the most promising ones, and provide a structured summary of what the literature says about this angle.`;
    },
  },
  reviewer: {
    tier: "reasoning",
    maxSteps: 10,
    getTools: (input) => libraryTools(input.userId || "system"),
    getSystemPrompt: (input) => reviewerSystemPrompt(input.focus || "general"),
    getUserMessage: (input, goal) => {
      const parts = [input.content || goal];
      if (Array.isArray(input.claims) && input.claims.length > 0) {
        parts.push(`\n## Claims Under Review\n${input.claims.map((claim: { id: string; statement: string; status: string; summary?: string | null }) =>
          `- ID: ${claim.id}\n  Statement: ${claim.statement}\n  Current status: ${claim.status}${claim.summary ? `\n  Summary: ${claim.summary}` : ""}`
        ).join("\n")}`);
      }
      return parts.join("\n");
    },
  },
  reproducer: {
    tier: "reasoning",
    maxSteps: 12,
    getTools: (input) => reproducerTools(input.userId || "system", input.workDir),
    getSystemPrompt: (input) => reproducerSystemPrompt(input.focus || "replication", Boolean(input.workDir)),
    getUserMessage: (input, goal) => {
      const parts = [input.content || goal];
      if (Array.isArray(input.claims) && input.claims.length > 0) {
        parts.push(`\n## Claims To Audit\n${input.claims.map((claim: { id: string; statement: string; status: string; summary?: string | null }) =>
          `- ID: ${claim.id}\n  Statement: ${claim.statement}\n  Current status: ${claim.status}${claim.summary ? `\n  Summary: ${claim.summary}` : ""}`
        ).join("\n")}`);
      }
      if (input.workDir) parts.push(`\n## Workspace\n${input.workDir}`);
      return parts.join("\n");
    },
  },
  // experimenter: Disabled — the main agent handles experiments directly via execute_command/execute_remote.
  // Revisit if we need truly independent background experiment runners.
  // experimenter: {
  //   tier: "standard",
  //   maxSteps: 20,
  //   getTools: (input) => {
  //     if (!input.workDir) throw new Error("Experimenter requires workDir in input");
  //     return workdirTools(input.workDir);
  //   },
  //   getSystemPrompt: (input, goal) => experimenterSystemPrompt(goal, input.workDir),
  //   getUserMessage: (input, goal) => input.instructions || goal,
  // },
  synthesizer: {
    tier: "reasoning",
    maxSteps: 15,
    getTools: (input) => libraryTools(input.userId || "system"),
    getSystemPrompt: (input, goal) => synthesizerSystemPrompt(input.focus || goal, input.papers || []),
    getUserMessage: (input, goal) => {
      const papers: string[] = input.papers || [];
      const focus = input.focus || goal;
      return papers.length > 0
        ? `Synthesize across these ${papers.length} papers with focus on: ${focus}\n\nPapers: ${papers.map((p: string) => `"${p}"`).join(", ")}`
        : `Find and synthesize papers related to: ${focus}`;
    },
  },
  // analyst: Disabled — never used in practice. The main agent reads experiment results directly.
  // Revisit if we need structured diagnostic pipelines (attention analysis, gradient flow, etc.)
  // analyst: {
  //   tier: "standard",
  //   maxSteps: 20,
  //   getTools: (input) => {
  //     if (!input.workDir) throw new Error("Analyst requires workDir in input");
  //     return workdirTools(input.workDir);
  //   },
  //   getSystemPrompt: (input, _goal) => analystSystemPrompt(input.diagnosis_type || "general", input.workDir),
  //   getUserMessage: (input, goal) => {
  //     const parts = [goal];
  //     if (input.experiment_script) parts.push(`Experiment script: ${input.experiment_script}`);
  //     if (input.results_path) parts.push(`Results file: ${input.results_path}`);
  //     if (input.model_path) parts.push(`Model checkpoint: ${input.model_path}`);
  //     if (input.instructions) parts.push(`\nAdditional instructions: ${input.instructions}`);
  //     return parts.join("\n");
  //   },
  // },
  architect: {
    tier: "reasoning",
    maxSteps: 12,
    getTools: (input) => libraryTools(input.userId || "system"),
    getSystemPrompt: (input, goal) => architectSystemPrompt(input.goal || goal),
    getUserMessage: (input, goal) => {
      const parts = [`Research goal: ${input.goal || goal}`];
      if (input.synthesis) parts.push(`\n## Synthesis Report\n${input.synthesis}`);
      if (input.diagnostics) parts.push(`\n## Diagnostic Data\n${input.diagnostics}`);
      if (input.current_approach) parts.push(`\n## Current Approach & Results\n${input.current_approach}`);
      return parts.join("\n");
    },
  },
  visualizer: {
    tier: "standard",
    maxSteps: 15,
    getTools: (input) => {
      if (!input.workDir) throw new Error("Visualizer requires workDir in input");
      return workdirTools(input.workDir);
    },
    getSystemPrompt: (_input, goal) => `You are a research visualization specialist. Your job is to create publication-quality figures from experiment results.

## Your Mission
${goal}

## Instructions
1. Read the result files (JSON, CSV) using read_file to understand the data
2. Write a Python plotting script that generates clean, informative figures
3. Run the script to produce the figures
4. Report what figures were created and what they show

## Plotting Standards
- Use matplotlib with a clean style (plt.style.use('seaborn-v0_8-paper') or similar)
- Font size 12+ for readability
- Clear axis labels with units
- Legend when multiple series
- Error bars (std/CI) when available
- Save as both PNG (300 DPI) and PDF
- Use colorblind-friendly palettes (tab10, Set2)

## Figure Types to Consider
- **Training curves**: loss, reward, accuracy over steps/epochs
- **Comparison bars**: method A vs B vs C with error bars
- **Heatmaps**: credit weights, attention patterns, correlation matrices
- **Scatter plots**: correlation between metrics
- **Distribution plots**: histogram/KDE of scores, rewards
- **Ablation tables**: rendered as clean bar charts

## Output
Name figures descriptively: \`fig_loss_curve.png\`, \`fig_method_comparison.png\`, etc.
Print a summary of each figure created and what it shows.`,
    getUserMessage: (input, goal) => {
      const parts = [goal];
      if (input.resultFiles) parts.push(`\nResult files to visualize: ${input.resultFiles}`);
      if (input.metrics) parts.push(`\nKey metrics: ${input.metrics}`);
      return parts.join("\n");
    },
  },
  provocateur: {
    tier: "reasoning",
    maxSteps: 12,
    getTools: (input) => provocateurTools(input.userId || "system"),
    getSystemPrompt: (input, goal) => provocateurSystemPrompt(input.trajectory || goal),
    getUserMessage: (input, goal) => {
      const parts = [`Research area: ${goal}`];
      if (input.trajectory) parts.push(`\n## Current Trajectory\n${input.trajectory}`);
      if (input.stuck_on) parts.push(`\n## Stuck On\n${input.stuck_on}`);
      return parts.join("\n") + "\n\nBreak the mold. Surprise me.";
    },
  },
};

// ── Main runner ─────────────────────────────────────────────────

export async function runSubAgent(taskId: string): Promise<void> {
  if (!(prisma as unknown as Record<string, unknown>).agentTask) {
    throw new Error("AgentTask model not available on Prisma client — restart dev server");
  }
  const task = await prisma.agentTask.findUnique({ where: { id: taskId } });
  if (!task) throw new Error(`AgentTask ${taskId} not found`);

  // Mark as running
  await prisma.agentTask.update({
    where: { id: taskId },
    data: { status: "RUNNING" },
  });

  try {
    // Parse input and attach projectId for role configs
    const input = task.input ? JSON.parse(task.input) : {};
    input.projectId = task.projectId;

    // Look up role config — unknown roles throw instead of silent fallthrough
    const config = ROLE_CONFIG[task.role];
    if (!config) throw new Error(`Unknown sub-agent role: "${task.role}". Valid roles: ${Object.keys(ROLE_CONFIG).join(", ")}`);

    // Select model tier
    const { provider, modelId, proxyConfig } = await getModelForTier(config.tier);
    const model = await getToolLoopModel(provider, modelId, proxyConfig);
    setLlmContext(`sub-agent-${task.role}`, "system", { projectId: task.projectId, taskId });

    // Build tools, prompt, and user message from role config
    const tools = config.getTools(input);
    const systemPrompt = config.getSystemPrompt(input, task.goal);
    const userMessage = config.getUserMessage(input, task.goal);
    const maxSteps = config.maxSteps;

    // Use streamText (not generateText) so the proxy gateway sees data flowing
    // and doesn't time out. We collect the full result at the end.
    // Retry with backoff — sub-agents often fail from rate limits when 3-4 run in parallel
    let text = "";
    let stepsUsed = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const MAX_RETRIES = 3;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const stream = streamText({
          model,
          system: systemPrompt,
          messages: [{ role: "user", content: userMessage }],
          tools,
          stopWhen: stepCountIs(maxSteps),
        });

        // Consume the stream to keep the connection alive
        text = await stream.text;
        const usage = await stream.usage;
        const steps = await stream.steps;
        stepsUsed = steps?.length || 0;
        totalInputTokens = usage?.inputTokens || 0;
        totalOutputTokens = usage?.outputTokens || 0;
        break; // Success
      } catch (retryErr) {
        const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        console.warn(`[sub-agent] Task ${taskId} attempt ${attempt}/${MAX_RETRIES} failed: ${msg}`);
        if (attempt === MAX_RETRIES) throw retryErr;
        // Exponential backoff: 5s, 15s, 45s
        await new Promise((r) => setTimeout(r, 5000 * Math.pow(3, attempt - 1)));
      }
    }

    // Save output
    const claimReviews = task.role === "reviewer" || task.role === "reproducer"
      ? extractStructuredClaimReviews(text)
      : [];

    const output = {
      summary: text,
      stepsUsed,
      tokenUsage: { inputTokens: totalInputTokens, outputTokens: totalOutputTokens },
      claimReviews,
    };

    const totalTokens = totalInputTokens + totalOutputTokens;

    await prisma.agentTask.update({
      where: { id: taskId },
      data: {
        status: "COMPLETED",
        output: JSON.stringify(output),
        tokenUsage: totalTokens || null,
        completedAt: new Date(),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sub-agent failed";
    console.error(`[sub-agent] Task ${taskId} failed:`, message);

    await prisma.agentTask.update({
      where: { id: taskId },
      data: {
        status: "FAILED",
        error: message.slice(0, 1000),
        completedAt: new Date(),
      },
    });
  }
}
