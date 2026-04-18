import { normalizeLabel } from "../../src/lib/figures/label-utils";

export interface RequiredParentGroupRow {
  label: string;
  mustHavePreview: boolean;
}

export interface PreviewLabelExpectation {
  expectsImage?: boolean | null;
}

export interface PreviewComparableRow {
  imagePath: string | null;
  gapReason: string | null;
}

export function normalizeFixtureLabel(label: string): string | null {
  return normalizeLabel(label);
}

export function normalizeFixtureMap<T>(map?: Record<string, T> | null): Map<string, T> {
  const result = new Map<string, T>();
  if (!map) return result;

  for (const [key, value] of Object.entries(map)) {
    const normalized = normalizeFixtureLabel(key);
    if (normalized) {
      result.set(normalized, value);
    }
  }

  return result;
}

export function buildRequiredParentGroupRowMap(
  rows?: RequiredParentGroupRow[] | null,
): Map<string, RequiredParentGroupRow> {
  const result = new Map<string, RequiredParentGroupRow>();
  for (const row of rows ?? []) {
    const normalized = normalizeFixtureLabel(row.label);
    if (normalized) {
      result.set(normalized, row);
    }
  }
  return result;
}

export function buildPreviewRequiredLabelSet(params: {
  requiredParentGroupRows?: RequiredParentGroupRow[] | null;
  labelExpectations?: Record<string, PreviewLabelExpectation> | null;
  firstPublishPreviewRequired?: boolean | null;
  requiredLabels?: string[] | null;
}): Set<string> {
  const required = new Set<string>();

  for (const row of params.requiredParentGroupRows ?? []) {
    if (!row.mustHavePreview) continue;
    const normalized = normalizeFixtureLabel(row.label);
    if (normalized) {
      required.add(normalized);
    }
  }

  for (const [label, expectation] of Object.entries(params.labelExpectations ?? {})) {
    if (!expectation?.expectsImage) continue;
    const normalized = normalizeFixtureLabel(label);
    if (normalized) {
      required.add(normalized);
    }
  }

  if (params.firstPublishPreviewRequired) {
    for (const label of params.requiredLabels ?? []) {
      const normalized = normalizeFixtureLabel(label);
      if (normalized) {
        required.add(normalized);
      }
    }
  }

  return required;
}

export function evaluatePreviewRequirement(
  actual: PreviewComparableRow | null,
  previewRequired: boolean,
): { passed: boolean; message: string } {
  if (!actual) {
    return {
      passed: false,
      message: previewRequired
        ? "expected preview-required row, but label is missing"
        : "expected preview-optional row, but label is missing",
    };
  }

  if (previewRequired) {
    if (!actual.imagePath) {
      return {
        passed: false,
        message: actual.gapReason
          ? `expected preview-required row to have a real preview, got gapReason=${actual.gapReason}`
          : "expected preview-required row to have a real preview, got imagePath=null",
      };
    }

    if (actual.gapReason != null) {
      return {
        passed: false,
        message: `expected preview-required row to have gapReason=null, got ${actual.gapReason}`,
      };
    }

    return {
      passed: true,
      message: "preview-required row has a real preview",
    };
  }

  if (actual.imagePath || actual.gapReason) {
    return {
      passed: true,
      message: actual.imagePath
        ? "preview-optional row has a preview"
        : `preview-optional row has explicit gapReason=${actual.gapReason}`,
    };
  }

  return {
    passed: false,
    message: "expected preview-optional row to have imagePath or explicit gapReason",
  };
}
