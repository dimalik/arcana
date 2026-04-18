import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { isProcessingUsageMetadata, parseUsageMetadata } from "@/lib/usage";

export const dynamic = "force-dynamic";

/**
 * GET — Estimated cost per paper and per research project, broken down by model.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const days = parseInt(searchParams.get("days") || "30");
  const since = new Date(Date.now() - days * 86400000);

  // All LLM usage in the period
  const logs = await prisma.llmUsageLog.findMany({
    where: { createdAt: { gte: since } },
    select: {
      operation: true,
      modelId: true,
      estimatedCostUsd: true,
      inputTokens: true,
      outputTokens: true,
      metadata: true,
    },
  });

  // Paper processing costs are reconstructed from persisted runtime metadata,
  // not operation-name heuristics.
  const paperLogs = logs.flatMap((log) => {
    const metadata = parseUsageMetadata(log.metadata);
    if (!isProcessingUsageMetadata(metadata)) return [];
    return [{ ...log, parsedMetadata: metadata }];
  });
  const processedPapers = new Set(paperLogs.map((log) => log.parsedMetadata.paperId)).size;

  // Aggregate paper processing by model
  const paperByModel: Record<string, { cost: number; calls: number; inputTokens: number; outputTokens: number }> = {};
  for (const l of paperLogs) {
    const m = paperByModel[l.modelId] || { cost: 0, calls: 0, inputTokens: 0, outputTokens: 0 };
    m.cost += l.estimatedCostUsd;
    m.calls++;
    m.inputTokens += l.inputTokens;
    m.outputTokens += l.outputTokens;
    paperByModel[l.modelId] = m;
  }

  const totalPaperCost = paperLogs.reduce((s, l) => s + l.estimatedCostUsd, 0);
  const avgCostPerPaper = processedPapers > 0 ? totalPaperCost / processedPapers : 0;

  // Research project costs (have projectId in metadata)
  const projectCosts: Record<string, Record<string, { cost: number; calls: number }>> = {};
  for (const l of logs) {
    const metadata = parseUsageMetadata(l.metadata);
    if (!metadata?.projectId || typeof metadata.projectId !== "string") continue;
    const pid = metadata.projectId;
    if (!projectCosts[pid]) projectCosts[pid] = {};
    const m = projectCosts[pid][l.modelId] || { cost: 0, calls: 0 };
    m.cost += l.estimatedCostUsd;
    m.calls++;
    projectCosts[pid][l.modelId] = m;
  }

  // Get project titles
  const projectIds = Object.keys(projectCosts);
  const projects = projectIds.length > 0
    ? await prisma.researchProject.findMany({
        where: { id: { in: projectIds } },
        select: { id: true, title: true },
      })
    : [];
  const titleMap = Object.fromEntries(projects.map((p) => [p.id, p.title]));

  // Build sorted project list
  const projectList = Object.entries(projectCosts)
    .map(([id, models]) => ({
      id,
      title: titleMap[id] || id.slice(0, 8),
      totalCost: Object.values(models).reduce((s, m) => s + m.cost, 0),
      totalCalls: Object.values(models).reduce((s, m) => s + m.calls, 0),
      byModel: models,
    }))
    .sort((a, b) => b.totalCost - a.totalCost);

  return NextResponse.json({
    paperProcessing: {
      totalCost: totalPaperCost,
      processedPapers,
      avgCostPerPaper,
      byModel: paperByModel,
    },
    researchProjects: projectList,
  });
}
