/**
 * Data-driven figure generation.
 *
 * The pipeline:
 *  1. Extract all numeric metrics from paper digests (already computed during MAPPING)
 *  2. Group metrics by normalized name (e.g., "accuracy", "f1", "bleu")
 *  3. Filter to groups where ≥3 papers report the same metric
 *  4. Build chart data directly from the numbers — NO LLM involved in data
 *  5. Ask the LLM ONLY to: pick which figures tell a story, write titles/captions
 *     that connect to the synthesis narrative, and optionally reorder
 *
 * This guarantees every number on a chart is real, traceable to a paper digest.
 */

import type { PaperDigest, FigureSpec, SynthesisPlan } from "./types";

// ── Types ──

interface ParsedMetric {
  paperId: string;
  paperLabel: string;
  metricName: string;        // raw key from digest
  normalizedName: string;    // cleaned, lowercased group key
  value: number;
  unit: string;              // "%", "ms", "" etc.
}

interface MetricGroup {
  normalizedName: string;
  displayName: string;
  unit: string;
  entries: { paperId: string; label: string; value: number }[];
}

interface CandidateFigure {
  id: string;
  chartType: "bar" | "grouped_bar";
  title: string;
  caption: string;
  xAxis: { label: string; key: string };
  yAxis: { label: string; key: string };
  data: Record<string, string | number>[];
  series?: { key: string; label: string }[];
  metricGroups: string[];  // for LLM context
}

// ── Metric parsing ──

const METRIC_ALIASES: Record<string, string> = {
  "acc": "accuracy",
  "accuracy": "accuracy",
  "top-1 accuracy": "accuracy",
  "top1": "accuracy",
  "test accuracy": "accuracy",
  "val accuracy": "accuracy",
  "f1": "f1-score",
  "f1-score": "f1-score",
  "f1_score": "f1-score",
  "f-1": "f1-score",
  "macro-f1": "f1-score",
  "micro-f1": "f1-score",
  "bleu": "bleu",
  "bleu-4": "bleu",
  "bleu4": "bleu",
  "rouge": "rouge-l",
  "rouge-l": "rouge-l",
  "rouge-1": "rouge-1",
  "rouge-2": "rouge-2",
  "rougel": "rouge-l",
  "precision": "precision",
  "recall": "recall",
  "auc": "auc",
  "auroc": "auc",
  "auc-roc": "auc",
  "map": "map",
  "map@5": "map",
  "perplexity": "perplexity",
  "ppl": "perplexity",
  "loss": "loss",
  "training loss": "loss",
  "test loss": "loss",
  "latency": "latency",
  "inference time": "latency",
  "params": "parameters",
  "parameters": "parameters",
  "model size": "parameters",
  "flops": "flops",
  "throughput": "throughput",
  "speedup": "speedup",
  "cer": "cer",
  "wer": "wer",
  "em": "exact-match",
  "exact match": "exact-match",
  "exact_match": "exact-match",
  "mrr": "mrr",
  "ndcg": "ndcg",
  "meteor": "meteor",
  "cider": "cider",
  "fid": "fid",
  "is": "inception-score",
  "inception score": "inception-score",
  "mse": "mse",
  "rmse": "rmse",
  "mae": "mae",
  "r2": "r-squared",
  "r-squared": "r-squared",
  "r²": "r-squared",
};

const DISPLAY_NAMES: Record<string, string> = {
  "accuracy": "Accuracy",
  "f1-score": "F1 Score",
  "bleu": "BLEU",
  "rouge-l": "ROUGE-L",
  "rouge-1": "ROUGE-1",
  "rouge-2": "ROUGE-2",
  "precision": "Precision",
  "recall": "Recall",
  "auc": "AUC",
  "map": "mAP",
  "perplexity": "Perplexity",
  "loss": "Loss",
  "latency": "Latency",
  "parameters": "Parameters",
  "flops": "FLOPs",
  "throughput": "Throughput",
  "cer": "CER",
  "wer": "WER",
  "exact-match": "Exact Match",
  "mrr": "MRR",
  "ndcg": "nDCG",
  "meteor": "METEOR",
  "cider": "CIDEr",
  "fid": "FID",
  "inception-score": "Inception Score",
  "mse": "MSE",
  "rmse": "RMSE",
  "mae": "MAE",
  "r-squared": "R²",
  "speedup": "Speedup",
};

// Metrics where lower is better
const LOWER_IS_BETTER = new Set([
  "perplexity", "loss", "latency", "cer", "wer", "fid", "mse", "rmse", "mae",
]);

function normalizeMetricName(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[_\-\s]+/g, " ").trim();
  // Direct alias match
  if (METRIC_ALIASES[cleaned]) return METRIC_ALIASES[cleaned];
  // Partial match
  for (const [alias, norm] of Object.entries(METRIC_ALIASES)) {
    if (cleaned.includes(alias) || alias.includes(cleaned)) return norm;
  }
  return cleaned;
}

function parseNumericValue(raw: string): { value: number; unit: string } | null {
  if (typeof raw === "number") return { value: raw, unit: "" };

  let str = String(raw).trim();
  if (!str) return null;

  // Strip parenthesized context: "96.62 (Longformer, China/Claude)" → "96.62"
  str = str.replace(/\s*\(.*?\)\s*/g, " ").trim();

  // Handle percentage: "95.2%", "95.2 %", "4.84 percentage points", "100.00%"
  const pctMatch = str.match(/^([+-]?\d+(?:\.\d+)?)\s*(?:%|percent(?:age)?\s*(?:points?)?)$/i);
  if (pctMatch) return { value: parseFloat(pctMatch[1]), unit: "%" };

  // Handle number with optional suffix: "95.2", "0.952", "1.2M", "0.1B parameters"
  const numMatch = str.match(/^([+-]?\d+(?:\.\d+)?)\s*([a-zA-Z]*)/);
  if (numMatch) {
    const val = parseFloat(numMatch[1]);
    const suffix = numMatch[2].toLowerCase();
    if (isNaN(val)) return null;

    // Convert multiplier suffixes
    let multiplier = 1;
    if (suffix === "k") multiplier = 1_000;
    else if (suffix === "m" || suffix === "million") multiplier = 1_000_000;
    else if (suffix === "b" || suffix === "billion") multiplier = 1_000_000_000;
    else if (suffix === "ms") return { value: val, unit: "ms" };
    else if (suffix === "s" || suffix === "sec") return { value: val, unit: "s" };
    else if (suffix === "parameters" || suffix === "params") return { value: val * multiplier, unit: "" };

    return { value: val * multiplier, unit: suffix && multiplier > 1 ? "" : suffix };
  }

  return null;
}

// ── Core logic ──

export function extractMetrics(
  digests: PaperDigest[],
  paperLabels: Map<string, string>
): ParsedMetric[] {
  const metrics: ParsedMetric[] = [];

  for (const d of digests) {
    if (!d.metrics || Object.keys(d.metrics).length === 0) continue;

    const label = paperLabels.get(d.paperId) || d.paperId.slice(0, 8);

    for (const [key, rawVal] of Object.entries(d.metrics)) {
      const parsed = parseNumericValue(rawVal);
      if (!parsed) continue;

      metrics.push({
        paperId: d.paperId,
        paperLabel: label,
        metricName: key,
        normalizedName: normalizeMetricName(key),
        value: parsed.value,
        unit: parsed.unit,
      });
    }
  }

  return metrics;
}

export function groupMetrics(metrics: ParsedMetric[], minPapers: number = 3): MetricGroup[] {
  const groups = new Map<string, ParsedMetric[]>();

  for (const m of metrics) {
    const list = groups.get(m.normalizedName) || [];
    // Deduplicate: one entry per paper per metric group
    if (!list.some((e) => e.paperId === m.paperId)) {
      list.push(m);
    }
    groups.set(m.normalizedName, list);
  }

  const result: MetricGroup[] = [];

  for (const [normName, entries] of Array.from(groups.entries())) {
    if (entries.length < minPapers) continue;

    // Check values are on comparable scales
    const values = entries.map((e: ParsedMetric) => e.value);
    const min = Math.min(...values);
    const max = Math.max(...values);

    // Skip if values span wildly different scales (likely different metrics conflated)
    // Allow 100x range for things like parameters/FLOPs, stricter for scores
    const isScoreMetric = values.every((v: number) => v >= 0 && v <= 100);
    if (!isScoreMetric && max > 0 && min > 0 && max / min > 100) continue;

    const unit = entries[0].unit || (isScoreMetric ? "%" : "");
    const displayName = DISPLAY_NAMES[normName] || normName.split("-").map(
      (w: string) => w.charAt(0).toUpperCase() + w.slice(1)
    ).join(" ");

    result.push({
      normalizedName: normName,
      displayName,
      unit,
      entries: entries.map((e: ParsedMetric) => ({
        paperId: e.paperId,
        label: e.paperLabel,
        value: e.value,
      })),
    });
  }

  // Sort by number of papers (more papers = more interesting comparison)
  result.sort((a, b) => b.entries.length - a.entries.length);

  return result;
}

export function buildCandidateFigures(
  groups: MetricGroup[],
  sections: { title: string; content: string }[]
): CandidateFigure[] {
  const figures: CandidateFigure[] = [];

  // 1. Individual metric bar charts (for the top groups)
  for (const group of groups.slice(0, 5)) {
    const lowerBetter = LOWER_IS_BETTER.has(group.normalizedName);
    const sorted = [...group.entries].sort((a, b) =>
      lowerBetter ? a.value - b.value : b.value - a.value
    );

    figures.push({
      id: `single-${group.normalizedName}`,
      chartType: "bar",
      title: `${group.displayName} Comparison`,
      caption: `${group.displayName} across ${group.entries.length} papers${lowerBetter ? " (lower is better)" : ""}.`,
      xAxis: { label: "Paper", key: "name" },
      yAxis: { label: `${group.displayName}${group.unit ? ` (${group.unit})` : ""}`, key: "value" },
      data: sorted.map((e) => ({ name: e.label, value: Math.round(e.value * 1000) / 1000 })),
      metricGroups: [group.normalizedName],
    });
  }

  // 2. Grouped bar charts for related metrics reported by the same papers
  const relatedPairs: [MetricGroup, MetricGroup][] = [];
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i];
      const b = groups[j];
      // Check overlap: papers that report both metrics
      const aIds = new Set(a.entries.map((e) => e.paperId));
      const overlap = b.entries.filter((e) => aIds.has(e.paperId));
      if (overlap.length >= 3) {
        // Check they're on compatible scales
        const aVals = a.entries.map((e) => e.value);
        const bVals = b.entries.map((e) => e.value);
        const aRange = [Math.min(...aVals), Math.max(...aVals)];
        const bRange = [Math.min(...bVals), Math.max(...bVals)];
        // Both should be percentage-like or both small-range
        const aIsPct = aRange[0] >= 0 && aRange[1] <= 100;
        const bIsPct = bRange[0] >= 0 && bRange[1] <= 100;
        if (aIsPct === bIsPct) {
          relatedPairs.push([a, b]);
        }
      }
    }
  }

  for (const [a, b] of relatedPairs.slice(0, 3)) {
    const aIds = new Set(a.entries.map((e) => e.paperId));
    const commonPapers = b.entries
      .filter((e) => aIds.has(e.paperId))
      .map((e) => e.paperId);

    const aMap = new Map(a.entries.map((e) => [e.paperId, e]));
    const bMap = new Map(b.entries.map((e) => [e.paperId, e]));

    const data = commonPapers.map((pid) => ({
      name: aMap.get(pid)!.label,
      [a.normalizedName]: Math.round(aMap.get(pid)!.value * 1000) / 1000,
      [b.normalizedName]: Math.round(bMap.get(pid)!.value * 1000) / 1000,
    }));

    figures.push({
      id: `grouped-${a.normalizedName}-${b.normalizedName}`,
      chartType: "grouped_bar",
      title: `${a.displayName} vs ${b.displayName}`,
      caption: `Comparing ${a.displayName} and ${b.displayName} across ${commonPapers.length} papers.`,
      xAxis: { label: "Paper", key: "name" },
      yAxis: { label: "Score", key: a.normalizedName },
      data,
      series: [
        { key: a.normalizedName, label: a.displayName },
        { key: b.normalizedName, label: b.displayName },
      ],
      metricGroups: [a.normalizedName, b.normalizedName],
    });
  }

  return figures;
}

// ── LLM selection prompt ──

export const FIGURE_NARRATIVE_PROMPT = {
  system: `You are a research visualization editor. You will be given candidate figures (with real, pre-computed data) and synthesis section summaries. Your job is to:

1. Select 1-4 figures that BEST SUPPORT the synthesis narrative
2. Write a short narrative title and caption for each selected figure that connects it to the synthesis findings
3. Optionally reorder them for narrative flow

Return a JSON object:
{
  "selectedFigures": [
    {
      "id": "candidate figure id",
      "title": "Narrative title connecting to synthesis findings",
      "caption": "1-2 sentences explaining what this figure reveals about the research landscape and how it supports the synthesis conclusions."
    }
  ]
}

Rules:
- ONLY select from the provided candidate IDs — do NOT invent new figures
- Do NOT modify any data values — titles and captions only
- Prefer figures that illustrate a trend, gap, or insight discussed in the synthesis
- Skip figures that would just show random results with no narrative value
- If no figures have narrative value, return {"selectedFigures": []}
- Return ONLY valid JSON.`,

  buildPrompt(candidates: CandidateFigure[], sectionSummaries: string): string {
    const candidateDesc = candidates.map((c) => {
      const dataPreview = c.data.slice(0, 3).map((d) => JSON.stringify(d)).join(", ");
      return `ID: ${c.id}\nType: ${c.chartType}\nDefault title: ${c.title}\nMetrics: ${c.metricGroups.join(", ")}\nPapers: ${c.data.length}\nData preview: [${dataPreview}${c.data.length > 3 ? ", ..." : ""}]`;
    }).join("\n\n");

    return `Candidate figures:\n\n${candidateDesc}\n\n---\n\nSynthesis section summaries:\n\n${sectionSummaries}`;
  },
};
