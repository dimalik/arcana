/**
 * Match in-text citation strings (e.g. "Henderson et al., 2023") to Reference records.
 */

interface ReferenceRecord {
  id: string;
  title: string;
  authors: string | null; // JSON array
  year: number | null;
  referenceIndex: number | null;
}

/**
 * Parse author surname(s) and year from a citation string.
 * Handles formats like:
 *   "Henderson et al., 2023"
 *   "Smith and Jones, 2020"
 *   "Smith & Jones (2020)"
 *   "Liu et al., 2024a"
 *   "[12]" (numbered)
 */
function parseCitation(citation: string): {
  surnames: string[];
  year: number;
  index: number | null;
} | null {
  // Handle numbered citations like "[12]", "[3]"
  const numberedMatch = citation.match(/^\[(\d+)\]$/);
  if (numberedMatch) {
    return { surnames: [], year: 0, index: parseInt(numberedMatch[1], 10) };
  }

  // Extract year — allow optional letter suffix (2024a, 2024b)
  const yearMatch = citation.match(/((?:19|20)\d{2})[a-z]?\b/);
  if (!yearMatch) return null;
  const year = parseInt(yearMatch[1], 10);

  // Remove year (with optional suffix) and surrounding punctuation
  let authorPart = citation
    .replace(/\(?\s*(?:19|20)\d{2}[a-z]?\s*\)?/g, "")
    .replace(/[()[\]]/g, "")
    .trim();

  // Remove "et al." and split on "and", "&", ","
  authorPart = authorPart.replace(/\bet\s+al\.?/gi, "").trim();
  const parts = authorPart
    .split(/\s*(?:and|&|,|;)\s*/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);

  // Filter out non-author tokens: all-caps abbreviations (DPO, RLHF), single letters, etc.
  const authorParts = parts.filter((p) => {
    if (/^[A-Z]{2,}$/.test(p)) return false; // all-caps abbreviation
    if (/^\d+$/.test(p)) return false; // pure numbers
    return true;
  });

  // Extract the last word of each part as surname
  const surnames = authorParts.map((p) => {
    const words = p.split(/\s+/);
    return words[words.length - 1].toLowerCase();
  });

  if (surnames.length === 0) return null;

  return { surnames, year, index: null };
}

/**
 * Extract author surnames from a Reference's JSON authors field.
 */
function getReferenceSurnames(authorsJson: string | null): string[] {
  if (!authorsJson) return [];
  try {
    const authors = JSON.parse(authorsJson) as string[];
    return authors.map((a) => {
      const words = a.trim().split(/\s+/);
      return words[words.length - 1].toLowerCase();
    });
  } catch {
    return [];
  }
}

/**
 * Normalize a string for fuzzy comparison: lowercase, strip punctuation, collapse whitespace.
 */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Match a citation string to the best Reference record.
 * Strategies (in priority order):
 * 1. Numbered citation [N] → match by referenceIndex
 * 2. Author surname + year exact match
 * 3. Author surname + year ±1 (handles pre-prints vs published dates)
 * 4. Title substring match as last resort (for citations with full/partial titles)
 *
 * Returns the matched reference ID or null.
 */
export function matchCitationToReference(
  citation: string,
  references: ReferenceRecord[]
): string | null {
  const parsed = parseCitation(citation);
  if (!parsed) return null;

  // Strategy 1: Numbered citation
  if (parsed.index !== null) {
    const byIndex = references.find((r) => r.referenceIndex === parsed.index);
    if (byIndex) return byIndex.id;
    return null;
  }

  // Strategy 2: Exact year + surname match
  for (const ref of references) {
    if (ref.year !== parsed.year) continue;

    const refSurnames = getReferenceSurnames(ref.authors);
    if (refSurnames.length === 0) continue;

    const hasMatch = parsed.surnames.some((s) =>
      refSurnames.some((rs) => rs === s)
    );
    if (hasMatch) return ref.id;
  }

  // Strategy 3: Year ±1 (pre-print → published year drift)
  for (const ref of references) {
    if (ref.year == null) continue;
    if (Math.abs(ref.year - parsed.year) !== 1) continue;

    const refSurnames = getReferenceSurnames(ref.authors);
    if (refSurnames.length === 0) continue;

    const hasMatch = parsed.surnames.some((s) =>
      refSurnames.some((rs) => rs === s)
    );
    if (hasMatch) return ref.id;
  }

  // Strategy 4: Check if citation text contains a recognizable title fragment
  const normalizedCitation = normalize(citation);
  if (normalizedCitation.length > 15) {
    for (const ref of references) {
      const normalizedTitle = normalize(ref.title);
      if (
        normalizedTitle.includes(normalizedCitation) ||
        normalizedCitation.includes(normalizedTitle)
      ) {
        return ref.id;
      }
    }
  }

  return null;
}
