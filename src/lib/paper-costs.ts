import {
  PAPER_COST_SEGMENTS,
  getProviderUsageSegment,
  type PaperCostSegment,
} from "./usage-segmentation";
import { parseUsageMetadata } from "./usage";

export interface PaperCostModelStats {
  cost: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

export interface PaperCostSegmentStats {
  cost: number;
  records: number;
}

export interface PaperCostOperationStats {
  cost: number;
  calls: number;
}

export interface PaperCostSourceTotals {
  providerMediated: {
    cost: number;
    records: number;
  };
  agent: {
    cost: number;
    records: number;
  };
  combined: {
    cost: number;
    paperCount: number;
  };
}

export interface PaperCostSummary {
  totalCost: number;
  paperCount: number;
  avgCostPerPaper: number;
  byModel: Record<string, PaperCostModelStats>;
  bySegment: Record<PaperCostSegment, PaperCostSegmentStats>;
  sourceTotals: PaperCostSourceTotals;
  unclassifiedOperations: Record<string, PaperCostOperationStats>;
}

export interface LegacyPaperProcessingCostSummary {
  totalCost: number;
  processedPapers: number;
  avgCostPerPaper: number;
  byModel: Record<string, PaperCostModelStats>;
}

export interface ProviderPaperUsageRow {
  operation: string;
  modelId: string;
  estimatedCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  metadata: string | null;
}

export interface AgentSessionCostRow {
  paperId: string;
  costUsd: number;
}

export interface AggregatePaperCostsResult {
  paperCosts: PaperCostSummary;
  paperProcessing: LegacyPaperProcessingCostSummary;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function createSegmentTotals(): Record<PaperCostSegment, PaperCostSegmentStats> {
  return Object.fromEntries(
    PAPER_COST_SEGMENTS.map((segment) => [segment, { cost: 0, records: 0 }]),
  ) as Record<PaperCostSegment, PaperCostSegmentStats>;
}

export function aggregatePaperCosts(
  params: {
    providerLogs: ProviderPaperUsageRow[];
    agentSessions: AgentSessionCostRow[];
  },
): AggregatePaperCostsResult {
  const allPaperIds = new Set<string>();
  const processingPaperIds = new Set<string>();

  const byModel: Record<string, PaperCostModelStats> = {};
  const processingByModel: Record<string, PaperCostModelStats> = {};
  const bySegment = createSegmentTotals();
  const unclassifiedOperations: Record<string, PaperCostOperationStats> = {};

  const sourceTotals: PaperCostSourceTotals = {
    providerMediated: { cost: 0, records: 0 },
    agent: { cost: 0, records: 0 },
    combined: { cost: 0, paperCount: 0 },
  };

  for (const log of params.providerLogs) {
    const metadata = parseUsageMetadata(log.metadata);
    const paperId =
      typeof metadata?.paperId === "string" && metadata.paperId.length > 0
        ? metadata.paperId
        : null;

    if (!paperId) continue;

    allPaperIds.add(paperId);

    const segment = getProviderUsageSegment(log.operation);
    bySegment[segment].cost += log.estimatedCostUsd;
    bySegment[segment].records += 1;

    sourceTotals.providerMediated.cost += log.estimatedCostUsd;
    sourceTotals.providerMediated.records += 1;

    const modelStats = byModel[log.modelId] ?? {
      cost: 0,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
    modelStats.cost += log.estimatedCostUsd;
    modelStats.calls += 1;
    modelStats.inputTokens += log.inputTokens;
    modelStats.outputTokens += log.outputTokens;
    byModel[log.modelId] = modelStats;

    if (segment === "processing") {
      processingPaperIds.add(paperId);

      const processingStats = processingByModel[log.modelId] ?? {
        cost: 0,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      processingStats.cost += log.estimatedCostUsd;
      processingStats.calls += 1;
      processingStats.inputTokens += log.inputTokens;
      processingStats.outputTokens += log.outputTokens;
      processingByModel[log.modelId] = processingStats;
    }

    if (segment === "unclassified") {
      const operationStats = unclassifiedOperations[log.operation] ?? {
        cost: 0,
        calls: 0,
      };
      operationStats.cost += log.estimatedCostUsd;
      operationStats.calls += 1;
      unclassifiedOperations[log.operation] = operationStats;
    }
  }

  for (const session of params.agentSessions) {
    allPaperIds.add(session.paperId);
    bySegment.agent.cost += session.costUsd;
    bySegment.agent.records += 1;
    sourceTotals.agent.cost += session.costUsd;
    sourceTotals.agent.records += 1;
  }

  sourceTotals.combined.cost =
    sourceTotals.providerMediated.cost + sourceTotals.agent.cost;
  sourceTotals.combined.paperCount = allPaperIds.size;

  const roundedByModel = Object.fromEntries(
    Object.entries(byModel).map(([modelId, stats]) => [
      modelId,
      {
        ...stats,
        cost: roundUsd(stats.cost),
      },
    ]),
  ) as Record<string, PaperCostModelStats>;

  const roundedProcessingByModel = Object.fromEntries(
    Object.entries(processingByModel).map(([modelId, stats]) => [
      modelId,
      {
        ...stats,
        cost: roundUsd(stats.cost),
      },
    ]),
  ) as Record<string, PaperCostModelStats>;

  const roundedBySegment = Object.fromEntries(
    Object.entries(bySegment).map(([segment, stats]) => [
      segment,
      {
        ...stats,
        cost: roundUsd(stats.cost),
      },
    ]),
  ) as Record<PaperCostSegment, PaperCostSegmentStats>;

  const roundedUnclassifiedOperations = Object.fromEntries(
    Object.entries(unclassifiedOperations).map(([operation, stats]) => [
      operation,
      {
        ...stats,
        cost: roundUsd(stats.cost),
      },
    ]),
  ) as Record<string, PaperCostOperationStats>;

  const paperCosts: PaperCostSummary = {
    totalCost: roundUsd(sourceTotals.combined.cost),
    paperCount: allPaperIds.size,
    avgCostPerPaper:
      allPaperIds.size > 0
        ? roundUsd(sourceTotals.combined.cost / allPaperIds.size)
        : 0,
    byModel: roundedByModel,
    bySegment: roundedBySegment,
    sourceTotals: {
      providerMediated: {
        ...sourceTotals.providerMediated,
        cost: roundUsd(sourceTotals.providerMediated.cost),
      },
      agent: {
        ...sourceTotals.agent,
        cost: roundUsd(sourceTotals.agent.cost),
      },
      combined: {
        ...sourceTotals.combined,
        cost: roundUsd(sourceTotals.combined.cost),
      },
    },
    unclassifiedOperations: roundedUnclassifiedOperations,
  };

  const processingTotalCost = bySegment.processing.cost;
  const processedPapers = processingPaperIds.size;

  return {
    paperCosts,
    paperProcessing: {
      totalCost: roundUsd(processingTotalCost),
      processedPapers,
      avgCostPerPaper:
        processedPapers > 0
          ? roundUsd(processingTotalCost / processedPapers)
          : 0,
      byModel: roundedProcessingByModel,
    },
  };
}
