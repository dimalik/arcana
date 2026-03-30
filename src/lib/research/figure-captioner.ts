/**
 * Auto-caption figures and register them as Artifact records.
 *
 * Scans for image files in the project workdir, generates captions
 * for uncaptioned ones using generateObject, and stores them as
 * Artifact records (type: "figure") linked to their ExperimentResult.
 *
 * Called from: auto-viz completion hook, on-demand.
 */

import { prisma } from "@/lib/prisma";
import { generateObject } from "ai";
import { z } from "zod";
import { readdir, stat } from "fs/promises";
import path from "path";

const IMAGE_EXT = /\.(png|jpg|jpeg|svg|gif)$/i;

/**
 * Scan workdir for new figures and register them as Artifact records.
 * Links each figure to the ExperimentResult it relates to via the DB relation.
 * Idempotent — skips files that already have an Artifact record.
 */
export async function captionNewFigures(projectId: string, workDir: string): Promise<number> {
  let files: string[];
  try {
    files = (await readdir(workDir)).filter(f => IMAGE_EXT.test(f) && !f.startsWith("."));
  } catch {
    return 0;
  }

  if (files.length === 0) return 0;

  // Check which are already registered
  const existing = await prisma.artifact.findMany({
    where: { projectId, type: "figure" },
    select: { filename: true },
  });
  const registeredSet = new Set(existing.map((a: { filename: string }) => a.filename));
  const newFiles = files.filter(f => !registeredSet.has(f));

  if (newFiles.length === 0) return 0;

  // Load experiment results for linking and context
  const results = await prisma.experimentResult.findMany({
    where: { projectId },
    select: { id: true, scriptName: true, metrics: true, verdict: true, reflection: true },
    orderBy: { createdAt: "asc" },
  });

  // Build context for captioning
  const experimentContext = results.map(r => {
    const metrics = r.metrics ? Object.entries(JSON.parse(r.metrics)).map(([k, v]) => `${k}=${v}`).join(", ") : "";
    return `${r.scriptName} (id:${r.id.slice(0, 8)}): ${r.verdict || "unknown"} — ${metrics}`;
  }).join("\n");

  const batch = newFiles.slice(0, 15);
  let registered = 0;

  try {
    const { getModelForTier } = await import("@/lib/llm/auto-process");
    const { getModel, setLlmContext } = await import("@/lib/llm/provider");
    const { provider, modelId, proxyConfig } = await getModelForTier("standard");
    setLlmContext("artifact-caption", "system", { projectId });
    const model = await getModel(provider, modelId, proxyConfig);

    const captionSchema = z.object({
      figures: z.array(z.object({
        filename: z.string(),
        caption: z.string().describe("2-3 sentence description of what this figure shows"),
        experimentId: z.string().optional().describe("The experiment result ID (8-char prefix) this figure relates to"),
        keyTakeaway: z.string().optional().describe("One-line key insight"),
      })),
    });

    const { object } = await generateObject({
      model,
      schema: captionSchema,
      system: "Link research figures to the experiments that produced them and generate captions. Use the experiment IDs provided to link each figure to its source experiment.",
      prompt: `Figures to register:\n${batch.join("\n")}\n\nExperiments:\n${experimentContext.slice(0, 4000)}`,
    });

    for (const fig of object.figures) {
      const matchedFile = batch.find(f => f === fig.filename || f.includes(fig.filename));
      if (!matchedFile) continue;

      // Resolve experiment result ID from the 8-char prefix
      let resultId: string | null = null;
      if (fig.experimentId) {
        const match = results.find(r => r.id.startsWith(fig.experimentId!));
        if (match) resultId = match.id;
      }

      // Get file size
      let fileSize: number | null = null;
      try {
        const s = await stat(path.join(workDir, matchedFile));
        fileSize = s.size;
      } catch { /* non-critical */ }

      await prisma.artifact.upsert({
        where: { projectId_filename: { projectId, filename: matchedFile } },
        create: {
          projectId,
          resultId,
          type: "figure",
          filename: matchedFile,
          path: matchedFile,
          caption: fig.caption,
          keyTakeaway: fig.keyTakeaway || null,
          size: fileSize,
        },
        update: {
          resultId,
          caption: fig.caption,
          keyTakeaway: fig.keyTakeaway || null,
        },
      });
      registered++;
    }
  } catch (err) {
    console.warn("[figure-captioner] Caption generation failed:", err);
  }

  // For remaining files that the LLM didn't process, create basic records
  for (const f of batch) {
    if (registeredSet.has(f)) continue;
    const alreadyCreated = await prisma.artifact.findUnique({
      where: { projectId_filename: { projectId, filename: f } },
    });
    if (alreadyCreated) continue;

    let fileSize: number | null = null;
    try {
      const s = await stat(path.join(workDir, f));
      fileSize = s.size;
    } catch { /* non-critical */ }

    const label = f.replace(IMAGE_EXT, "").replace(/^fig_?\d*_?/, "").replace(/_/g, " ").trim();

    await prisma.artifact.create({
      data: {
        projectId,
        type: "figure",
        filename: f,
        path: f,
        caption: label ? `Figure: ${label}` : null,
        size: fileSize,
      },
    }).catch(() => {});

    registered++;
  }

  return registered;
}
