import path from "path";
import { prisma } from "@/lib/prisma";
import {
  attachClaimEvidence,
  syncClaimMemoryLifecycle,
} from "./claim-ledger";
import { reconcileExperimentResultWithClaimCoordinator } from "./claim-coordinator";
import {
  claimEvidenceStrengthForExperiment,
  resolveExperimentContract,
} from "./experiment-contracts";

type ImportedVerdict = "better" | "worse" | "inconclusive" | "error";
type ImportedSource = "manifest" | "stdout_summary" | "stdout_table" | "metric_lines";

interface NormalizedImportedResult {
  source: ImportedSource;
  scriptName: string;
  verdict: ImportedVerdict;
  summary: string;
  condition: string | null;
  metrics: Record<string, number>;
  rawMetrics: Record<string, number> | null;
  metadata: Record<string, unknown> | null;
}

type ClaimLinkCandidate = {
  id: string;
  statement: string;
  hypothesisId: string | null;
  createdBy: string;
  createdFrom: string | null;
  resultId: string | null;
  createdAt: Date;
  evidence: Array<{ kind: string }>;
};

function readTopLevelScalarMetrics(record: Record<string, unknown>) {
  const ignoredKeys = new Set([
    "metrics",
    "raw_metrics",
    "results",
    "conditions",
    "summary",
    "verdict",
    "condition",
    "metadata",
  ]);

  return Object.fromEntries(
    Object.entries(record)
      .filter(([key, value]) => !ignoredKeys.has(key) && typeof value === "number" && Number.isFinite(value))
      .map(([key, value]) => [normalizeMetricKey(key), value as number] as const)
      .filter(([key]) => Boolean(key)),
  );
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return !!value
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.values(value).every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

function normalizeMetricKey(key: string) {
  return key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function normalizeMetrics(value: unknown): Record<string, number> {
  if (!isNumberRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, metric]) => [normalizeMetricKey(key), metric] as const)
      .filter(([key]) => Boolean(key)),
  );
}

function flattenConditionMetrics(
  conditions: Record<string, Record<string, number>>,
): Record<string, number> {
  const entries: Array<[string, number]> = [];
  for (const [condition, metrics] of Object.entries(conditions)) {
    const prefix = normalizeMetricKey(condition);
    for (const [metric, value] of Object.entries(metrics)) {
      entries.push([`${prefix}__${normalizeMetricKey(metric)}`, value]);
    }
  }
  return Object.fromEntries(entries);
}

function conditionScore(metrics: Record<string, number>) {
  const preferredKeys = [
    "asr_40",
    "asr_at_40",
    "asr_ppl40",
    "asr",
    "success_rate",
    "reward",
    "mean_sim",
    "similarity",
  ];

  for (const key of preferredKeys) {
    if (typeof metrics[key] === "number" && Number.isFinite(metrics[key])) {
      return metrics[key];
    }
  }

  const firstMetric = Object.values(metrics).find((value) => Number.isFinite(value));
  return typeof firstMetric === "number" ? firstMetric : Number.NEGATIVE_INFINITY;
}

function selectRepresentativeCondition(
  conditions: Record<string, Record<string, number>>,
) {
  const entries = Object.entries(conditions)
    .filter(([, metrics]) => Object.keys(metrics).length > 0)
    .sort((left, right) => {
      const scoreDiff = conditionScore(right[1]) - conditionScore(left[1]);
      if (scoreDiff !== 0) return scoreDiff;
      return Object.keys(right[1]).length - Object.keys(left[1]).length;
    });
  return entries[0] || null;
}

function parseManifestPayload(payload: unknown, scriptName: string): NormalizedImportedResult | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;

  const verdictRaw = typeof record.verdict === "string" ? record.verdict.toLowerCase() : "inconclusive";
  const verdict: ImportedVerdict = verdictRaw === "better"
    || verdictRaw === "worse"
    || verdictRaw === "error"
    ? verdictRaw
    : "inconclusive";

  const topLevelMetrics = normalizeMetrics(record.metrics);
  const topLevelScalars = readTopLevelScalarMetrics(record);
  const rawMetrics = normalizeMetrics(record.raw_metrics);
  let condition = typeof record.condition === "string" ? record.condition : null;
  let summary = typeof record.summary === "string" ? record.summary.trim() : "";
  let metrics = Object.keys(topLevelMetrics).length > 0 ? topLevelMetrics : topLevelScalars;
  let structuredRaw = Object.keys(rawMetrics).length > 0 ? rawMetrics : null;
  const metadata: Record<string, unknown> = {};

  if (record.conditions && typeof record.conditions === "object" && !Array.isArray(record.conditions)) {
    const conditionMap = Object.fromEntries(
      Object.entries(record.conditions as Record<string, unknown>)
        .map(([name, value]) => [name, normalizeMetrics(value)])
        .filter(([, value]) => Object.keys(value).length > 0),
    ) as Record<string, Record<string, number>>;
    if (Object.keys(conditionMap).length > 0) {
      const representative = selectRepresentativeCondition(conditionMap);
      const flattened = flattenConditionMetrics(conditionMap);
      structuredRaw = Object.keys(topLevelScalars).length > 0
        ? { ...topLevelScalars, ...flattened }
        : flattened;
      condition = condition || representative?.[0] || "multi_condition_sweep";
      metrics = representative?.[1] || metrics;
      metadata.conditions = conditionMap;
      if (!summary) {
        summary = representative
          ? `${scriptName} completed a structured sweep across ${Object.keys(conditionMap).length} condition(s); "${representative[0]}" was the strongest recorded condition.`
          : `${scriptName} completed a structured sweep across ${Object.keys(conditionMap).length} condition(s).`;
      }
    }
  }

    if (Array.isArray(record.results)) {
    const normalizedRows = record.results
      .map((row) => {
        if (!row || typeof row !== "object" || Array.isArray(row)) return null;
        const resultRow = row as Record<string, unknown>;
        const conditionName = typeof resultRow.condition === "string"
          ? resultRow.condition
          : typeof resultRow.name === "string"
            ? resultRow.name
            : null;
        const rowMetrics = normalizeMetrics(resultRow.metrics || resultRow.raw_metrics);
        if (!conditionName || Object.keys(rowMetrics).length === 0) return null;
        return [conditionName, rowMetrics] as const;
      })
      .filter((row): row is readonly [string, Record<string, number>] => Boolean(row));
    if (normalizedRows.length > 0) {
      const conditionMap = Object.fromEntries(normalizedRows);
      const representative = selectRepresentativeCondition(conditionMap);
      structuredRaw = Object.keys(topLevelScalars).length > 0
        ? { ...topLevelScalars, ...flattenConditionMetrics(conditionMap) }
        : flattenConditionMetrics(conditionMap);
      condition = condition || representative?.[0] || "multi_condition_sweep";
      metrics = representative?.[1] || metrics;
      metadata.conditions = conditionMap;
      if (!summary) {
        summary = `${scriptName} completed a structured sweep across ${normalizedRows.length} condition(s).`;
      }
    }
  }

  if (!summary) {
    if (condition && Object.keys(metrics).length > 0) {
      summary = `${scriptName} completed condition "${condition}" and emitted a deterministic result manifest.`;
    } else {
      summary = `${scriptName} completed and emitted a deterministic result manifest.`;
    }
  }

  return {
    source: "manifest",
    scriptName,
    verdict,
    summary,
    condition,
    metrics,
    rawMetrics: structuredRaw,
    metadata: Object.keys(metadata).length > 0 ? metadata : null,
  };
}

function parseSummaryBlock(stdout: string, scriptName: string): NormalizedImportedResult | null {
  const normalized = stdout.replace(/\r/g, "");
  const marker = normalized.lastIndexOf("=== SUMMARY ===");
  if (marker < 0) return null;

  const lines = normalized
    .slice(marker)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const conditionMap: Record<string, Record<string, number>> = {};

  for (const line of lines) {
    if (line === "=== SUMMARY ===" || /^done!?$/i.test(line)) continue;

    const humanMatch = line.match(/^Human PPL:\s*([0-9.]+)\s*\|\s*PPL>40:\s*([0-9.]+)%/i);
    if (humanMatch) {
      const meanPpl = Number(humanMatch[1]);
      const asr40 = Number(humanMatch[2]);
      const metrics: Record<string, number> = {};
      if (Number.isFinite(meanPpl)) metrics.mean_ppl = meanPpl;
      if (Number.isFinite(asr40)) metrics.asr_40 = asr40;
      if (Object.keys(metrics).length > 0) {
        conditionMap.human_text = metrics;
      }
      continue;
    }

    const conditionMatch = line.match(/^([^:]+):\s*(.+)$/);
    if (!conditionMatch) continue;

    const label = conditionMatch[1].trim();
    const rest = conditionMatch[2];
    const metrics: Record<string, number> = {};
    const tokenRegex = /\b([A-Za-z][A-Za-z0-9@._>-]*)\s*=\s*([0-9]+(?:\.[0-9]+)?)%?/g;
    let tokenMatch: RegExpExecArray | null = tokenRegex.exec(rest);
    while (tokenMatch) {
      const rawKey = tokenMatch[1].toLowerCase();
      const numeric = Number(tokenMatch[2]);
      if (Number.isFinite(numeric)) {
        if (rawKey === "asr") metrics.asr_40 = numeric;
        else if (rawKey === "qasr") metrics.quality_asr = numeric;
        else if (rawKey === "sim") metrics.semantic_sim = numeric;
        else if (rawKey === "ppl") metrics.mean_ppl = numeric;
        else metrics[normalizeMetricKey(rawKey)] = numeric;
      }
      tokenMatch = tokenRegex.exec(rest);
    }

    if (Object.keys(metrics).length > 0) {
      conditionMap[label] = metrics;
    }
  }

  if (Object.keys(conditionMap).length === 0) return null;

  const nonReferenceConditions = Object.fromEntries(
    Object.entries(conditionMap).filter(([label]) => label !== "human_text"),
  );
  const representative = selectRepresentativeCondition(
    Object.keys(nonReferenceConditions).length > 0 ? nonReferenceConditions : conditionMap,
  );

  return {
    source: "stdout_summary",
    scriptName,
    verdict: "inconclusive",
    summary: representative
      ? `${scriptName} completed a human-readable summary sweep; "${representative[0]}" was the strongest recorded condition.`
      : `${scriptName} completed a human-readable summary sweep.`,
    condition: representative?.[0] || null,
    metrics: representative?.[1] || {},
    rawMetrics: flattenConditionMetrics(conditionMap),
    metadata: {
      conditions: conditionMap,
      format: "summary_block",
    },
  };
}

/**
 * Parse "METRIC: key = value" lines from stdout.
 * This is the format the agent's scripts actually produce.
 */
function parseMetricLines(stdout: string, scriptName: string): NormalizedImportedResult | null {
  const metricPattern = /^METRIC:\s*(\S+)\s*=\s*([0-9eE.+-]+)/gm;
  const metrics: Record<string, number> = {};
  let match;
  while ((match = metricPattern.exec(stdout)) !== null) {
    const key = normalizeMetricKey(match[1]);
    const value = Number(match[2]);
    if (Number.isFinite(value)) {
      metrics[key] = value;
    }
  }
  if (Object.keys(metrics).length === 0) return null;

  // Try to extract a summary line (=== DONE === or similar)
  const lastLines = stdout.split("\n").slice(-20).join("\n");
  const summary = lastLines.includes("DONE")
    ? `${scriptName} completed with ${Object.keys(metrics).length} metrics.`
    : `${scriptName} emitted ${Object.keys(metrics).length} METRIC lines.`;

  return {
    source: "metric_lines",
    scriptName,
    verdict: "inconclusive",
    summary,
    condition: null,
    metrics,
    rawMetrics: null,
    metadata: { metricCount: Object.keys(metrics).length },
  };
}

function parseStructuredStdoutSummary(stdout: string, scriptName: string): NormalizedImportedResult | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("CONDITION="));
  if (lines.length === 0) return null;

  const parsedConditions = lines.map((line) => {
    const tokens = line.split(/\s+/);
    const metrics: Record<string, number> = {};
    let condition = "";
    for (const token of tokens) {
      const [rawKey, rawValue] = token.split("=");
      if (!rawKey || rawValue === undefined) continue;
      const key = rawKey.trim();
      const value = rawValue.trim();
      if (key === "CONDITION") {
        condition = value;
        continue;
      }
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) continue;
      metrics[normalizeMetricKey(key)] = numeric;
    }
    if (!condition) return null;
    return { condition, metrics };
  }).filter((row): row is { condition: string; metrics: Record<string, number> } => Boolean(row));

  if (parsedConditions.length === 0) return null;

  if (parsedConditions.length === 1) {
    const first = parsedConditions[0];
    return {
      source: "stdout_summary",
      scriptName,
      verdict: "inconclusive",
      summary: `${scriptName} completed condition "${first.condition}" and emitted machine-readable summary lines.`,
      condition: first.condition,
      metrics: first.metrics,
      rawMetrics: null,
      metadata: { summaryLines: parsedConditions.length },
    };
  }

  const conditionMap = Object.fromEntries(parsedConditions.map((row) => [row.condition, row.metrics]));
  const representative = selectRepresentativeCondition(conditionMap);
  return {
    source: "stdout_summary",
    scriptName,
    verdict: "inconclusive",
    summary: `${scriptName} completed a structured stdout sweep across ${parsedConditions.length} condition(s).`,
    condition: representative?.[0] || "multi_condition_sweep",
    metrics: representative?.[1] || {},
    rawMetrics: flattenConditionMetrics(conditionMap),
    metadata: {
      conditions: conditionMap,
      summaryLines: parsedConditions.length,
    },
  };
}

function parseLegacyTableSummary(stdout: string, scriptName: string): NormalizedImportedResult | null {
  const normalized = stdout.replace(/\r/g, "");
  const marker = normalized.lastIndexOf("SUMMARY (");
  if (marker < 0) return null;

  const lines = normalized.slice(marker).split("\n");
  const conditionMap: Record<string, Record<string, number>> = {};

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || /^=+$/.test(line) || /^SUMMARY \(/.test(line) || /^Mean PPL/i.test(line)) {
      continue;
    }
    if (!/\d/.test(line)) continue;

    const parts = line.split(/\s{2,}/).map((part) => part.trim()).filter(Boolean);
    if (parts.length < 3) continue;

    const label = parts[0];
    const meanPpl = Number(parts[1]);
    const asrRaw = parts[2].replace(/%$/, "");
    const meanSim = parts[3] && parts[3] !== "N/A" ? Number(parts[3]) : null;
    const metrics: Record<string, number> = {};

    if (Number.isFinite(meanPpl)) metrics.mean_ppl = meanPpl;
    const asrValue = Number(asrRaw);
    if (Number.isFinite(asrValue)) metrics.asr_40 = asrValue;
    if (meanSim !== null && Number.isFinite(meanSim)) metrics.mean_sim = meanSim;
    if (Object.keys(metrics).length === 0) continue;

    conditionMap[label] = metrics;
  }

  if (Object.keys(conditionMap).length === 0) return null;

  const nonReferenceConditions = Object.fromEntries(
    Object.entries(conditionMap).filter(([label]) => !/^human\b/i.test(label)),
  );
  const representative = selectRepresentativeCondition(
    Object.keys(nonReferenceConditions).length > 0 ? nonReferenceConditions : conditionMap,
  );

  return {
    source: "stdout_table",
    scriptName,
    verdict: "inconclusive",
    summary: representative
      ? `${scriptName} completed a tabular stdout sweep; "${representative[0]}" was the strongest recorded condition.`
      : `${scriptName} completed a tabular stdout sweep.`,
    condition: representative?.[0] || null,
    metrics: representative?.[1] || {},
    rawMetrics: flattenConditionMetrics(conditionMap),
    metadata: {
      conditions: conditionMap,
      format: "legacy_summary_table",
    },
  };
}

function parseMetricJson(raw: string | null | undefined) {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => typeof value === "number" && Number.isFinite(value)),
    ) as Record<string, number>;
  } catch {
    return {};
  }
}

function tokenize(text: string | null | undefined) {
  return (text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 4);
}

function importedContextText(result: NormalizedImportedResult) {
  return [
    result.scriptName,
    result.condition || "",
    result.summary,
    ...Object.keys(result.metrics),
  ].join(" ");
}

function scoreClaimLinkCandidate(candidate: ClaimLinkCandidate, imported: NormalizedImportedResult, hypothesisId: string | null) {
  if (candidate.createdBy === "system") return Number.NEGATIVE_INFINITY;
  if (candidate.createdFrom?.startsWith("auto_import_")) return Number.NEGATIVE_INFINITY;
  if (candidate.resultId) return Number.NEGATIVE_INFINITY;
  if (candidate.evidence.some((evidence) => evidence.kind === "experiment_result")) return Number.NEGATIVE_INFINITY;

  let score = 0;
  if (hypothesisId && candidate.hypothesisId === hypothesisId) score += 5;
  if (!hypothesisId && candidate.hypothesisId === null) score += 2;
  if (candidate.createdFrom === "record_claim") score += 3;
  if (candidate.createdFrom === "update_hypothesis") score += 2;

  const contextTokens = new Set(tokenize(importedContextText(imported)));
  let overlap = 0;
  for (const token of tokenize(candidate.statement)) {
    if (contextTokens.has(token)) overlap += 1;
  }
  score += Math.min(overlap, 4);

  const ageMs = Math.abs(candidate.createdAt.getTime() - Date.now());
  if (ageMs < 24 * 60 * 60 * 1000) score += 1;
  return score;
}

async function findLinkableClaim(params: {
  projectId: string;
  hypothesisId: string | null;
  imported: NormalizedImportedResult;
}) {
  const candidates = await prisma.researchClaim.findMany({
    where: {
      projectId: params.projectId,
      status: { not: "RETRACTED" },
      type: { in: ["finding", "comparison", "hypothesis_assessment", "methodological", "reproduction"] },
    },
    select: {
      id: true,
      statement: true,
      hypothesisId: true,
      createdBy: true,
      createdFrom: true,
      resultId: true,
      createdAt: true,
      evidence: { select: { kind: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 25,
  });

  const ranked = candidates
    .map((candidate) => ({
      candidate,
      score: scoreClaimLinkCandidate(candidate, params.imported, params.hypothesisId),
    }))
    .filter((item) => Number.isFinite(item.score) && item.score >= 5)
    .sort((left, right) => right.score - left.score);

  if (ranked.length === 0) return null;
  if (ranked.length > 1 && ranked[0].score === ranked[1].score) return null;
  return ranked[0].candidate;
}

async function tryReadJsonFile(localDir: string, relativePath: string): Promise<unknown | null> {
  try {
    const fs = await import("fs/promises");
    const filePath = path.join(localDir, relativePath);
    const content = await fs.readFile(filePath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function listJsonCandidates(localDir: string) {
  try {
    const fs = await import("fs/promises");
    const [rootEntries, resultsEntries] = await Promise.all([
      fs.readdir(localDir).catch(() => [] as string[]),
      fs.readdir(path.join(localDir, "results")).catch(() => [] as string[]),
    ]);

    const rootCandidates = rootEntries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => entry);
    const resultsCandidates = resultsEntries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => path.join("results", entry));
    return [...rootCandidates, ...resultsCandidates];
  } catch {
    return [] as string[];
  }
}

async function findResultManifest(localDir: string, scriptName: string): Promise<NormalizedImportedResult | null> {
  const scriptStem = path.basename(scriptName, path.extname(scriptName));
  const familyPrefix = scriptStem.match(/^((?:poc|exp|analysis|sweep)_\d{3})_/i)?.[1] || null;
  const discoveredJsonFiles = await listJsonCandidates(localDir);
  const orderedCandidates = Array.from(new Set([
    path.join("results", "arcana_result.json"),
    "arcana_result.json",
    "results.mock.json",
    "results.json",
    path.join("results", "results.json"),
    `${scriptStem}_results.json`,
    path.join("results", `${scriptStem}_results.json`),
    ...(familyPrefix ? [`${familyPrefix}_results.json`, path.join("results", `${familyPrefix}_results.json`)] : []),
    ...discoveredJsonFiles
      .filter((candidate) => {
        const base = path.basename(candidate);
        if (base === "results.json") return true;
        if (!base.endsWith("_results.json")) return false;
        if (base.startsWith(scriptStem)) return true;
        if (familyPrefix && base.startsWith(familyPrefix)) return true;
        return false;
      }),
    ...(discoveredJsonFiles.filter((candidate) => path.basename(candidate).endsWith("_results.json")).length === 1
      ? discoveredJsonFiles.filter((candidate) => path.basename(candidate).endsWith("_results.json"))
      : []),
  ]));

  for (const candidate of orderedCandidates) {
    const payload = await tryReadJsonFile(localDir, candidate);
    if (!payload) continue;
    const normalized = parseManifestPayload(payload, scriptName);
    if (normalized) {
      if (candidate !== "arcana_result.json" && candidate !== path.join("results", "arcana_result.json")) {
        normalized.metadata = {
          ...(normalized.metadata || {}),
          importedFrom: candidate,
        };
      }
      return normalized;
    }
  }

  return null;
}

export async function importExperimentResultFromRemoteJob(jobId: string) {
  const existing = await prisma.experimentResult.findUnique({ where: { jobId } });
  if (existing) {
    return { imported: false, resultId: existing.id, reason: "already_recorded" as const };
  }

  const job = await prisma.remoteJob.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      projectId: true,
      localDir: true,
      hypothesisId: true,
      command: true,
      status: true,
      stdout: true,
      experimentPurpose: true,
      grounding: true,
      claimEligibility: true,
      promotionPolicy: true,
      evidenceClass: true,
    },
  });
  if (!job || !job.projectId || job.status !== "COMPLETED" || !job.localDir) {
    return { imported: false, reason: "job_not_importable" as const };
  }

  const scriptName = job.command.match(/python3?\s+(\S+\.py)/)?.[1] || job.command.slice(0, 64);
  const contract = resolveExperimentContract({
    scriptName,
    command: job.command,
    code: null,
    experimentPurpose: job.experimentPurpose,
    grounding: job.grounding,
    claimEligibility: job.claimEligibility,
    promotionPolicy: job.promotionPolicy,
    evidenceClass: job.evidenceClass,
  });

  const manifestResult = await findResultManifest(job.localDir, scriptName);
  const stdoutResult = manifestResult
    ? null
    : parseMetricLines(job.stdout || "", scriptName)
      || parseStructuredStdoutSummary(job.stdout || "", scriptName)
      || parseLegacyTableSummary(job.stdout || "", scriptName);
  const summaryBlockResult = manifestResult || stdoutResult
    ? null
    : parseSummaryBlock(job.stdout || "", scriptName);
  const imported = manifestResult || stdoutResult || summaryBlockResult;
  if (!imported) {
    // No structured result found — create a placeholder so the convergence
    // barrier doesn't deadlock the project. A completed job should never block
    // future work. The agent can refine this in ANALYSIS with record_result.
    const placeholder = await prisma.experimentResult.create({
      data: {
        projectId: job.projectId,
        jobId,
        hypothesisId: job.hypothesisId,
        experimentPurpose: contract.experimentPurpose,
        grounding: contract.grounding,
        claimEligibility: contract.claimEligibility,
        promotionPolicy: contract.promotionPolicy,
        evidenceClass: contract.evidenceClass,
        branchId: null,
        baselineId: null,
        scriptName,
        parameters: JSON.stringify({ command: job.command, source: "placeholder" }),
        metrics: "{}",
        rawMetrics: null,
        condition: null,
        comparison: null,
        verdict: "pending_analysis",
        reflection: "Auto-import could not parse structured results from stdout. Use record_result or extract_results to fill in metrics.",
      },
    });
    return { imported: true, resultId: placeholder.id, reason: "placeholder_created" as const };
  }

  const result = await prisma.experimentResult.create({
    data: {
      projectId: job.projectId,
      jobId,
      hypothesisId: job.hypothesisId,
      experimentPurpose: contract.experimentPurpose,
      grounding: contract.grounding,
      claimEligibility: contract.claimEligibility,
      promotionPolicy: contract.promotionPolicy,
      evidenceClass: contract.evidenceClass,
      branchId: null,
      baselineId: null,
      scriptName: imported.scriptName,
      parameters: JSON.stringify({
        command: job.command,
        source: imported.source,
        ...(imported.metadata ? { metadata: imported.metadata } : {}),
      }),
      metrics: JSON.stringify(imported.metrics),
      rawMetrics: imported.rawMetrics ? JSON.stringify(imported.rawMetrics) : null,
      condition: imported.condition,
      comparison: null,
      verdict: imported.verdict,
      reflection: imported.summary,
    },
  });

  let claimId: string | null = null;
  const linkedClaim = imported.source === "manifest"
    ? null
    : await findLinkableClaim({
        projectId: job.projectId,
        hypothesisId: job.hypothesisId || null,
        imported,
      });

  if (linkedClaim) {
    await prisma.researchClaim.update({
      where: { id: linkedClaim.id },
      data: { resultId: result.id },
    });
    await attachClaimEvidence(linkedClaim.id, {
      kind: "experiment_result",
      resultId: result.id,
      supports: imported.verdict !== "error",
      strength: claimEvidenceStrengthForExperiment(contract, imported.verdict !== "error"),
      rationale: `Recovered automatically from ${imported.source}.`,
    });
    claimId = linkedClaim.id;
  }

  await reconcileExperimentResultWithClaimCoordinator({
    projectId: job.projectId,
    resultId: result.id,
    remoteJobId: jobId,
    hypothesisId: job.hypothesisId || null,
    baselineResultId: null,
    verdict: imported.verdict,
    scriptName: imported.scriptName,
  }).catch(() => {});

  return {
    imported: true,
    resultId: result.id,
    claimId,
    source: imported.source,
  };
}

export async function recoverProjectRemoteResults(projectId: string, limit = 12) {
  const jobs = await prisma.remoteJob.findMany({
    where: {
      projectId,
      status: "COMPLETED",
    },
    orderBy: { completedAt: "desc" },
    take: limit,
    select: { id: true },
  });
  if (jobs.length === 0) return { imported: 0, checked: 0 };

  const existing = await prisma.experimentResult.findMany({
    where: {
      projectId,
      jobId: { in: jobs.map((job) => job.id) },
    },
    select: { jobId: true },
  });
  const existingJobIds = new Set(existing.map((result) => result.jobId).filter((jobId): jobId is string => Boolean(jobId)));

  let importedCount = 0;
  for (const job of jobs) {
    if (existingJobIds.has(job.id)) continue;
    const imported = await importExperimentResultFromRemoteJob(job.id);
    if (imported.imported) importedCount += 1;
  }

  return { imported: importedCount, checked: jobs.length };
}

export async function repairAutoImportedStdoutClaims(projectId: string) {
  const candidates = await prisma.researchClaim.findMany({
    where: {
      projectId,
      createdBy: "system",
      createdFrom: "auto_import_stdout_summary",
    },
    include: {
      result: {
        select: {
          id: true,
          scriptName: true,
          condition: true,
          metrics: true,
          reflection: true,
          hypothesisId: true,
          jobId: true,
          experimentPurpose: true,
          grounding: true,
          claimEligibility: true,
          promotionPolicy: true,
          evidenceClass: true,
        },
      },
      evidence: { select: { kind: true } },
      _count: { select: { memories: true, insights: true } },
    },
  });

  let relinked = 0;
  let rewritten = 0;
  let deleted = 0;
  let skipped = 0;

  for (const claim of candidates) {
    if (!claim.result) {
      skipped += 1;
      continue;
    }

    const imported: NormalizedImportedResult = {
      source: "stdout_table",
      scriptName: claim.result.scriptName,
      verdict: "inconclusive",
      summary: claim.summary || claim.result.reflection || "",
      condition: claim.result.condition || null,
      metrics: parseMetricJson(claim.result.metrics),
      rawMetrics: null,
      metadata: null,
    };

    const linkedClaim = await findLinkableClaim({
      projectId,
      hypothesisId: claim.result.hypothesisId || null,
      imported,
    });

    if (linkedClaim && linkedClaim.id !== claim.id) {
      await prisma.researchClaim.update({
        where: { id: linkedClaim.id },
        data: { resultId: claim.result.id },
      });
      const existingEvidence = await prisma.claimEvidence.findMany({
        where: { claimId: linkedClaim.id },
        select: { kind: true, resultId: true, remoteJobId: true },
      });
      const hasResultEvidence = existingEvidence.some((evidence) =>
        evidence.kind === "experiment_result" && evidence.resultId === claim.result!.id
      );
      if (!hasResultEvidence) {
        const resultContract = resolveExperimentContract({
          scriptName: claim.result.scriptName,
          experimentPurpose: claim.result.experimentPurpose,
          grounding: claim.result.grounding,
          claimEligibility: claim.result.claimEligibility,
          promotionPolicy: claim.result.promotionPolicy,
          evidenceClass: claim.result.evidenceClass,
        });
        await attachClaimEvidence(linkedClaim.id, {
          kind: "experiment_result",
          resultId: claim.result.id,
          supports: true,
          strength: claimEvidenceStrengthForExperiment(resultContract, true),
          rationale: "Recovered from legacy stdout-import claim.",
        });
      }
      const safeToDelete = claim._count.memories === 0 && claim._count.insights === 0;
      if (safeToDelete) {
        await prisma.researchClaim.delete({ where: { id: claim.id } });
        deleted += 1;
      } else {
        await prisma.researchClaim.update({
          where: { id: claim.id },
          data: { status: "RETRACTED", notes: "Superseded by linked manual claim during stdout-import repair." },
        });
        await syncClaimMemoryLifecycle(claim.id, "RETRACTED");
      }
      relinked += 1;
      continue;
    }

    await prisma.researchClaim.update({
      where: { id: claim.id },
      data: {
        status: "RETRACTED",
        notes: claim._count.memories === 0 && claim._count.insights === 0
          ? "Retired automatically: auto-imported result rows stay in ExperimentResult unless they are linked to an explicit claim."
          : `${claim.notes || ""}${claim.notes ? "\n\n" : ""}Retired automatically: auto-imported result rows stay in ExperimentResult unless they are linked to an explicit claim.`,
      },
    });
    await syncClaimMemoryLifecycle(claim.id, "RETRACTED");
    rewritten += 1;
  }

  return { relinked, rewritten, deleted, skipped };
}

export async function resultManifestExists(localDir: string) {
  const fs = await import("fs/promises");
  for (const candidate of [
    path.join(localDir, "results", "arcana_result.json"),
    path.join(localDir, "arcana_result.json"),
    path.join(localDir, "results.mock.json"),
  ]) {
    try {
      await fs.stat(candidate);
      return true;
    } catch {
      continue;
    }
  }
  return false;
}
