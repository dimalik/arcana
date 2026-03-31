import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";
import { getModelForTier } from "@/lib/llm/auto-process";
import { getModel, setLlmContext } from "@/lib/llm/provider";
import { streamText } from "ai";
import { readFile, readdir } from "fs/promises";
import path from "path";

export const maxDuration = 120;

type Params = { params: Promise<{ id: string }> };

interface RetrievedContext {
  text: string;
  images: { path: string; filename: string }[];  // images to send as vision input
}

/**
 * Retrieve focused context based on the user's question.
 * Server-side retrieval — not LLM tool use.
 * Returns text context + image paths for multimodal input.
 */
async function retrieveContext(
  projectId: string,
  workDir: string,
  question: string,
): Promise<RetrievedContext> {
  const parts: string[] = [];
  const q = question.toLowerCase();

  // Always include: hypotheses + experiment results (compact, structured)
  const hypotheses = await prisma.researchHypothesis.findMany({
    where: { projectId },
    select: { statement: true, status: true },
    orderBy: { updatedAt: "desc" },
    take: 15,
  });
  if (hypotheses.length > 0) {
    parts.push("## Hypotheses");
    parts.push(hypotheses.map(h => `- [${h.status}] ${h.statement.slice(0, 150)}`).join("\n"));
  }

  const results = await prisma.experimentResult.findMany({
    where: { projectId },
    include: { branch: { select: { name: true } } },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  if (results.length > 0) {
    parts.push("\n## Experiment Results");
    for (const r of results) {
      const metrics = r.metrics ? Object.entries(JSON.parse(r.metrics)).map(([k, v]) => `${k}=${v}`).join(", ") : "";
      parts.push(`- ${r.scriptName} [${r.verdict}] ${metrics}`);
      if (r.reflection) parts.push(`  ${r.reflection.slice(0, 200)}`);
    }
  }

  // If asking about figures/images: list all figure files
  if (q.includes("fig") || q.includes("image") || q.includes("plot") || q.includes("chart") || q.includes("visual") || q.includes("heatmap") || q.includes(".png") || q.includes(".jpg")) {
    // DB artifacts
    const artifacts = await prisma.artifact.findMany({
      where: { projectId, type: "figure" },
      include: { result: { select: { scriptName: true } } },
      take: 50,
    });
    if (artifacts.length > 0) {
      parts.push("\n## Figures (from DB)");
      for (const a of artifacts) {
        parts.push(`- ${a.filename}${a.caption ? `: ${a.caption.slice(0, 150)}` : ""}${a.result ? ` (from ${a.result.scriptName})` : ""}`);
      }
    }

    // Filesystem scan (always, as DB may be incomplete)
    try {
      const files = await readdir(workDir);
      const figs = files.filter(f => /\.(png|jpg|jpeg|svg|gif)$/i.test(f));
      if (figs.length > 0) {
        parts.push(`\n## Figure Files on Disk (${figs.length})`);
        parts.push(figs.join(", "));
      }
    } catch { /* workdir may not exist */ }
  }

  // If asking about a specific file: read it
  const fileMatch = q.match(/\b([\w.-]+\.(py|json|csv|txt|md|log|yaml|yml))\b/);
  if (fileMatch) {
    try {
      const content = await readFile(path.join(workDir, fileMatch[1]), "utf-8");
      parts.push(`\n## File: ${fileMatch[1]}\n\`\`\`\n${content.slice(0, 5000)}\n\`\`\``);
    } catch { /* file not found */ }
  }

  // If asking about papers
  if (q.includes("paper") || q.includes("literature") || q.includes("reference")) {
    const papers = await prisma.paper.findMany({
      where: { collections: { some: { collection: { researchProject: { id: projectId } } } } },
      select: { title: true, authors: true, year: true, summary: true },
      take: 20,
    });
    if (papers.length > 0) {
      parts.push("\n## Papers");
      for (const p of papers) {
        let authors = "";
        try { authors = JSON.parse(p.authors || "[]").slice(0, 2).join(", "); } catch {}
        parts.push(`- ${p.title} (${authors}, ${p.year || "?"})`);
        if (p.summary) parts.push(`  ${p.summary.slice(0, 150)}`);
      }
    }
  }

  // If asking about approaches
  if (q.includes("approach") || q.includes("method") || q.includes("strategy") || q.includes("direction")) {
    const approaches = await prisma.approachBranch.findMany({
      where: { projectId },
      include: { results: { select: { verdict: true } } },
      take: 15,
    });
    if (approaches.length > 0) {
      parts.push("\n## Approaches");
      for (const a of approaches) {
        parts.push(`- ${a.name} [${a.status}] (${a.results.length} experiments)`);
      }
    }
  }

  // If asking about log/findings/breakthroughs or general research state
  if (q.includes("finding") || q.includes("breakthrough") || q.includes("progress") || q.includes("status") || q.includes("summary") || q.includes("what") || q.includes("how")) {
    const log = await prisma.researchLogEntry.findMany({
      where: { projectId, type: { in: ["breakthrough", "decision"] } },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { type: true, content: true },
    });
    if (log.length > 0) {
      parts.push("\n## Recent Breakthroughs & Decisions");
      for (const e of log) {
        parts.push(`- [${e.type}] ${e.content.slice(0, 300)}`);
      }
    }
  }

  // Always include file listing (compact)
  try {
    const files = await readdir(workDir);
    const relevant = files.filter(f => /\.(py|json|csv|png|md|txt|log)$/i.test(f) && !f.startsWith("."));
    parts.push(`\n## All Project Files (${relevant.length}): ${relevant.join(", ")}`);
  } catch { /* workdir may not exist */ }

  // If question mentions a specific image file, include it for vision
  const images: { path: string; filename: string }[] = [];
  const imgMatch = q.match(/\b([\w.-]+\.(png|jpg|jpeg|gif))\b/i);
  if (imgMatch) {
    const imgPath = path.join(workDir, imgMatch[1]);
    try {
      const { stat } = await import("fs/promises");
      const s = await stat(imgPath);
      if (s.size < 5 * 1024 * 1024) { // max 5MB
        images.push({ path: imgPath, filename: imgMatch[1] });
      }
    } catch { /* file not found */ }
  }

  return { text: parts.join("\n"), images };
}

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
      select: { id: true, title: true, brief: true, currentPhase: true, status: true, methodology: true, outputFolder: true },
    });

    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // Store the latest user message so the research agent sees it
    const lastUserMsg = messages.filter(m => m.role === "user").pop();
    if (lastUserMsg) {
      await prisma.researchLogEntry.create({
        data: {
          projectId: id,
          type: "user_note",
          content: lastUserMsg.content,
          metadata: JSON.stringify({ source: "chat" }),
        },
      }).catch(() => {});
    }

    // Compute workdir
    const slug = project.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 50);
    const workDir = project.outputFolder || path.join(process.cwd(), "output", "research", `${slug}-${id.slice(0, 8)}`);

    // Detect resource routing directives and create rules automatically
    if (lastUserMsg) {
      const msg = lastUserMsg.content.toLowerCase();
      const mentionsLocal = msg.includes("local") || msg.includes("locally");
      const mentionsRemote = msg.includes("remote") || msg.includes("gpu");
      const mentionsProxy = msg.includes("proxy") || msg.includes("api key") || msg.includes("api_key");
      const mentionsRun = msg.includes("run") || msg.includes("execute") || msg.includes("should");

      if ((mentionsRun || mentionsProxy) && (mentionsLocal || mentionsRemote)) {
        const { upsertResourceRule } = await import("@/lib/research/resource-router");
        const targetRuntime = mentionsLocal ? "local" : "remote";

        // Check if the user mentions a specific script type
        const mentionsAnalysis = msg.includes("analysis");
        const mentionsExp = msg.includes("exp_") || msg.includes("experiment");
        const mentionsPoc = msg.includes("poc");

        // Check for specific script filename
        const scriptMatch = msg.match(/\b((?:exp|poc|analysis|sweep)_\d{3}\S*\.py)\b/);

        if (scriptMatch) {
          // Most specific: exact script
          await upsertResourceRule(id, scriptMatch[1], targetRuntime, "User directive from chat", undefined, 10);
        } else if (mentionsAnalysis && !mentionsExp && !mentionsPoc) {
          await upsertResourceRule(id, "analysis_*", targetRuntime, `User directive: analysis scripts ${targetRuntime}`);
        } else if (mentionsExp && !mentionsAnalysis && !mentionsPoc) {
          await upsertResourceRule(id, "exp_*", targetRuntime, `User directive: experiments ${targetRuntime}`);
        } else if (mentionsPoc && !mentionsAnalysis && !mentionsExp) {
          await upsertResourceRule(id, "poc_*", targetRuntime, `User directive: PoC scripts ${targetRuntime}`);
        } else {
          // No specific type mentioned — apply to ALL scripts
          await upsertResourceRule(id, "*", targetRuntime, `User directive: all scripts ${targetRuntime}${mentionsProxy ? " (needs local proxy)" : ""}`, mentionsProxy ? ["proxy"] : undefined, -1);
        }
      }
    }

    // Load resource rules for context
    const resourceRules = await prisma.resourceRule.findMany({
      where: { projectId: id },
      orderBy: { priority: "desc" },
    });

    // Server-side retrieval: gather focused context based on the question
    const question = lastUserMsg?.content || "";
    const { text: contextText, images } = await retrieveContext(id, workDir, question);

    // Brief
    let briefQuestion = project.brief;
    try { briefQuestion = JSON.parse(project.brief).question || project.brief; } catch {}

    const { provider, modelId, proxyConfig } = await getModelForTier("standard");
    const model = await getModel(provider, modelId, proxyConfig);
    setLlmContext("research-chat", userId, { projectId: id });

    // If we have images, inject them into the last user message as multimodal content
    let finalMessages: Array<{ role: "user" | "assistant"; content: string | Array<{ type: "text"; text: string } | { type: "image"; image: Uint8Array; mimeType: string }> }> = messages;
    if (images.length > 0) {
      const imageParts: { type: "image"; image: Uint8Array; mimeType: string }[] = [];
      for (const img of images) {
        try {
          const buffer = await readFile(img.path);
          const ext = img.filename.split(".").pop()?.toLowerCase();
          const mime = ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";
          imageParts.push({ type: "image", image: new Uint8Array(buffer), mimeType: mime });
        } catch { /* skip unreadable */ }
      }
      if (imageParts.length > 0) {
        // Replace the last user message with multimodal content (text + images)
        const lastMsg = finalMessages[finalMessages.length - 1];
        const lastText = typeof lastMsg.content === "string" ? lastMsg.content : question;
        finalMessages = [
          ...finalMessages.slice(0, -1),
          {
            role: "user" as const,
            content: [
              { type: "text" as const, text: lastText },
              ...imageParts,
            ],
          },
        ];
      }
    }

    const result = streamText({
      model,
      system: `You are a research assistant for: "${project.title}"
Phase: ${project.currentPhase} | Status: ${project.status}
Question: ${briefQuestion}

You have retrieved context below based on the user's question. Answer using ONLY this data — be specific, cite filenames and numbers. If a file exists in the listing, it was generated by a completed process.

When the user gives a directive, acknowledge it — it's automatically forwarded to the research agent.

When the user tells you WHERE something should run (e.g., "run analysis locally", "use my local proxy for X"), confirm it and note that a resource routing rule has been created. Resource rules ensure scripts always run in the right place.

If an image is attached, describe what you SEE in the image.

## Resource Routing Rules
${resourceRules.length > 0 ? resourceRules.map(r => `- "${r.pattern}" → ${r.runtime}${r.reason ? ` (${r.reason})` : ""}`).join("\n") : "No custom rules — using taxonomy defaults (exp_/poc_ → remote, analysis_ → local)"}

${contextText}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: finalMessages as any,
    });

    return result.toTextStreamResponse();
  } catch (err) {
    console.error("[research/chat] POST error:", err);
    return NextResponse.json({ error: "Chat failed" }, { status: 500 });
  }
}
