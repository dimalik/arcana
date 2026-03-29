import { prisma } from "./prisma";

// ── Model cost table (USD per 1M tokens) ─────────────────────────

interface ModelCost {
  input: number;  // per 1M input tokens
  output: number; // per 1M output tokens
}

const MODEL_COSTS: Record<string, ModelCost> = {
  "gpt-4o":                    { input: 2.50,  output: 10.00 },
  "gpt-4o-mini":               { input: 0.15,  output: 0.60 },
  "gpt-4-turbo":               { input: 10.00, output: 30.00 },
  "claude-sonnet-4-6":         { input: 3.00,  output: 15.00 },
  "claude-sonnet-4-20250514":  { input: 3.00,  output: 15.00 },
  "claude-haiku-4-5-20251001": { input: 0.80,  output: 4.00 },
  "claude-opus-4-6":           { input: 15.00, output: 75.00 },
  "claude-opus-4-20250514":    { input: 15.00, output: 75.00 },
};

const DEFAULT_COST: ModelCost = { input: 2.00, output: 8.00 };

export function estimateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number
): number {
  // Find matching cost entry (supports partial model ID matching for proxy models)
  const cost =
    MODEL_COSTS[modelId] ??
    Object.entries(MODEL_COSTS).find(([key]) => modelId.includes(key))?.[1] ??
    DEFAULT_COST;

  return (
    (inputTokens / 1_000_000) * cost.input +
    (outputTokens / 1_000_000) * cost.output
  );
}

// ── Usage logging ────────────────────────────────────────────────

export interface UsageEntry {
  userId?: string;
  provider: string;
  modelId: string;
  operation: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  durationMs: number;
  success: boolean;
  error?: string;
  metadata?: Record<string, unknown>;
}

export async function logLlmUsage(entry: UsageEntry): Promise<void> {
  try {
    const estimatedCostUsd = estimateCost(
      entry.modelId,
      entry.inputTokens,
      entry.outputTokens
    );

    // Validate userId exists before inserting (FK constraint)
    let validUserId: string | null = entry.userId || null;
    if (validUserId) {
      const userExists = await prisma.user.findUnique({ where: { id: validUserId }, select: { id: true } });
      if (!userExists) validUserId = null;
    }

    await prisma.llmUsageLog.create({
      data: {
        userId: validUserId,
        provider: entry.provider,
        modelId: entry.modelId,
        operation: entry.operation,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        totalTokens: entry.totalTokens,
        estimatedCostUsd,
        durationMs: entry.durationMs,
        success: entry.success,
        error: entry.error?.slice(0, 2000) || null,
        metadata: entry.metadata ? JSON.stringify(entry.metadata) : null,
      },
    });
  } catch (err) {
    // Never let usage logging break the main flow
    console.error("[usage] Failed to log LLM usage:", err);
  }
}

// ── Aggregation helpers ──────────────────────────────────────────

export interface UsageSummary {
  totalCost: number;
  totalTokens: number;
  totalCalls: number;
  errorCount: number;
  byModel: Record<string, { cost: number; tokens: number; calls: number }>;
  byOperation: Record<string, { cost: number; tokens: number; calls: number }>;
  byDay: { date: string; cost: number; tokens: number; calls: number }[];
}

export async function getUsageSummary(
  days = 30,
  userId?: string
): Promise<UsageSummary> {
  const since = new Date();
  since.setDate(since.getDate() - days);

  const where = {
    createdAt: { gte: since },
    ...(userId ? { userId } : {}),
  };

  const logs = await prisma.llmUsageLog.findMany({
    where,
    orderBy: { createdAt: "asc" },
  });

  const summary: UsageSummary = {
    totalCost: 0,
    totalTokens: 0,
    totalCalls: logs.length,
    errorCount: 0,
    byModel: {},
    byOperation: {},
    byDay: [],
  };

  const dayMap = new Map<
    string,
    { cost: number; tokens: number; calls: number }
  >();

  for (const log of logs) {
    summary.totalCost += log.estimatedCostUsd;
    summary.totalTokens += log.totalTokens;
    if (!log.success) summary.errorCount++;

    // By model
    if (!summary.byModel[log.modelId]) {
      summary.byModel[log.modelId] = { cost: 0, tokens: 0, calls: 0 };
    }
    summary.byModel[log.modelId].cost += log.estimatedCostUsd;
    summary.byModel[log.modelId].tokens += log.totalTokens;
    summary.byModel[log.modelId].calls++;

    // By operation
    if (!summary.byOperation[log.operation]) {
      summary.byOperation[log.operation] = { cost: 0, tokens: 0, calls: 0 };
    }
    summary.byOperation[log.operation].cost += log.estimatedCostUsd;
    summary.byOperation[log.operation].tokens += log.totalTokens;
    summary.byOperation[log.operation].calls++;

    // By day
    const day = log.createdAt.toISOString().slice(0, 10);
    const existing = dayMap.get(day) || { cost: 0, tokens: 0, calls: 0 };
    existing.cost += log.estimatedCostUsd;
    existing.tokens += log.totalTokens;
    existing.calls++;
    dayMap.set(day, existing);
  }

  summary.byDay = Array.from(dayMap.entries()).map(([date, data]) => ({
    date,
    ...data,
  }));

  return summary;
}
