import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { aggregatePaperCosts } from "@/lib/paper-costs";
import { parseUsageMetadata } from "@/lib/usage";

export const dynamic = "force-dynamic";

/**
 * GET — Reconciled cost per paper and per research project.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const days = parseInt(searchParams.get("days") || "30");
  const since = new Date(Date.now() - days * 86400000);

  const [logs, agentSessions] = await Promise.all([
    prisma.llmUsageLog.findMany({
      where: { createdAt: { gte: since } },
      select: {
        operation: true,
        modelId: true,
        estimatedCostUsd: true,
        inputTokens: true,
        outputTokens: true,
        metadata: true,
      },
    }),
    prisma.agentSession.findMany({
      where: {
        completedAt: { gte: since },
        costUsd: { not: null },
      },
      select: {
        paperId: true,
        costUsd: true,
      },
    }),
  ]);

  const { paperCosts, paperProcessing } = aggregatePaperCosts({
    providerLogs: logs,
    agentSessions: agentSessions.flatMap((session) =>
      typeof session.costUsd === "number"
        ? [{ paperId: session.paperId, costUsd: session.costUsd }]
        : [],
    ),
  });

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
    paperProcessing,
    paperCosts,
    researchProjects: projectList,
  });
}
