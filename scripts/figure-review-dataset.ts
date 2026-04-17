#!/usr/bin/env -S node --import tsx

import dataset from "./figure-review-dataset.json";

import { prisma } from "../src/lib/prisma";
import { normalizeLabel } from "../src/lib/figures/label-utils";
import {
  classifyFigureRolloutStatus,
  type FigureRolloutStatus,
} from "../src/lib/figures/figure-audit";

interface LabelTarget {
  expectPresent?: boolean | null;
  expectsImage?: boolean | null;
  expectedType?: string | null;
  expectedSourceMethod?: string | null;
  expectedImageSourceMethod?: string | null;
  expectedGapReason?: string | null;
  notes?: string;
}

interface PaperTargets {
  expectedRolloutStatus?: FigureRolloutStatus | null;
  expectedPrimaryFigures?: number | null;
  expectedFiguresWithImages?: number | null;
  minimumPrimaryFigures?: number | null;
  minimumFiguresWithImages?: number | null;
  maxGapFigures?: number | null;
  requiredLabels?: string[];
  forbiddenLabels?: string[];
  labelTargets?: Record<string, LabelTarget>;
}

interface DatasetPaper {
  paperId?: string;
  arxivId?: string;
  doi?: string;
  fileBasename?: string;
  title: string;
  bucket: string;
  priority: "critical" | "high" | "medium" | "low";
  reviewFocus: string;
  targetsStatus: "pending" | "partially_confirmed" | "confirmed";
  targets: PaperTargets;
}

interface ActualPrimaryFigure {
  figureLabel: string | null;
  type: string;
  sourceMethod: string;
  imageSourceMethod: string | null;
  imagePath: string | null;
  gapReason: string | null;
}

interface LoadedPaperState {
  paperId: string;
  title: string;
  arxivId: string | null;
  rolloutStatus: FigureRolloutStatus;
  primaryFigures: ActualPrimaryFigure[];
  figuresWithImages: number;
  gapFigures: number;
}

interface CheckResult {
  kind: "rollout" | "count" | "label_presence" | "label_absence" | "label_detail";
  label?: string;
  passed: boolean;
  message: string;
}

interface PaperScore {
  datasetPaper: DatasetPaper;
  resolvedPaperId: string | null;
  current: LoadedPaperState | null;
  checks: CheckResult[];
  currentBySourceMethod: Record<string, number>;
}

function hasOwn<T extends object>(value: T, key: keyof any): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function countBy(values: Array<string | null | undefined>, fallback = "unknown"): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const key = value && value.length > 0 ? value : fallback;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function normalizeFixtureLabel(label: string): string | null {
  return normalizeLabel(label);
}

async function resolvePaper(entry: DatasetPaper): Promise<{ id: string } | { error: string }> {
  if (entry.paperId) {
    const row = await prisma.paper.findUnique({
      where: { id: entry.paperId },
      select: { id: true },
    });
    return row ? { id: row.id } : { error: `paperId ${entry.paperId} not found` };
  }

  let where: Record<string, unknown> | null = null;
  let description = "";
  if (entry.arxivId) {
    where = { arxivId: entry.arxivId };
    description = `arxivId=${entry.arxivId}`;
  } else if (entry.doi) {
    where = { doi: entry.doi };
    description = `doi=${entry.doi}`;
  } else if (entry.fileBasename) {
    where = { filePath: { contains: entry.fileBasename } };
    description = `file=${entry.fileBasename}`;
  }

  if (!where) {
    return { error: "no stable identifier configured" };
  }

  const matches = await prisma.paper.findMany({
    where: where as never,
    select: { id: true },
    take: 3,
  });
  if (matches.length === 0) return { error: `${description} not found` };
  if (matches.length > 1) return { error: `${description} matched ${matches.length} papers` };
  return { id: matches[0].id };
}

async function loadPaperState(paperId: string): Promise<LoadedPaperState> {
  const [
    paper,
    extractionRunCount,
    bootstrapRunCount,
    primaryFigures,
  ] = await Promise.all([
    prisma.paper.findUnique({
      where: { id: paperId },
      select: {
        id: true,
        title: true,
        arxivId: true,
        publicationState: {
          select: {
            activeIdentityResolution: {
              select: {
                provenanceKind: true,
              },
            },
          },
        },
      },
    }),
    prisma.extractionRun.count({ where: { paperId } }),
    prisma.legacyPublicationBootstrapRun.count({ where: { paperId } }),
    prisma.paperFigure.findMany({
      where: { paperId, isPrimaryExtraction: true },
      orderBy: [{ figureIndex: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      select: {
        figureLabel: true,
        type: true,
        sourceMethod: true,
        imageSourceMethod: true,
        imagePath: true,
        gapReason: true,
      },
    }),
  ]);

  if (!paper) {
    throw new Error(`paper ${paperId} not found`);
  }

  const rolloutStatus = classifyFigureRolloutStatus({
    activeProvenanceKind: paper.publicationState?.activeIdentityResolution?.provenanceKind ?? null,
    extractionRunCount,
    bootstrapRunCount,
    primaryFigureCount: primaryFigures.length,
  });

  return {
    paperId: paper.id,
    title: paper.title,
    arxivId: paper.arxivId,
    rolloutStatus,
    primaryFigures,
    figuresWithImages: primaryFigures.filter((row) => !!row.imagePath).length,
    gapFigures: primaryFigures.filter((row) => !row.imagePath).length,
  };
}

function buildActualLabelMap(primaryFigures: ActualPrimaryFigure[]): Map<string, ActualPrimaryFigure[]> {
  const map = new Map<string, ActualPrimaryFigure[]>();
  for (const figure of primaryFigures) {
    const normalized = normalizeFixtureLabel(figure.figureLabel ?? "");
    if (!normalized) continue;
    const existing = map.get(normalized) ?? [];
    existing.push(figure);
    map.set(normalized, existing);
  }
  return map;
}

function evaluatePaper(entry: DatasetPaper, current: LoadedPaperState): PaperScore {
  const checks: CheckResult[] = [];
  const targets = entry.targets;
  const actualLabelMap = buildActualLabelMap(current.primaryFigures);
  const currentBySourceMethod = countBy(current.primaryFigures.map((row) => row.sourceMethod));

  if (targets.expectedRolloutStatus != null) {
    checks.push({
      kind: "rollout",
      passed: current.rolloutStatus === targets.expectedRolloutStatus,
      message: `rolloutStatus expected ${targets.expectedRolloutStatus}, got ${current.rolloutStatus}`,
    });
  }

  if (targets.expectedPrimaryFigures != null) {
    checks.push({
      kind: "count",
      passed: current.primaryFigures.length === targets.expectedPrimaryFigures,
      message: `primaryFigures expected ${targets.expectedPrimaryFigures}, got ${current.primaryFigures.length}`,
    });
  }

  if (targets.minimumPrimaryFigures != null) {
    checks.push({
      kind: "count",
      passed: current.primaryFigures.length >= targets.minimumPrimaryFigures,
      message: `primaryFigures expected >= ${targets.minimumPrimaryFigures}, got ${current.primaryFigures.length}`,
    });
  }

  if (targets.expectedFiguresWithImages != null) {
    checks.push({
      kind: "count",
      passed: current.figuresWithImages === targets.expectedFiguresWithImages,
      message: `figuresWithImages expected ${targets.expectedFiguresWithImages}, got ${current.figuresWithImages}`,
    });
  }

  if (targets.minimumFiguresWithImages != null) {
    checks.push({
      kind: "count",
      passed: current.figuresWithImages >= targets.minimumFiguresWithImages,
      message: `figuresWithImages expected >= ${targets.minimumFiguresWithImages}, got ${current.figuresWithImages}`,
    });
  }

  if (targets.maxGapFigures != null) {
    checks.push({
      kind: "count",
      passed: current.gapFigures <= targets.maxGapFigures,
      message: `gapFigures expected <= ${targets.maxGapFigures}, got ${current.gapFigures}`,
    });
  }

  const labelTargets = targets.labelTargets ?? {};
  const labelTargetsWithPresence = new Set(
    Object.entries(labelTargets)
      .filter(([, target]) => hasOwn(target, "expectPresent"))
      .map(([label]) => normalizeFixtureLabel(label))
      .filter((label): label is string => !!label),
  );

  for (const label of targets.requiredLabels ?? []) {
    const normalized = normalizeFixtureLabel(label);
    if (!normalized || labelTargetsWithPresence.has(normalized)) continue;
    const actualRows = actualLabelMap.get(normalized) ?? [];
    checks.push({
      kind: "label_presence",
      label,
      passed: actualRows.length > 0,
      message: `${label}: expected present`,
    });
  }

  for (const label of targets.forbiddenLabels ?? []) {
    const normalized = normalizeFixtureLabel(label);
    if (!normalized) continue;
    const actualRows = actualLabelMap.get(normalized) ?? [];
    checks.push({
      kind: "label_absence",
      label,
      passed: actualRows.length === 0,
      message: `${label}: expected absent`,
    });
  }

  for (const [label, target] of Object.entries(labelTargets)) {
    const normalized = normalizeFixtureLabel(label);
    if (!normalized) continue;

    const actualRows = actualLabelMap.get(normalized) ?? [];
    const actual = actualRows[0] ?? null;

    if (hasOwn(target, "expectPresent")) {
      const expectedPresent = target.expectPresent ?? false;
      checks.push({
        kind: "label_presence",
        label,
        passed: expectedPresent ? actualRows.length > 0 : actualRows.length === 0,
        message: `${label}: expected ${expectedPresent ? "present" : "absent"}`,
      });
    }

    if (actualRows.length > 1) {
      checks.push({
        kind: "label_detail",
        label,
        passed: false,
        message: `${label}: expected one primary row, found ${actualRows.length}`,
      });
    }

    if (hasOwn(target, "expectsImage")) {
      const expectsImage = target.expectsImage ?? false;
      const hasImage = !!actual?.imagePath;
      checks.push({
        kind: "label_detail",
        label,
        passed: !!actual && hasImage === expectsImage,
        message: `${label}: expected image=${expectsImage}, got ${actual ? hasImage : "missing label"}`,
      });
    }

    if (hasOwn(target, "expectedType")) {
      checks.push({
        kind: "label_detail",
        label,
        passed: !!actual && (actual.type ?? null) === (target.expectedType ?? null),
        message: `${label}: expected type=${target.expectedType ?? "null"}, got ${actual?.type ?? "missing label"}`,
      });
    }

    if (hasOwn(target, "expectedSourceMethod")) {
      checks.push({
        kind: "label_detail",
        label,
        passed: !!actual && actual.sourceMethod === (target.expectedSourceMethod ?? null),
        message: `${label}: expected sourceMethod=${target.expectedSourceMethod ?? "null"}, got ${actual?.sourceMethod ?? "missing label"}`,
      });
    }

    if (hasOwn(target, "expectedImageSourceMethod")) {
      checks.push({
        kind: "label_detail",
        label,
        passed: !!actual && (actual.imageSourceMethod ?? null) === (target.expectedImageSourceMethod ?? null),
        message: `${label}: expected imageSourceMethod=${target.expectedImageSourceMethod ?? "null"}, got ${actual?.imageSourceMethod ?? "missing label"}`,
      });
    }

    if (hasOwn(target, "expectedGapReason")) {
      checks.push({
        kind: "label_detail",
        label,
        passed: !!actual && (actual.gapReason ?? null) === (target.expectedGapReason ?? null),
        message: `${label}: expected gapReason=${target.expectedGapReason ?? "null"}, got ${actual?.gapReason ?? "missing label"}`,
      });
    }
  }

  return {
    datasetPaper: entry,
    resolvedPaperId: current.paperId,
    current,
    checks,
    currentBySourceMethod,
  };
}

function printHumanReport(scores: PaperScore[]): number {
  let totalChecks = 0;
  let passedChecks = 0;
  let papersWithTargets = 0;
  let labelPresenceChecks = 0;
  let labelPresencePassed = 0;
  let imageChecks = 0;
  let imageChecksPassed = 0;

  console.log(`Figure Review Dataset — ${scores.length} papers\n`);

  for (const score of scores) {
    const { datasetPaper, current, checks } = score;
    const checked = checks.length;
    const passed = checks.filter((check) => check.passed).length;
    const failedChecks = checks.filter((check) => !check.passed);
    const bySourceText = Object.entries(score.currentBySourceMethod)
      .map(([key, value]) => `${key}:${value}`)
      .join(", ");

    if (checked > 0) papersWithTargets += 1;
    totalChecks += checked;
    passedChecks += passed;

    for (const check of checks) {
      if (check.kind === "label_presence") {
        labelPresenceChecks += 1;
        if (check.passed) labelPresencePassed += 1;
      }
      if (check.kind === "label_detail" && check.message.includes("expected image=")) {
        imageChecks += 1;
        if (check.passed) imageChecksPassed += 1;
      }
    }

    const status = failedChecks.length === 0 ? "PASS" : "FAIL";
    const currentSummary = current
      ? `rollout=${current.rolloutStatus} primary=${current.primaryFigures.length} images=${current.figuresWithImages} gaps=${current.gapFigures}`
      : "unresolved";

    console.log(`${status}  ${datasetPaper.title} [${datasetPaper.bucket}] [${datasetPaper.targetsStatus}]`);
    console.log(`      Focus: ${datasetPaper.reviewFocus}`);
    console.log(`      Current: ${currentSummary}`);
    if (current) {
      console.log(`      Sources: ${bySourceText || "none"}`);
    }
    console.log(`      Checks: ${passed}/${checked}`);
    for (const failure of failedChecks) {
      console.log(`      - ${failure.message}`);
    }
    console.log("");
  }

  const percent = totalChecks > 0 ? Math.round((passedChecks / totalChecks) * 100) : 100;
  const labelPercent = labelPresenceChecks > 0 ? Math.round((labelPresencePassed / labelPresenceChecks) * 100) : 100;
  const imagePercent = imageChecks > 0 ? Math.round((imageChecksPassed / imageChecks) * 100) : 100;

  console.log("─".repeat(72));
  console.log(`Confirmed-target papers: ${papersWithTargets}/${scores.length}`);
  console.log(`Checks passed: ${passedChecks}/${totalChecks} (${percent}%)`);
  console.log(`Label presence: ${labelPresencePassed}/${labelPresenceChecks} (${labelPercent}%)`);
  console.log(`Image expectations: ${imageChecksPassed}/${imageChecks} (${imagePercent}%)`);

  return totalChecks === 0 ? 0 : (passedChecks === totalChecks ? 0 : 1);
}

async function main() {
  const args = process.argv.slice(2);
  const paperFilter = args.includes("--paper") ? args[args.indexOf("--paper") + 1] : null;
  const jsonMode = args.includes("--json");

  let papers = dataset.papers as unknown as DatasetPaper[];
  if (paperFilter) {
    papers = papers.filter((paper) =>
      paper.paperId === paperFilter
      || paper.arxivId === paperFilter
      || paper.title.toLowerCase().includes(paperFilter.toLowerCase()),
    );
    if (papers.length === 0) {
      console.error(`No review dataset paper matches: ${paperFilter}`);
      process.exit(1);
    }
  }

  const scores: PaperScore[] = [];

  for (const paper of papers) {
    const resolved = await resolvePaper(paper);
    if ("error" in resolved) {
      scores.push({
        datasetPaper: paper,
        resolvedPaperId: null,
        current: null,
        checks: [{
          kind: "rollout",
          passed: false,
          message: resolved.error,
        }],
        currentBySourceMethod: {},
      });
      continue;
    }

    const current = await loadPaperState(resolved.id);
    scores.push(evaluatePaper(paper, current));
  }

  if (jsonMode) {
    console.log(JSON.stringify(scores, null, 2));
    process.exit(0);
  }

  const exitCode = printHumanReport(scores);
  process.exit(exitCode);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
