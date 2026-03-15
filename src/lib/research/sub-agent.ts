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

import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { getModel } from "@/lib/llm/provider";
import { getDefaultModel } from "@/lib/llm/auto-process";
import { setLlmContext } from "@/lib/llm/provider";
import { prisma } from "@/lib/prisma";
import { searchAllSources } from "@/lib/import/semantic-scholar";

// ── Scout system prompt ─────────────────────────────────────────

function scoutSystemPrompt(angle: string, keywords: string[]): string {
  return `You are a focused literature scout — a specialist researcher tasked with finding and summarizing papers on a specific angle of a research topic.

## Your Mission
Search for papers related to: "${angle}"
Keywords to try: ${keywords.join(", ")}

## Instructions
1. Search for papers using 2-3 different queries (vary keywords, try synonyms)
2. For the most relevant results, read them to extract key methods, datasets, findings, and specific numbers
3. Synthesize what you found into a structured summary

## Output Format
When you have gathered enough information (or exhausted your search budget), return a final summary with:
- **Key Papers**: List of the most relevant papers with their main contributions
- **Methods**: Specific techniques and approaches found
- **Datasets**: Any benchmark datasets mentioned
- **Key Numbers**: Specific performance numbers, baselines, or thresholds
- **Gaps**: What the literature doesn't address or disagrees on
- **Recommendations**: Which papers the lead researcher should read in detail

Be specific — include paper titles, author names, years, and concrete numbers. Vague summaries are useless.`;
}

// ── Sub-agent tool sets ─────────────────────────────────────────

function scoutTools(userId: string, projectId: string) {
  return {
    search_papers: tool({
      description: "Search academic databases for papers.",
      inputSchema: z.object({
        query: z.string(),
        max_results: z.number().min(1).max(10).default(5).optional(),
      }),
      execute: async ({ query, max_results }: { query: string; max_results?: number }) => {
        const results = await searchAllSources(query);
        const toShow = results.slice(0, max_results || 5);
        if (toShow.length === 0) return "No papers found.";

        // Auto-import to project collection
        const proj = await prisma.researchProject.findUnique({
          where: { id: projectId },
          select: { collectionId: true, title: true },
        });
        let collectionId = proj?.collectionId;
        if (!collectionId) {
          const col = await prisma.collection.create({
            data: { name: `Research: ${proj?.title || "Project"}` },
          });
          collectionId = col.id;
          await prisma.researchProject.update({
            where: { id: projectId },
            data: { collectionId },
          });
        }

        const imported: string[] = [];
        for (const r of toShow) {
          try {
            // Check duplicates
            let existing: { id: string } | null = null;
            if (r.doi || r.arxivId) {
              existing = await prisma.paper.findFirst({
                where: {
                  userId,
                  OR: [
                    ...(r.doi ? [{ doi: r.doi }] : []),
                    ...(r.arxivId ? [{ arxivId: r.arxivId }] : []),
                  ],
                },
                select: { id: true },
              });
            }
            if (!existing && r.title) {
              const normTitle = r.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
              const candidates = await prisma.paper.findMany({
                where: { userId },
                select: { id: true, title: true },
              });
              existing = candidates.find((c) => {
                const ct = c.title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
                return ct === normTitle;
              }) || null;
            }

            if (existing) {
              await prisma.collectionPaper.upsert({
                where: { paperId_collectionId: { collectionId, paperId: existing.id } },
                create: { collectionId, paperId: existing.id },
                update: {},
              });
              imported.push(`"${r.title}" (already in library)`);
            } else {
              const paper = await prisma.paper.create({
                data: {
                  title: r.title, userId,
                  abstract: r.abstract ?? null,
                  authors: r.authors ? JSON.stringify(r.authors) : null,
                  year: r.year ?? null, venue: r.venue ?? null,
                  doi: r.doi ?? null,
                  arxivId: r.arxivId ?? null,
                  sourceType: r.arxivId ? "ARXIV" : "RESEARCH",
                  sourceUrl: r.externalUrl ?? null,
                  processingStatus: "PENDING",
                },
              });
              await prisma.collectionPaper.create({ data: { collectionId, paperId: paper.id } });
              imported.push(`"${r.title}" (${r.year || "?"}) — ${r.citationCount || 0} citations${r.abstract ? `\n  Abstract: ${r.abstract.slice(0, 300)}` : ""}`);
            }
          } catch {
            imported.push(`"${r.title}" — import failed`);
          }
        }

        return `Found ${imported.length} papers:\n\n${imported.join("\n\n")}`;
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
            authors: true, year: true, venue: true,
            insights: { select: { learning: true, significance: true } },
          },
        });
        if (!paper) return `Paper "${title}" not found.`;

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
        const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
        const papers = await prisma.paper.findMany({
          where: { userId },
          select: { title: true, abstract: true, summary: true, year: true },
        });

        const scored = papers.map((p) => {
          const text = `${p.title} ${p.abstract || ""} ${p.summary || ""}`.toLowerCase();
          let score = 0;
          for (const t of queryTerms) {
            score += (text.match(new RegExp(t, "g")) || []).length;
          }
          return { paper: p, score };
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
    const { provider, modelId, proxyConfig } = await getDefaultModel();
    const model = await getModel(provider, modelId, proxyConfig);
    setLlmContext("sub-agent-scout", "system", { projectId: task.projectId, taskId });

    // Parse input
    const input = task.input ? JSON.parse(task.input) : {};
    const angle = input.angle || task.goal;
    const keywords: string[] = input.keywords || [];

    // Build tools based on role
    const tools = task.role === "scout"
      ? scoutTools(input.userId || "system", task.projectId)
      : scoutTools(input.userId || "system", task.projectId); // extensible for future roles

    const systemPrompt = task.role === "scout"
      ? scoutSystemPrompt(angle, keywords)
      : scoutSystemPrompt(angle, keywords);

    const result = await generateText({
      model,
      system: systemPrompt,
      messages: [
        { role: "user", content: `Search for papers on: ${angle}\nKeywords: ${keywords.join(", ")}\n\nFind relevant papers, read the most promising ones, and provide a structured summary of what the literature says about this angle.` },
      ],
      tools,
      stopWhen: stepCountIs(15),
    });

    // Save output
    const output = {
      angle,
      keywords,
      summary: result.text,
      stepsUsed: result.steps?.length || 0,
      tokenUsage: result.usage ? {
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      } : null,
    };

    const totalTokens = (result.usage?.inputTokens || 0) + (result.usage?.outputTokens || 0);

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
