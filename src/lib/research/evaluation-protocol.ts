import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

const EVAL_PROTOCOL_KIND = "evaluation_protocol";
const EVAL_PROTOCOL_PREFIX = "EVAL_PROTOCOL";

export interface EvaluationProtocol {
  primaryMetric: string;
  secondaryMetrics: string[];
  datasets: string[];
  seeds: number[];
  minRuns: number;
  statisticalTest: string;
  acceptanceCriteria: string;
  requiredBaselines: string[];
  notes?: string;
}

export interface StoredEvaluationProtocol {
  id: string;
  createdAt: Date;
  protocol: EvaluationProtocol;
}

function uniqueSortedSeeds(seeds: number[]): number[] {
  const set = new Set<number>();
  for (const seed of seeds) {
    if (Number.isFinite(seed)) set.add(Math.trunc(seed));
  }
  return Array.from(set).sort((a, b) => a - b);
}

function normalizeProtocol(input: EvaluationProtocol): EvaluationProtocol {
  return {
    primaryMetric: input.primaryMetric.trim(),
    secondaryMetrics: Array.from(new Set((input.secondaryMetrics || []).map((m) => m.trim()).filter(Boolean))),
    datasets: Array.from(new Set((input.datasets || []).map((d) => d.trim()).filter(Boolean))),
    seeds: uniqueSortedSeeds(input.seeds || []),
    minRuns: Math.max(1, Math.trunc(input.minRuns || 1)),
    statisticalTest: input.statisticalTest.trim() || "bootstrap 95% CI",
    acceptanceCriteria: input.acceptanceCriteria.trim(),
    requiredBaselines: Array.from(new Set((input.requiredBaselines || []).map((b) => b.trim()).filter(Boolean))),
    notes: input.notes?.trim() || undefined,
  };
}

function parseProtocolFromMetadata(metadata: string | null): EvaluationProtocol | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as { kind?: string; protocol?: EvaluationProtocol };
    if (parsed.kind !== EVAL_PROTOCOL_KIND || !parsed.protocol) return null;
    return normalizeProtocol(parsed.protocol);
  } catch {
    return null;
  }
}

export async function saveEvaluationProtocol(projectId: string, protocol: EvaluationProtocol): Promise<void> {
  return saveEvaluationProtocolTx(projectId, protocol, prisma);
}

type EvaluationProtocolDb = Prisma.TransactionClient | typeof prisma;

export async function saveEvaluationProtocolTx(
  projectId: string,
  protocol: EvaluationProtocol,
  db: EvaluationProtocolDb,
): Promise<void> {
  const normalized = normalizeProtocol(protocol);
  const shortSummary =
    `${EVAL_PROTOCOL_PREFIX} primary=${normalized.primaryMetric}, ` +
    `seeds=[${normalized.seeds.join(", ")}], minRuns=${normalized.minRuns}, ` +
    `datasets=${normalized.datasets.length}`;

  await db.researchLogEntry.create({
    data: {
      projectId,
      type: "decision",
      content: shortSummary,
      metadata: JSON.stringify({
        kind: EVAL_PROTOCOL_KIND,
        protocol: normalized,
      }),
    },
  });
}

export async function getEvaluationProtocol(projectId: string): Promise<StoredEvaluationProtocol | null> {
  const entry = await prisma.researchLogEntry.findFirst({
    where: {
      projectId,
      type: "decision",
      OR: [
        { content: { startsWith: EVAL_PROTOCOL_PREFIX } },
        { metadata: { contains: `"kind":"${EVAL_PROTOCOL_KIND}"` } },
      ],
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, createdAt: true, metadata: true },
  });
  if (!entry) return null;

  const protocol = parseProtocolFromMetadata(entry.metadata);
  if (!protocol) return null;

  return {
    id: entry.id,
    createdAt: entry.createdAt,
    protocol,
  };
}

export function summarizeEvaluationProtocol(protocol: EvaluationProtocol): string {
  const parts = [
    `Primary metric: ${protocol.primaryMetric}`,
    `Secondary metrics: ${protocol.secondaryMetrics.length > 0 ? protocol.secondaryMetrics.join(", ") : "none"}`,
    `Datasets: ${protocol.datasets.length > 0 ? protocol.datasets.join(", ") : "unspecified"}`,
    `Seeds: ${protocol.seeds.length > 0 ? protocol.seeds.join(", ") : "not specified"}`,
    `Minimum runs: ${protocol.minRuns}`,
    `Statistical test: ${protocol.statisticalTest}`,
    `Acceptance criteria: ${protocol.acceptanceCriteria}`,
    `Required baselines: ${protocol.requiredBaselines.length > 0 ? protocol.requiredBaselines.join(", ") : "none"}`,
  ];
  if (protocol.notes) parts.push(`Notes: ${protocol.notes}`);
  return parts.join("\n");
}

export function extractSeedFromCommand(command: string): number | null {
  const longFlag = command.match(/--seed(?:\s+|=)(-?\d+)/);
  if (longFlag && Number.isFinite(Number(longFlag[1]))) return Number(longFlag[1]);

  const shortFlag = command.match(/(?:^|\s)-s(?:\s+|=)(-?\d+)/);
  if (shortFlag && Number.isFinite(Number(shortFlag[1]))) return Number(shortFlag[1]);

  return null;
}

export function validateCommandAgainstEvaluationProtocol(
  command: string,
  protocol: EvaluationProtocol,
): { ok: boolean; reason?: string } {
  const isExperimentScript = /python3?\s+(?:poc_|exp_|sweep_)\d*[_\w-]*\.py/.test(command);
  if (!isExperimentScript) return { ok: true };

  if (protocol.seeds.length > 0) {
    const seed = extractSeedFromCommand(command);
    if (seed === null) {
      return {
        ok: false,
        reason: `Evaluation protocol requires explicit seed. Add --seed <value>. Allowed seeds: [${protocol.seeds.join(", ")}].`,
      };
    }
    if (!protocol.seeds.includes(seed)) {
      return {
        ok: false,
        reason: `Seed ${seed} is outside the evaluation protocol seed set [${protocol.seeds.join(", ")}].`,
      };
    }
  }

  return { ok: true };
}

export function validateResultMetricsAgainstEvaluationProtocol(
  metrics: Record<string, number> | null | undefined,
  rawMetrics: Record<string, number> | null | undefined,
  protocol: EvaluationProtocol,
): { ok: boolean; reason?: string } {
  const primary = protocol.primaryMetric;
  const inMetrics = !!metrics && Object.prototype.hasOwnProperty.call(metrics, primary);
  const inRaw = !!rawMetrics && Object.prototype.hasOwnProperty.call(rawMetrics, primary);
  if (!inMetrics && !inRaw) {
    return {
      ok: false,
      reason: `Evaluation protocol requires primary metric "${primary}" in metrics (preferred) or raw_metrics.`,
    };
  }
  return { ok: true };
}

/**
 * Derive a sensible default evaluation protocol from a metric schema.
 * Used by the DESIGN state auto-resolver to proactively create the
 * protocol when metrics are defined, without waiting for the agent.
 */
export function deriveDefaultProtocol(
  metrics: Array<{ name: string; direction?: string }>,
): EvaluationProtocol | null {
  if (metrics.length === 0) return null;
  const primary = metrics[0];
  const secondary = metrics.slice(1).map((m) => m.name);
  return {
    primaryMetric: primary.name,
    secondaryMetrics: secondary,
    datasets: [],
    seeds: [42, 123, 456],
    minRuns: 1,
    statisticalTest: "bootstrap 95% CI",
    acceptanceCriteria: `Consistent ${primary.direction === "lower" ? "decrease" : "improvement"} in ${primary.name} across seeds`,
    requiredBaselines: [],
    notes: "Auto-derived from project metrics. Refine with define_evaluation_protocol if needed.",
  };
}
