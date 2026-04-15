/**
 * Shared label normalization for figure/table matching.
 *
 * Used by the source merger (dedup) and the acceptance runner (recall comparison).
 */

/**
 * Normalize a figure label for matching.
 * "Figure 1" = "Fig. 1" = "Fig 1" → "figure_1"
 */
export function normalizeLabel(label: string | null): string | null {
  if (!label) return null;
  return label
    .toLowerCase()
    .replace(/^fig\.?\s*/i, "figure ")
    .replace(/\s+/g, "_")
    .trim();
}
