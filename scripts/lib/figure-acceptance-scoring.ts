import {
  buildPreviewRequiredLabelSet,
  buildRequiredParentGroupRowMap,
  evaluatePreviewRequirement,
  normalizeFixtureLabel,
  normalizeFixtureMap,
  type RequiredParentGroupRow,
} from "./figure-quality-shared";

export interface FixtureLabelExpectation {
  expectsImage?: boolean;
  expectedGapReason?: string;
  expectedImageSourceMethod?: string;
}

export interface FixturePaper {
  arxivId?: string;
  doi?: string;
  fileBasename?: string;
  title: string;
  category: string;
  notes?: string;
  expectedFigures: string[];
  expectedTables: string[];
  expectedSources?: Record<string, string>;
  labelExpectations?: Record<string, FixtureLabelExpectation>;
  requiredParentGroupRows?: RequiredParentGroupRow[];
  firstPublishPreviewRequired?: boolean;
}

export interface AcceptanceFigureRow {
  figureLabel: string | null;
  sourceMethod: string;
  imageSourceMethod: string | null;
  imagePath: string | null;
  gapReason: string | null;
  confidence: string;
  description: string | null;
}

export interface PaperResult {
  title: string;
  category: string;
  paperId: string | null;
  resolved: boolean;
  figureRecall: { expected: number; found: number; missing: string[] };
  tableRecall: { expected: number; found: number; missing: string[] };
  unexpected: string[];
  sourceMismatches: string[];
  labelViolations: string[];
  highConfidence: number;
  lowConfidence: number;
  gaps: number;
  structured: number;
}

export function evaluateAcceptancePaper(params: {
  fixturePaper: FixturePaper;
  figures: AcceptanceFigureRow[];
  gapReasonExists: boolean;
  enforceFirstPublishPreviewRules: boolean;
}): PaperResult {
  const { fixturePaper: fp, figures, gapReasonExists, enforceFirstPublishPreviewRules } = params;

  const expectedFigNorm = new Set(fp.expectedFigures.map((label) => normalizeFixtureLabel(label)).filter(Boolean) as string[]);
  const expectedTabNorm = new Set(fp.expectedTables.map((label) => normalizeFixtureLabel(label)).filter(Boolean) as string[]);
  const requiredParentGroupRows = buildRequiredParentGroupRowMap(fp.requiredParentGroupRows);
  const allExpected = new Set([
    ...Array.from(expectedFigNorm),
    ...Array.from(expectedTabNorm),
    ...Array.from(requiredParentGroupRows.keys()),
  ]);

  const actualLabels = new Map<string, AcceptanceFigureRow>();
  for (const figure of figures) {
    const normalized = normalizeFixtureLabel(figure.figureLabel ?? "");
    if (normalized) {
      actualLabels.set(normalized, figure);
    }
  }

  const missingFigs: string[] = [];
  for (const normalized of Array.from(expectedFigNorm)) {
    if (!actualLabels.has(normalized)) missingFigs.push(normalized);
  }

  const missingTabs: string[] = [];
  for (const normalized of Array.from(expectedTabNorm)) {
    if (!actualLabels.has(normalized)) missingTabs.push(normalized);
  }

  const unexpected: string[] = [];
  for (const normalized of Array.from(actualLabels.keys())) {
    if (!allExpected.has(normalized) && !normalized.startsWith("uncaptioned-")) {
      unexpected.push(normalized);
    }
  }

  const sourceMismatches: string[] = [];
  if (fp.expectedSources) {
    const normalizedSources = normalizeFixtureMap(fp.expectedSources);
    for (const [normalized, expectedSource] of Array.from(normalizedSources.entries())) {
      const actual = actualLabels.get(normalized);
      if (actual && actual.sourceMethod !== expectedSource) {
        sourceMismatches.push(`${normalized}: expected ${expectedSource}, got ${actual.sourceMethod}`);
      }
    }
  }

  const labelViolations: string[] = [];

  for (const [normalized, requirement] of Array.from(requiredParentGroupRows.entries())) {
    if (!actualLabels.has(normalized)) {
      labelViolations.push(`${requirement.label}: required parent/group row missing`);
    }
  }

  const previewRequiredLabels = enforceFirstPublishPreviewRules
    ? buildPreviewRequiredLabelSet({
      requiredParentGroupRows: fp.requiredParentGroupRows,
      labelExpectations: fp.labelExpectations,
      firstPublishPreviewRequired: fp.firstPublishPreviewRequired,
      requiredLabels: [...fp.expectedFigures, ...fp.expectedTables],
    })
    : new Set<string>();

  if (fp.labelExpectations) {
    const normalizedExpectations = normalizeFixtureMap(fp.labelExpectations);
    for (const [normalized, expectation] of Array.from(normalizedExpectations.entries())) {
      const actual = actualLabels.get(normalized);
      if (!actual) continue;

      if (expectation.expectsImage !== undefined && !previewRequiredLabels.has(normalized)) {
        const hasImage = !!actual.imagePath;
        if (expectation.expectsImage && !hasImage) {
          labelViolations.push(`${normalized}: expected image but has none`);
        } else if (!expectation.expectsImage && hasImage) {
          labelViolations.push(
            `${normalized}: expected no image but has ${actual.imagePath?.split("/").pop()}`,
          );
        }
      }

      if (expectation.expectedImageSourceMethod) {
        if (actual.imageSourceMethod !== expectation.expectedImageSourceMethod) {
          labelViolations.push(
            `${normalized}: expected imageSourceMethod=${expectation.expectedImageSourceMethod}, got ${actual.imageSourceMethod || "null"}`,
          );
        }
      }

      if (expectation.expectedGapReason && gapReasonExists) {
        if (actual.gapReason !== expectation.expectedGapReason) {
          labelViolations.push(
            `${normalized}: expected gapReason=${expectation.expectedGapReason}, got ${actual.gapReason || "null"}`,
          );
        }
      }
    }
  }

  if (enforceFirstPublishPreviewRules) {
    for (const normalized of Array.from(previewRequiredLabels)) {
      const actual = actualLabels.get(normalized);
      if (!actual) continue;

      const evaluation = evaluatePreviewRequirement({
        imagePath: actual.imagePath ?? null,
        gapReason: gapReasonExists ? (actual.gapReason ?? null) : null,
      }, true);

      if (!evaluation.passed) {
        labelViolations.push(`${normalized}: ${evaluation.message}`);
      }
    }

    for (const normalized of Array.from(allExpected)) {
      if (previewRequiredLabels.has(normalized)) continue;
      const actual = actualLabels.get(normalized);
      if (!actual) continue;

      const evaluation = evaluatePreviewRequirement({
        imagePath: actual.imagePath ?? null,
        gapReason: gapReasonExists ? (actual.gapReason ?? null) : null,
      }, false);

      if (!evaluation.passed) {
        labelViolations.push(`${normalized}: ${evaluation.message}`);
      }
    }
  }

  return {
    title: fp.title,
    category: fp.category,
    paperId: null,
    resolved: true,
    figureRecall: {
      expected: expectedFigNorm.size,
      found: expectedFigNorm.size - missingFigs.length,
      missing: missingFigs,
    },
    tableRecall: {
      expected: expectedTabNorm.size,
      found: expectedTabNorm.size - missingTabs.length,
      missing: missingTabs,
    },
    unexpected,
    sourceMismatches,
    labelViolations,
    highConfidence: figures.filter((figure) => figure.confidence === "high").length,
    lowConfidence: figures.filter((figure) => figure.confidence === "low").length,
    gaps: figures.filter((figure) => !figure.imagePath).length,
    structured: figures.filter((figure) => figure.description && figure.description.length > 100).length,
  };
}
