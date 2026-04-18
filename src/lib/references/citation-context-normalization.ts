export interface CitationContextSource {
  citationText: string | null | undefined;
  excerpt: string | null | undefined;
}

const NUMERIC_CITATION_MARKER_RE = /^\[\d+(?:\s*[-,]\s*\d+)*\]$/;
const AUTHOR_KEY_CITATION_MARKER_RE = /^\[[A-Z][A-Za-z0-9]*(?:\s*\+\s*\d{2,4}|\d{2,4})(?:\s*,\s*[A-Z][A-Za-z0-9]*(?:\s*\+\s*\d{2,4}|\d{2,4}))*\]$/;
const AUTHOR_YEAR_PAREN_CITATION_MARKER_RE = /^\([A-Z][^()]{0,120}?\bet al\.,\s*\d{4}[a-z]?\)$/;

export function normalizeCitationContext(
  excerpt: string | null | undefined,
  citationText: string | null | undefined,
): string {
  let value = (excerpt ?? "")
    .replace(/([a-z]{2,})-\s*\n\s*([a-z]{2,})/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();

  if (!value) return "";

  const marker = normalizeCitationMarker(citationText);
  if (marker) {
    const markerPattern = escapeRegex(marker).replace(/\s+/g, "\\s+");
    value = value.replace(new RegExp(markerPattern, "g"), " ");
  }

  return value
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/([(])\s+/g, "$1")
    .replace(/\s+([)])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function buildNormalizedCitationContext(
  sources: CitationContextSource[],
): string | null {
  const seen = new Set<string>();
  const normalized: string[] = [];

  for (const source of sources) {
    const excerpt = normalizeCitationContext(source.excerpt, source.citationText);
    if (!excerpt || seen.has(excerpt)) continue;
    seen.add(excerpt);
    normalized.push(excerpt);
  }

  return normalized.length > 0 ? normalized.join("; ") : null;
}

function normalizeCitationMarker(citationText: string | null | undefined): string | null {
  const marker = (citationText ?? "").trim().replace(/\s+/g, " ");
  if (!marker) return null;
  if (NUMERIC_CITATION_MARKER_RE.test(marker)) return marker;
  if (AUTHOR_KEY_CITATION_MARKER_RE.test(marker)) return marker;
  if (AUTHOR_YEAR_PAREN_CITATION_MARKER_RE.test(marker)) return marker;
  return null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
