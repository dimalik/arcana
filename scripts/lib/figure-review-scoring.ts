import type { FigureRolloutStatus } from "../../src/lib/figures/figure-audit";

import {
  buildRequiredParentGroupRowMap,
  normalizeFixtureLabel,
  type RequiredParentGroupRow,
} from "./figure-quality-shared";

export interface LabelTarget {
  expectPresent?: boolean | null;
  expectsImage?: boolean | null;
  expectedType?: string | null;
  expectedSourceMethod?: string | null;
  expectedImageSourceMethod?: string | null;
  expectedGapReason?: string | null;
  notes?: string;
}

export interface PaperTargets {
  expectedRolloutStatus?: FigureRolloutStatus | null;
  expectedPrimaryFigures?: number | null;
  expectedFiguresWithImages?: number | null;
  minimumPrimaryFigures?: number | null;
  minimumFiguresWithImages?: number | null;
  maxGapFigures?: number | null;
  requiredLabels?: string[];
  forbiddenLabels?: string[];
  requiredParentGroupRows?: RequiredParentGroupRow[];
  firstPublishPreviewRequired?: boolean | null;
  labelTargets?: Record<string, LabelTarget>;
}

export interface DatasetPaper {
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

export interface ActualPrimaryFigure {
  figureLabel: string | null;
  type: string;
  sourceMethod: string;
  imageSourceMethod: string | null;
  imagePath: string | null;
  gapReason: string | null;
}

export interface LoadedPaperState {
  paperId: string;
  title: string;
  arxivId: string | null;
  rolloutStatus: FigureRolloutStatus;
  primaryFigures: ActualPrimaryFigure[];
  figuresWithImages: number;
  gapFigures: number;
}

export interface CheckResult {
  kind: "rollout" | "count" | "label_presence" | "label_absence" | "label_detail";
  label?: string;
  passed: boolean;
  message: string;
}

export interface PaperScore {
  datasetPaper: DatasetPaper;
  resolvedPaperId: string | null;
  current: LoadedPaperState | null;
  checks: CheckResult[];
  currentBySourceMethod: Record<string, number>;
}

function hasOwn<T extends object>(value: T, key: keyof any): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function countBy(
  values: Array<string | null | undefined>,
  fallback = "unknown",
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const value of values) {
    const key = value && value.length > 0 ? value : fallback;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function buildActualLabelMap(
  primaryFigures: ActualPrimaryFigure[],
): Map<string, ActualPrimaryFigure[]> {
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

export function evaluateReviewPaper(
  entry: DatasetPaper,
  current: LoadedPaperState,
): PaperScore {
  const checks: CheckResult[] = [];
  const targets = entry.targets;
  const actualLabelMap = buildActualLabelMap(current.primaryFigures);
  const currentBySourceMethod = countBy(current.primaryFigures.map((row) => row.sourceMethod));
  const requiredParentGroupRows = buildRequiredParentGroupRowMap(targets.requiredParentGroupRows);

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

  for (const [normalized, requirement] of Array.from(requiredParentGroupRows.entries())) {
    const actualRows = actualLabelMap.get(normalized) ?? [];
    checks.push({
      kind: "label_presence",
      label: requirement.label,
      passed: actualRows.length > 0,
      message: `${requirement.label}: expected parent/group row present`,
    });

    if (actualRows.length > 1) {
      checks.push({
        kind: "label_detail",
        label: requirement.label,
        passed: false,
        message: `${requirement.label}: expected one parent/group row, found ${actualRows.length}`,
      });
    }

    if (requirement.mustHavePreview) {
      const actual = actualRows[0] ?? null;
      checks.push({
        kind: "label_detail",
        label: requirement.label,
        passed: !!actual && !!actual.imagePath && (actual.gapReason ?? null) === null,
        message: `${requirement.label}: expected parent/group row preview present with gapReason=null`,
      });
    }
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
    if (!normalized || labelTargetsWithPresence.has(normalized) || requiredParentGroupRows.has(normalized)) {
      continue;
    }

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
