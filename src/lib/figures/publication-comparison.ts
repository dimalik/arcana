import { normalizeLabel } from "./label-utils";

export type ComparisonStatus = "not_compared" | "safe_to_replace" | "regression_blocked";
export type PublicationMode = "normal" | "forced";

interface SemanticComparableFigure {
  figureLabel: string | null;
  type?: string | null;
}

interface PreviewComparableFigure {
  identityKey: string;
  selectedPreviewSource: string;
}

export interface ComparisonDecision {
  comparisonStatus: ComparisonStatus;
  comparisonSummary: string;
}

function canonicalizeSemanticLabel(figure: SemanticComparableFigure): string | null {
  const normalized = normalizeLabel(figure.figureLabel);
  if (!normalized) return null;
  if (/^\d+[a-z]?$/i.test(normalized)) {
    if (figure.type === "table") return `table_${normalized}`;
    if (figure.type === "figure") return `figure_${normalized}`;
  }
  return normalized;
}

function previewSourceRank(source: string): number {
  if (source === "rendered") return 2;
  if (source === "native") return 1;
  return 0;
}

export function compareProjectionRuns(
  previousFigures: SemanticComparableFigure[],
  currentFigures: SemanticComparableFigure[],
): ComparisonDecision {
  if (previousFigures.length === 0) {
    return {
      comparisonStatus: "safe_to_replace",
      comparisonSummary: JSON.stringify({
        kind: "semantic_publication",
        changeClasses: ["initial_publication"],
        previousFigureCount: 0,
        currentFigureCount: currentFigures.length,
      }),
    };
  }

  const previousLabels = new Set(
    previousFigures
      .map((figure) => canonicalizeSemanticLabel(figure))
      .filter((label): label is string => !!label),
  );
  const currentLabels = new Set(
    currentFigures
      .map((figure) => canonicalizeSemanticLabel(figure))
      .filter((label): label is string => !!label),
  );

  const missingLabels = Array.from(previousLabels).filter((label) => !currentLabels.has(label));
  const addedLabels = Array.from(currentLabels).filter((label) => !previousLabels.has(label));
  const changeClasses: string[] = [];

  if (currentFigures.length > previousFigures.length) {
    changeClasses.push("additive_gain");
  } else if (currentFigures.length < previousFigures.length) {
    if (missingLabels.length === 0 && previousLabels.size > 0) {
      changeClasses.push("duplicate_collapse");
    } else {
      changeClasses.push("risky_loss");
    }
  }

  if (addedLabels.length > 0 && !changeClasses.includes("additive_gain")) {
    changeClasses.push("additive_gain");
  }

  const comparisonStatus: ComparisonStatus = changeClasses.includes("risky_loss")
    ? "regression_blocked"
    : "safe_to_replace";

  return {
    comparisonStatus,
    comparisonSummary: JSON.stringify({
      kind: "semantic_publication",
      changeClasses: changeClasses.length > 0 ? changeClasses : ["equivalent"],
      previousFigureCount: previousFigures.length,
      currentFigureCount: currentFigures.length,
      missingLabels,
      addedLabels,
    }),
  };
}

export function comparePreviewSelections(
  previousSelections: PreviewComparableFigure[],
  currentSelections: PreviewComparableFigure[],
): ComparisonDecision {
  if (previousSelections.length === 0) {
    return {
      comparisonStatus: "safe_to_replace",
      comparisonSummary: JSON.stringify({
        kind: "preview_publication",
        changeClasses: ["initial_publication"],
        previousSelectedCount: 0,
        currentSelectedCount: currentSelections.filter((selection) => selection.selectedPreviewSource !== "none").length,
      }),
    };
  }

  const previousByIdentityKey = new Map(
    previousSelections.map((selection) => [selection.identityKey, selection]),
  );
  const changeClasses = new Set<string>();
  const degradedIdentityKeys: string[] = [];
  const improvedIdentityKeys: string[] = [];

  for (const currentSelection of currentSelections) {
    const previousSelection = previousByIdentityKey.get(currentSelection.identityKey);
    if (!previousSelection) continue;

    const previousRank = previewSourceRank(previousSelection.selectedPreviewSource);
    const currentRank = previewSourceRank(currentSelection.selectedPreviewSource);

    if (currentRank < previousRank) {
      degradedIdentityKeys.push(currentSelection.identityKey);
      changeClasses.add("risky_preview_loss");
      continue;
    }
    if (currentRank > previousRank) {
      improvedIdentityKeys.push(currentSelection.identityKey);
      changeClasses.add("render_improvement");
      continue;
    }
    changeClasses.add("equivalent_carry_forward");
  }

  const comparisonStatus: ComparisonStatus = degradedIdentityKeys.length > 0
    ? "regression_blocked"
    : "safe_to_replace";

  return {
    comparisonStatus,
    comparisonSummary: JSON.stringify({
      kind: "preview_publication",
      changeClasses: Array.from(changeClasses.size > 0 ? changeClasses : new Set(["equivalent"])),
      previousSelectedCount: previousSelections.filter((selection) => selection.selectedPreviewSource !== "none").length,
      currentSelectedCount: currentSelections.filter((selection) => selection.selectedPreviewSource !== "none").length,
      degradedIdentityKeys,
      improvedIdentityKeys,
    }),
  };
}

export const publicationComparisonInternals = {
  previewSourceRank,
  canonicalizeSemanticLabel,
};
