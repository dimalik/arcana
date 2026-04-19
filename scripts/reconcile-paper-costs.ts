import fs from "node:fs/promises";
import path from "node:path";

import { prisma } from "@/lib/prisma";
import { aggregatePaperCosts } from "@/lib/paper-costs";
import { getProviderUsageSegment, type PaperCostSegment } from "@/lib/usage-segmentation";
import { parseUsageMetadata } from "@/lib/usage";

interface CliOptions {
  days: number;
  out: string | null;
  paperIds: string[];
}

interface PerPaperBreakdown {
  paperId: string;
  title: string | null;
  totalCost: number;
  providerCost: number;
  agentCost: number;
  providerRecords: number;
  agentRecords: number;
  bySegment: Record<PaperCostSegment, { cost: number; records: number }>;
  unclassifiedOperations: Record<string, { cost: number; calls: number }>;
}

function parseArgs(argv: string[]): CliOptions {
  let days = 30;
  let out: string | null = null;
  const paperIds: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--days") {
      const parsed = Number.parseInt(argv[index + 1] ?? "", 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        days = parsed;
      }
      index += 1;
      continue;
    }

    if (arg === "--out") {
      out = argv[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === "--paper-id") {
      const paperId = argv[index + 1] ?? null;
      if (paperId) {
        paperIds.push(paperId);
      }
      index += 1;
    }
  }

  return { days, out, paperIds };
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function createSegmentTotals(): Record<PaperCostSegment, { cost: number; records: number }> {
  return {
    processing: { cost: 0, records: 0 },
    interactive: { cost: 0, records: 0 },
    reference_enrichment: { cost: 0, records: 0 },
    agent: { cost: 0, records: 0 },
    unclassified: { cost: 0, records: 0 },
  };
}

function getOrCreatePaperBreakdown(
  papers: Map<string, PerPaperBreakdown>,
  paperId: string,
): PerPaperBreakdown {
  const existing = papers.get(paperId);
  if (existing) return existing;

  const created: PerPaperBreakdown = {
    paperId,
    title: null,
    totalCost: 0,
    providerCost: 0,
    agentCost: 0,
    providerRecords: 0,
    agentRecords: 0,
    bySegment: createSegmentTotals(),
    unclassifiedOperations: {},
  };
  papers.set(paperId, created);
  return created;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const since = new Date(Date.now() - options.days * 86_400_000);

  const [providerLogs, agentSessions] = await Promise.all([
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

  const agentRows = agentSessions.flatMap((session) =>
    typeof session.paperId === "string" && typeof session.costUsd === "number"
      ? [{ paperId: session.paperId, costUsd: session.costUsd }]
      : [],
  );

  const aggregate = aggregatePaperCosts({
    providerLogs,
    agentSessions: agentRows,
  });

  const perPaper = new Map<string, PerPaperBreakdown>();

  for (const log of providerLogs) {
    const metadata = parseUsageMetadata(log.metadata);
    const paperId =
      typeof metadata?.paperId === "string" && metadata.paperId.length > 0
        ? metadata.paperId
        : null;
    if (!paperId) continue;

    const breakdown = getOrCreatePaperBreakdown(perPaper, paperId);
    const segment = getProviderUsageSegment(log.operation);

    breakdown.totalCost += log.estimatedCostUsd;
    breakdown.providerCost += log.estimatedCostUsd;
    breakdown.providerRecords += 1;
    breakdown.bySegment[segment].cost += log.estimatedCostUsd;
    breakdown.bySegment[segment].records += 1;

    if (segment === "unclassified") {
      const op = breakdown.unclassifiedOperations[log.operation] ?? { cost: 0, calls: 0 };
      op.cost += log.estimatedCostUsd;
      op.calls += 1;
      breakdown.unclassifiedOperations[log.operation] = op;
    }
  }

  for (const session of agentRows) {
    const breakdown = getOrCreatePaperBreakdown(perPaper, session.paperId);
    breakdown.totalCost += session.costUsd;
    breakdown.agentCost += session.costUsd;
    breakdown.agentRecords += 1;
    breakdown.bySegment.agent.cost += session.costUsd;
    breakdown.bySegment.agent.records += 1;
  }

  const paperIds = Array.from(
    new Set([
      ...Array.from(perPaper.keys()),
      ...options.paperIds,
    ]),
  );

  const titles = paperIds.length > 0
    ? await prisma.paper.findMany({
        where: { id: { in: paperIds } },
        select: { id: true, title: true },
      })
    : [];
  const titleMap = new Map(titles.map((paper) => [paper.id, paper.title]));

  for (const breakdown of Array.from(perPaper.values())) {
    breakdown.title = titleMap.get(breakdown.paperId) ?? null;
    breakdown.totalCost = roundUsd(breakdown.totalCost);
    breakdown.providerCost = roundUsd(breakdown.providerCost);
    breakdown.agentCost = roundUsd(breakdown.agentCost);
    for (const stats of Object.values(
      breakdown.bySegment,
    ) as Array<{ cost: number; records: number }>) {
      stats.cost = roundUsd(stats.cost);
    }
    for (const stats of Object.values(
      breakdown.unclassifiedOperations,
    ) as Array<{ cost: number; calls: number }>) {
      stats.cost = roundUsd(stats.cost);
    }
  }

  const sortedBreakdowns = Array.from(perPaper.values()).sort(
    (left, right) => right.totalCost - left.totalCost || left.paperId.localeCompare(right.paperId),
  );

  const selectedPapers = options.paperIds.map((paperId) => {
    const breakdown = perPaper.get(paperId);
    return breakdown ?? {
      paperId,
      title: titleMap.get(paperId) ?? null,
      totalCost: 0,
      providerCost: 0,
      agentCost: 0,
      providerRecords: 0,
      agentRecords: 0,
      bySegment: createSegmentTotals(),
      unclassifiedOperations: {},
    };
  });

  const segmentTotal = Object.values(aggregate.paperCosts.bySegment).reduce(
    (sum, stats) => sum + stats.cost,
    0,
  );

  const sourceTotal =
    aggregate.paperCosts.sourceTotals.providerMediated.cost
    + aggregate.paperCosts.sourceTotals.agent.cost;

  const payload = {
    generatedAt: new Date().toISOString(),
    days: options.days,
    since: since.toISOString(),
    summary: aggregate,
    reconciliation: {
      totalMatchesSourceTotals:
        Math.abs(roundUsd(sourceTotal) - aggregate.paperCosts.totalCost) <= 0.000001,
      totalMatchesSegmentTotals:
        Math.abs(roundUsd(segmentTotal) - aggregate.paperCosts.totalCost) <= 0.000001,
      unclassifiedCost: aggregate.paperCosts.bySegment.unclassified.cost,
      unclassifiedOperationCount: Object.keys(aggregate.paperCosts.unclassifiedOperations).length,
    },
    topPapers: sortedBreakdowns.slice(0, 20),
    selectedPapers,
  };

  if (options.out) {
    const outputPath = path.resolve(options.out);
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    console.log(`[reconcile-paper-costs] Wrote artifact to ${outputPath}`);
  }

  console.log(JSON.stringify(payload, null, 2));
}

main()
  .catch((error) => {
    console.error("[reconcile-paper-costs] Failed:", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
