/**
 * Heuristic extraction of the references/bibliography section from paper full text.
 */

const REFERENCES_HEADING =
  /(?:^|\n)[ \t]*(?:\d+\.?\s+|[IVXLC]+\.?\s+)?(?:references|bibliography)\s*\n/im;

/**
 * Scan for "References" or "Bibliography" headings and return text
 * from that heading to end-of-document (or to "Appendix" if present).
 */
export function extractReferenceSection(fullText: string): string | null {
  const match = REFERENCES_HEADING.exec(fullText);
  if (!match) return null;

  let refText = fullText.slice(match.index);

  // Trim at Appendix heading if present
  const appendixPattern =
    /\n[ \t]*(?:\d+\.?\s+|[IVXLC]+\.?\s+)?(?:appendix|appendices)\s*\n/im;
  const appendixMatch = appendixPattern.exec(refText);
  if (appendixMatch && appendixMatch.index > 100) {
    refText = refText.slice(0, appendixMatch.index);
  }

  return refText.trim();
}

/**
 * Get body text excluding the bibliography section, for citation context extraction.
 * Takes from the beginning of the body (intro/related work contain most citations).
 * If the body exceeds maxChars, takes the first portion.
 */
export function getBodyTextForContextExtraction(
  fullText: string,
  maxChars = 30000
): string | null {
  const match = REFERENCES_HEADING.exec(fullText);
  // Take everything before the references heading
  const bodyText = match ? fullText.slice(0, match.index) : fullText;

  const trimmed = bodyText.trim();
  if (trimmed.length < 100) return null;

  if (trimmed.length <= maxChars) return trimmed;
  return trimmed.slice(0, maxChars);
}

/**
 * Get text suitable for reference extraction by LLM.
 * Prefers the extracted reference section; falls back to the last N chars.
 */
export function getTextForReferenceExtraction(
  fullText: string,
  maxChars = 6000
): string {
  const section = extractReferenceSection(fullText);
  if (section && section.length > 50) {
    return section.slice(0, maxChars);
  }

  // Fallback: take the last portion of the text (references are at the end)
  if (fullText.length <= maxChars) return fullText;
  return fullText.slice(-maxChars);
}
