import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";
import { getModelForTier } from "@/lib/llm/auto-process";
import { getModel, setLlmContext } from "@/lib/llm/provider";
import { streamText } from "ai";
import { readFile } from "fs/promises";
import path from "path";

export const maxDuration = 120;

type Params = { params: Promise<{ id: string }> };

/**
 * POST — Chat with a research project's accumulated knowledge.
 * Streams a response grounded in the project's papers, hypotheses,
 * experiments, findings, and research log.
 */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;

    const body = await request.json();
    const { messages } = body as { messages: { role: "user" | "assistant"; content: string }[] };

    if (!messages?.length) {
      return NextResponse.json({ error: "Messages required" }, { status: 400 });
    }

    const project = await prisma.researchProject.findFirst({
      where: { id, userId },
      include: {
        iterations: {
          orderBy: { number: "desc" },
          include: { steps: { orderBy: { sortOrder: "asc" } } },
        },
        hypotheses: { orderBy: { createdAt: "desc" } },
        log: {
          orderBy: { createdAt: "desc" },
          take: 200,
        },
        collection: {
          include: {
            papers: {
              include: {
                paper: { select: { id: true, title: true, authors: true, year: true, summary: true, abstract: true } },
              },
            },
          },
        },
      },
    });

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // Build rich context from all project data
    const papers = project.collection?.papers.map((cp) => cp.paper) || [];
    const contextParts: string[] = [];

    // Project overview
    contextParts.push(`# Research Project: ${project.title}`);
    contextParts.push(`Status: ${project.status} | Phase: ${project.currentPhase} | Methodology: ${project.methodology || "experimental"}`);

    try {
      const brief = JSON.parse(project.brief);
      if (brief.question) contextParts.push(`Research question: ${brief.question}`);
      if (brief.constraints) contextParts.push(`Constraints: ${brief.constraints}`);
    } catch { /* plain text */ }

    // Papers
    if (papers.length > 0) {
      contextParts.push(`\n## Papers (${papers.length})`);
      for (const p of papers.slice(0, 30)) {
        const authors = p.authors ? JSON.parse(p.authors).slice(0, 3).join(", ") : "";
        contextParts.push(`- ${p.title} (${authors}, ${p.year || "?"})`);
        if (p.summary) contextParts.push(`  Summary: ${p.summary.slice(0, 300)}`);
      }
    }

    // Hypotheses
    if (project.hypotheses.length > 0) {
      contextParts.push(`\n## Hypotheses`);
      for (const h of project.hypotheses) {
        contextParts.push(`- [${h.status}] ${h.statement}`);
        if (h.evidence) contextParts.push(`  Evidence: ${h.evidence.slice(0, 300)}`);
      }
    }

    // All steps across iterations
    const allSteps: { type: string; title: string; status: string; output: string | null; iteration: number }[] = [];
    for (const iter of project.iterations) {
      for (const step of iter.steps) {
        allSteps.push({ ...step, iteration: iter.number });
      }
    }

    const experiments = allSteps.filter((s) => s.type === "run_experiment" || s.type === "generate_code");
    if (experiments.length > 0) {
      contextParts.push(`\n## Experiments (${experiments.length})`);
      for (const exp of experiments) {
        const statusEmoji = exp.status === "COMPLETED" ? "done" : exp.status === "FAILED" ? "FAILED" : exp.status;
        contextParts.push(`- [iter ${exp.iteration}] ${exp.title} — ${statusEmoji}`);
        if (exp.output) {
          try {
            const out = JSON.parse(exp.output);
            const stdout = out.stdout || out.analysis || "";
            if (stdout) contextParts.push(`  Output: ${stdout.slice(0, 500)}`);
          } catch {
            contextParts.push(`  Output: ${exp.output.slice(0, 500)}`);
          }
        }
      }
    }

    // Remote job results (experiments run on GPU servers)
    const remoteJobs = await prisma.remoteJob.findMany({
      where: { projectId: id },
      orderBy: { createdAt: "desc" },
      take: 30,
      select: { command: true, status: true, exitCode: true, stdout: true, stderr: true, completedAt: true },
    });
    if (remoteJobs.length > 0) {
      contextParts.push(`\n## Remote Jobs (${remoteJobs.length} recent)`);
      for (const job of remoteJobs) {
        const script = job.command?.match(/python3?\s+(\S+\.py)/)?.[1] || job.command?.slice(0, 60) || "?";
        contextParts.push(`- ${script} — ${job.status}${job.exitCode != null ? ` (exit ${job.exitCode})` : ""}`);
        if (job.stdout && job.status === "COMPLETED") {
          contextParts.push(`  Output: ${job.stdout.slice(-600)}`);
        }
        if (job.stderr && job.status === "FAILED") {
          contextParts.push(`  Error: ${job.stderr.slice(-400)}`);
        }
      }
    }

    // Key findings from research log
    if (project.log.length > 0) {
      contextParts.push(`\n## Research Log (recent ${project.log.length} entries)`);
      for (const entry of project.log.slice(0, 50)) {
        const prefix = entry.type === "breakthrough" ? "BREAKTHROUGH" : entry.type === "dead_end" ? "DEAD END" : entry.type;
        contextParts.push(`- [${prefix}] ${entry.content.slice(0, 400)}`);
      }
    }

    // Try to load RESEARCH_LOG.md
    const slug = project.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);
    const workDir = path.join(process.cwd(), "output", "research", `${slug}-${id.slice(0, 8)}`);
    try {
      const logMd = await readFile(path.join(workDir, "RESEARCH_LOG.md"), "utf-8");
      if (logMd.length > 200) {
        contextParts.push(`\n## RESEARCH_LOG.md\n${logMd.slice(0, 8000)}`);
      }
    } catch { /* no log file */ }

    const context = contextParts.join("\n");

    // Use standard tier (Sonnet) — this is a Q&A chat, not critical reasoning
    const { provider, modelId, proxyConfig } = await getModelForTier("standard");
    const model = await getModel(provider, modelId, proxyConfig);
    setLlmContext("research-chat", userId, { projectId: id });

    const result = streamText({
      model,
      system: `You are a research assistant helping the user understand and leverage the findings from their research project. You have access to all the project's data: papers, hypotheses, experiments, results, and the research log.

Be specific and grounded — cite experiment names, paper titles, and actual results when answering. If the user asks about methods, reference the actual code and approaches used. If they ask what worked and what didn't, give concrete examples with data.

When recommending how to transfer findings to another project, be practical: list specific techniques, hyperparameters, architectures, and approaches that showed promise, and warn about dead ends to avoid.

Format your responses with markdown: use headers, bullet points, bold for emphasis. Be concise but thorough.

${context}`,
      messages,
    });

    return result.toTextStreamResponse();
  } catch (err) {
    console.error("[research/chat] POST error:", err);
    return NextResponse.json({ error: "Chat failed" }, { status: 500 });
  }
}
