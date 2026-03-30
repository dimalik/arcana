import { prisma } from "@/lib/prisma";
import { generateObject } from "ai";
import { z } from "zod";

interface MetricDef {
  name: string;
  direction: "higher" | "lower";
  description: string;
}

/**
 * Recompute canonical metrics for all experiments in a project.
 * Called when metricSchema changes. Uses generateObject to map
 * raw experiment metrics to the new canonical names.
 */
export async function recomputeMetrics(projectId: string): Promise<number> {
  const project = await prisma.researchProject.findUnique({
    where: { id: projectId },
    select: { metricSchema: true },
  });
  if (!project?.metricSchema) return 0;

  const schema: MetricDef[] = JSON.parse(project.metricSchema);
  if (schema.length === 0) return 0;

  // Get all results with rawMetrics
  const results = await prisma.experimentResult.findMany({
    where: { projectId, rawMetrics: { not: null } },
    select: { id: true, rawMetrics: true, scriptName: true, reflection: true },
  });

  if (results.length === 0) return 0;

  // Use LLM to map raw metrics to canonical names
  const { getModelForTier } = await import("@/lib/llm/auto-process");
  const { getModel, setLlmContext } = await import("@/lib/llm/provider");
  const { provider, modelId, proxyConfig } = await getModelForTier("standard");
  setLlmContext("metric-recompute", "system", { projectId });
  const model = await getModel(provider, modelId, proxyConfig);

  const mappingSchema = z.object({
    results: z.array(z.object({
      id: z.string(),
      metrics: z.record(z.string(), z.number()).describe("Canonical metric values mapped from raw metrics"),
    })),
  });

  // Process in batches of 10
  let updated = 0;
  for (let i = 0; i < results.length; i += 10) {
    const batch = results.slice(i, i + 10);

    try {
      const { object } = await generateObject({
        model,
        schema: mappingSchema,
        system: `Map experiment metrics to canonical metric names. The project uses these canonical metrics:\n${schema.map(m => `- ${m.name} (${m.direction} is better): ${m.description}`).join("\n")}\n\nFor each experiment, find the raw metric that best matches each canonical name and return the mapped values. If no match exists for a canonical metric, omit it.`,
        prompt: batch.map(r => `Experiment ${r.id} (${r.scriptName}):\nRaw metrics: ${r.rawMetrics}\n${r.reflection ? `Context: ${r.reflection.slice(0, 200)}` : ""}`).join("\n\n"),
      });

      for (const mapped of object.results) {
        const result = batch.find(r => r.id === mapped.id);
        if (!result) continue;

        await prisma.experimentResult.update({
          where: { id: mapped.id },
          data: { metrics: JSON.stringify(mapped.metrics) },
        });
        updated++;
      }
    } catch (err) {
      console.warn(`[metric-recompute] Batch ${i} failed:`, err);
    }
  }

  return updated;
}
