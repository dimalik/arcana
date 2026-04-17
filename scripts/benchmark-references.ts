import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { dirname, isAbsolute, resolve } from "path";

import { normalizeIdentifier } from "../src/lib/canonical/normalize";
import { fetchArxivMetadata } from "../src/lib/import/arxiv";
import { fetchDoiMetadata } from "../src/lib/import/url";
import { scoreExtraction, type ExpectedRef, type ExtractedRef, type ScoreResult } from "../src/lib/references/benchmark";
import { extractReferenceCandidates } from "../src/lib/references/extraction";
import type { ReferenceExtractionCandidate } from "../src/lib/references/types";

const BENCHMARK_DIR = resolve(process.cwd(), "benchmark/references");
const MANIFEST_PATH = resolve(BENCHMARK_DIR, "manifest.json");
const BASELINE_PATH = resolve(BENCHMARK_DIR, "baseline.json");
const REPORT_PATH = resolve(BENCHMARK_DIR, "baseline.md");
const SCORE_EPSILON = 0.01;
const RESOLUTION_CONCURRENCY = 2;

export interface BenchmarkManifestPaper {
  paperId: string;
  pdfPath: string;
  sourceCategory: string;
  expectedPath?: string | null;
  notes?: string | null;
}

export interface BenchmarkManifest {
  description: string;
  papers: BenchmarkManifestPaper[];
}

export interface PaperBaseline {
  paperId: string;
  pdfPath: string;
  sourceCategory: string;
  expectedPath: string | null;
  extractorMethod: string;
  extractorStatus: string;
  extractorVersion: string;
  fallbackReason: string | null;
  errorSummary: string | null;
  extractedReferenceCount: number;
  identifierBackedReferenceCount: number;
  resolvedEntityCount: number;
  promotedCitesCount: number;
  scores: (ScoreResult & { expectedCount: number }) | null;
}

export interface BenchmarkBaseline {
  generatedAt: string;
  corpusSize: number;
  papers: PaperBaseline[];
  totals: {
    extractedReferenceCount: number;
    identifierBackedReferenceCount: number;
    resolvedEntityCount: number;
    promotedCitesCount: number;
    scoredPaperCount: number;
    expectedCount: number;
    matched: number;
    missed: number;
    extra: number;
    precision: number | null;
    recall: number | null;
    f1: number | null;
  };
}

interface BenchmarkModelConfig {
  provider: "openai" | "anthropic" | "proxy";
  modelId: string;
  proxyConfig?: {
    enabled: boolean;
    vendor: string;
    baseUrl: string;
    anthropicBaseUrl: string;
    apiKey: string;
    headerName: string;
    headerValue: string;
    modelId: string;
    contextWindow: number;
    maxTokens: number;
    routes: never[];
  };
}

function resolveManifestPath(targetPath: string): string {
  return isAbsolute(targetPath) ? targetPath : resolve(process.cwd(), targetPath);
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(readFileSync(filePath, "utf-8")) as T;
}

function loadManifest(manifestPath = MANIFEST_PATH): BenchmarkManifest {
  if (!existsSync(manifestPath)) {
    throw new Error(`Manifest not found: ${manifestPath}`);
  }

  const manifest = readJsonFile<BenchmarkManifest>(manifestPath);
  if (!Array.isArray(manifest.papers)) {
    throw new Error(`Invalid manifest: ${manifestPath}`);
  }

  return manifest;
}

function getBenchmarkModelConfig(): BenchmarkModelConfig {
  if (process.env.LLM_PROXY_URL && process.env.LLM_PROXY_HEADER_VALUE) {
    const modelId = process.env.LLM_PROXY_MODEL_ID || "gpt-4o";
    return {
      provider: "proxy",
      modelId,
      proxyConfig: {
        enabled: true,
        vendor: "custom",
        baseUrl: process.env.LLM_PROXY_URL,
        anthropicBaseUrl: process.env.LLM_PROXY_ANTHROPIC_URL || "",
        apiKey: process.env.LLM_PROXY_API_KEY || "",
        headerName: process.env.LLM_PROXY_HEADER_NAME || "X-LLM-Proxy-Calling-Service",
        headerValue: process.env.LLM_PROXY_HEADER_VALUE,
        modelId,
        contextWindow: parseInt(process.env.LLM_PROXY_CONTEXT_WINDOW || "128000", 10),
        maxTokens: parseInt(process.env.LLM_PROXY_MAX_TOKENS || "4096", 10),
        routes: [],
      },
    };
  }

  if (process.env.OPENAI_API_KEY) {
    return { provider: "openai", modelId: process.env.BENCHMARK_OPENAI_MODEL || "gpt-4o-mini" };
  }

  if (process.env.ANTHROPIC_API_KEY) {
    return {
      provider: "anthropic",
      modelId: process.env.BENCHMARK_ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
    };
  }

  return { provider: "openai", modelId: process.env.BENCHMARK_OPENAI_MODEL || "gpt-4o-mini" };
}

function loadExpectedRefs(expectedPath: string | null | undefined): ExpectedRef[] | null {
  if (!expectedPath) return null;

  const resolvedPath = resolveManifestPath(expectedPath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Expected references file not found: ${resolvedPath}`);
  }

  const parsed = readJsonFile<{ refs?: ExpectedRef[] } | ExpectedRef[]>(resolvedPath);
  if (Array.isArray(parsed)) {
    return parsed;
  }

  if (Array.isArray(parsed.refs)) {
    return parsed.refs;
  }

  throw new Error(`Invalid expected references file: ${resolvedPath}`);
}

function summarizeBaseline(papers: PaperBaseline[]): BenchmarkBaseline {
  let extractedReferenceCount = 0;
  let identifierBackedReferenceCount = 0;
  let resolvedEntityCount = 0;
  let promotedCitesCount = 0;
  let scoredPaperCount = 0;
  let expectedCount = 0;
  let matched = 0;
  let missed = 0;
  let extra = 0;

  for (const paper of papers) {
    extractedReferenceCount += paper.extractedReferenceCount;
    identifierBackedReferenceCount += paper.identifierBackedReferenceCount;
    resolvedEntityCount += paper.resolvedEntityCount;
    promotedCitesCount += paper.promotedCitesCount;
    if (!paper.scores) continue;

    scoredPaperCount += 1;
    expectedCount += paper.scores.expectedCount;
    matched += paper.scores.matched;
    missed += paper.scores.missed;
    extra += paper.scores.extra;
  }

  const precision =
    scoredPaperCount > 0 && matched + extra > 0 ? matched / (matched + extra) : null;
  const recall =
    scoredPaperCount > 0 && expectedCount > 0 ? matched / expectedCount : null;
  const f1 =
    precision !== null && recall !== null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : null;

  return {
    generatedAt: new Date().toISOString(),
    corpusSize: papers.length,
    papers,
    totals: {
      extractedReferenceCount,
      identifierBackedReferenceCount,
      resolvedEntityCount,
      promotedCitesCount,
      scoredPaperCount,
      expectedCount,
      matched,
      missed,
      extra,
      precision,
      recall,
      f1,
    },
  };
}

// Keep Phase 0 resolution metrics on the exact-ID path only so the benchmark
// stays rerunnable without title-search provider drift.
const exactResolutionCache = new Map<string, Promise<boolean>>();

function cachedExactResolution(
  cacheKey: string,
  lookup: () => Promise<boolean>,
): Promise<boolean> {
  const existing = exactResolutionCache.get(cacheKey);
  if (existing) return existing;

  const promise = lookup()
    .catch(() => false)
    .then((result) => {
      exactResolutionCache.set(cacheKey, Promise.resolve(result));
      return result;
    });
  exactResolutionCache.set(cacheKey, promise);
  return promise;
}

async function hasExactResolution(
  candidate: Pick<ReferenceExtractionCandidate, "doi" | "arxivId">,
): Promise<boolean> {
  if (candidate.doi) {
    const normalizedDoi = normalizeIdentifier("doi", candidate.doi);
    return cachedExactResolution(`doi:${normalizedDoi}`, async () => {
      const metadata = await fetchDoiMetadata(normalizedDoi);
      return Boolean(metadata);
    });
  }

  if (candidate.arxivId) {
    const normalizedArxiv = normalizeIdentifier("arxiv", candidate.arxivId);
    return cachedExactResolution(`arxiv:${normalizedArxiv}`, async () => {
      const metadata = await fetchArxivMetadata(normalizedArxiv);
      return Boolean(metadata);
    });
  }

  return false;
}

async function measureResolutionMetrics(
  candidates: ReferenceExtractionCandidate[],
): Promise<{ resolvedEntityCount: number; promotedCitesCount: number }> {
  const identifierBackedCandidates = candidates.filter(
    (candidate) => Boolean(candidate.doi || candidate.arxivId),
  );
  let cursor = 0;
  let resolvedEntityCount = 0;
  let promotedCitesCount = 0;

  async function worker(): Promise<void> {
    while (cursor < identifierBackedCandidates.length) {
      const candidate = identifierBackedCandidates[cursor];
      cursor += 1;

      try {
        const resolved = await hasExactResolution(candidate);
        if (!resolved) continue;
        resolvedEntityCount += 1;
        promotedCitesCount += 1;
      } catch {
        continue;
      }
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(RESOLUTION_CONCURRENCY, identifierBackedCandidates.length || 1) },
      () =>
      worker(),
    ),
  );

  return { resolvedEntityCount, promotedCitesCount };
}

async function capturePaperBaseline(
  manifestPaper: BenchmarkManifestPaper,
): Promise<PaperBaseline> {
  const pdfPath = resolveManifestPath(manifestPaper.pdfPath);
  if (!existsSync(pdfPath)) {
    throw new Error(`PDF not found: ${pdfPath}`);
  }

  const { extractTextFromPdf } = await import("../src/lib/pdf/parser");

  const expectedRefs = loadExpectedRefs(manifestPaper.expectedPath);
  const fullText = await extractTextFromPdf(pdfPath);
  const { provider, modelId, proxyConfig } = getBenchmarkModelConfig();
  const extraction = await extractReferenceCandidates({
    paperId: manifestPaper.paperId,
    filePath: pdfPath,
    fullText,
    provider,
    modelId,
    proxyConfig,
  });

  const extracted = extraction.candidates.map<ExtractedRef>((candidate) => ({
    title: candidate.title,
    year: candidate.year,
    doi: candidate.doi,
  }));
  const identifierBackedReferenceCount = extraction.candidates.filter(
    (candidate) => Boolean(candidate.doi || candidate.arxivId),
  ).length;
  const resolutionMetrics = await measureResolutionMetrics(extraction.candidates);
  const scores = expectedRefs
    ? {
        ...scoreExtraction(expectedRefs, extracted),
        expectedCount: expectedRefs.length,
      }
    : null;

  return {
    paperId: manifestPaper.paperId,
    pdfPath: manifestPaper.pdfPath,
    sourceCategory: manifestPaper.sourceCategory,
    expectedPath: manifestPaper.expectedPath ?? null,
    extractorMethod: extraction.method,
    extractorStatus: extraction.status,
    extractorVersion: extraction.extractorVersion,
    fallbackReason: extraction.fallbackReason ?? null,
    errorSummary: null,
    extractedReferenceCount: extraction.candidates.length,
    identifierBackedReferenceCount,
    resolvedEntityCount: resolutionMetrics.resolvedEntityCount,
    promotedCitesCount: resolutionMetrics.promotedCitesCount,
    scores,
  };
}

async function captureBaseline(manifestPath = MANIFEST_PATH): Promise<BenchmarkBaseline> {
  const manifest = loadManifest(manifestPath);
  const papers: PaperBaseline[] = [];

  for (const paper of manifest.papers) {
    console.log(`Capturing ${paper.paperId} (${paper.sourceCategory})`);
    try {
      papers.push(await capturePaperBaseline(paper));
    } catch (error) {
      papers.push({
        paperId: paper.paperId,
        pdfPath: paper.pdfPath,
        sourceCategory: paper.sourceCategory,
        expectedPath: paper.expectedPath ?? null,
        extractorMethod: "unavailable",
        extractorStatus: "failed",
        extractorVersion: "unavailable",
        fallbackReason: null,
        errorSummary: error instanceof Error ? error.message : String(error),
        extractedReferenceCount: 0,
        identifierBackedReferenceCount: 0,
        resolvedEntityCount: 0,
        promotedCitesCount: 0,
        scores: null,
      });
    }
  }

  return summarizeBaseline(papers);
}

function writeJson(filePath: string, data: unknown): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2) + "\n");
}

function formatMetric(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(2);
}

function baselineToMarkdown(baseline: BenchmarkBaseline): string {
  const lines = [
    "# Reference Benchmark Baseline",
    "",
    `Generated: ${baseline.generatedAt}`,
    `Corpus size: ${baseline.corpusSize}`,
    "",
    "| Paper | Category | Method | Status | Extracted | Identifier-backed | Resolved | Promotable cites | P | R | F1 |",
    "|-------|----------|--------|--------|----------:|------------------:|---------:|-----------------:|---|---|----|",
  ];

  for (const paper of baseline.papers) {
    lines.push(
      `| ${paper.paperId} | ${paper.sourceCategory} | ${paper.extractorMethod} | ${paper.extractorStatus} | ${paper.extractedReferenceCount} | ${paper.identifierBackedReferenceCount} | ${paper.resolvedEntityCount} | ${paper.promotedCitesCount} | ${formatMetric(paper.scores?.precision ?? null)} | ${formatMetric(paper.scores?.recall ?? null)} | ${formatMetric(paper.scores?.f1 ?? null)} |`,
    );
  }

  lines.push(
    `| **OVERALL** |  |  |  | **${baseline.totals.extractedReferenceCount}** | **${baseline.totals.identifierBackedReferenceCount}** | **${baseline.totals.resolvedEntityCount}** | **${baseline.totals.promotedCitesCount}** | **${formatMetric(baseline.totals.precision)}** | **${formatMetric(baseline.totals.recall)}** | **${formatMetric(baseline.totals.f1)}** |`,
  );

  return lines.join("\n") + "\n";
}

function comparePaperRegression(
  baselinePaper: PaperBaseline,
  currentPaper: PaperBaseline,
): string[] {
  const failures: string[] = [];

  if (baselinePaper.scores && currentPaper.scores) {
    if (currentPaper.scores.precision + SCORE_EPSILON < baselinePaper.scores.precision) {
      failures.push(
        `${baselinePaper.paperId}: precision regressed ${currentPaper.scores.precision.toFixed(2)} < ${baselinePaper.scores.precision.toFixed(2)}`,
      );
    }
    if (currentPaper.scores.recall + SCORE_EPSILON < baselinePaper.scores.recall) {
      failures.push(
        `${baselinePaper.paperId}: recall regressed ${currentPaper.scores.recall.toFixed(2)} < ${baselinePaper.scores.recall.toFixed(2)}`,
      );
    }
    if (currentPaper.scores.f1 + SCORE_EPSILON < baselinePaper.scores.f1) {
      failures.push(
        `${baselinePaper.paperId}: f1 regressed ${currentPaper.scores.f1.toFixed(2)} < ${baselinePaper.scores.f1.toFixed(2)}`,
      );
    }
    return failures;
  }

  if (currentPaper.extractedReferenceCount < baselinePaper.extractedReferenceCount) {
    failures.push(
      `${baselinePaper.paperId}: extracted references regressed ${currentPaper.extractedReferenceCount} < ${baselinePaper.extractedReferenceCount}`,
    );
  }

  if (
    currentPaper.identifierBackedReferenceCount <
    baselinePaper.identifierBackedReferenceCount
  ) {
    failures.push(
      `${baselinePaper.paperId}: identifier-backed references regressed ${currentPaper.identifierBackedReferenceCount} < ${baselinePaper.identifierBackedReferenceCount}`,
    );
  }

  if (currentPaper.resolvedEntityCount < baselinePaper.resolvedEntityCount) {
    failures.push(
      `${baselinePaper.paperId}: resolved entities regressed ${currentPaper.resolvedEntityCount} < ${baselinePaper.resolvedEntityCount}`,
    );
  }

  if (currentPaper.promotedCitesCount < baselinePaper.promotedCitesCount) {
    failures.push(
      `${baselinePaper.paperId}: promotable cites regressed ${currentPaper.promotedCitesCount} < ${baselinePaper.promotedCitesCount}`,
    );
  }

  return failures;
}

async function runCaptureMode(): Promise<void> {
  const baseline = await captureBaseline();
  writeJson(BASELINE_PATH, baseline);
  console.log(`Baseline written to ${BASELINE_PATH}`);
}

async function runCheckMode(): Promise<void> {
  if (!existsSync(BASELINE_PATH)) {
    console.log("No baseline found. Run --capture first.");
    process.exit(1);
  }

  const baseline = readJsonFile<BenchmarkBaseline>(BASELINE_PATH);
  const current = await captureBaseline();
  const currentByPaperId = new Map(current.papers.map((paper) => [paper.paperId, paper]));
  const failures: string[] = [];

  for (const baselinePaper of baseline.papers) {
    const currentPaper = currentByPaperId.get(baselinePaper.paperId);
    if (!currentPaper) {
      failures.push(`${baselinePaper.paperId}: missing from current benchmark run`);
      continue;
    }

    if (baselinePaper.extractorStatus === "failed" && currentPaper.extractorStatus === "failed") {
      continue;
    }

    if (baselinePaper.extractorStatus !== "failed" && currentPaper.extractorStatus === "failed") {
      failures.push(
        `${baselinePaper.paperId}: benchmark run failed (${currentPaper.errorSummary ?? "unknown error"})`,
      );
      continue;
    }

    failures.push(...comparePaperRegression(baselinePaper, currentPaper));
  }

  if (failures.length > 0) {
    console.error("Reference benchmark regression detected:");
    for (const failure of failures) {
      console.error(`- ${failure}`);
    }
    process.exit(1);
  }

  console.log("Reference benchmark check passed.");
}

function runReportMode(): void {
  if (!existsSync(BASELINE_PATH)) {
    console.log("No baseline found. Run --capture first.");
    process.exit(1);
  }

  const baseline = readJsonFile<BenchmarkBaseline>(BASELINE_PATH);
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, baselineToMarkdown(baseline));
  console.log(`Benchmark report written to ${REPORT_PATH}`);
}

async function main(): Promise<void> {
  if (process.argv.includes("--capture")) {
    await runCaptureMode();
    return;
  }

  if (process.argv.includes("--report")) {
    runReportMode();
    return;
  }

  await runCheckMode();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
