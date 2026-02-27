/**
 * Parse a paper summary into its constituent sections (Overview, Methodology, Results).
 * Shared between the paper detail page and the compare-methodologies API.
 */
export function parseSummarySections(summary: string): {
  overview: string;
  methodology: string;
  results: string;
} {
  // Split by ## headers — these are the reliable section boundaries.
  // Claude uses --- liberally as horizontal rules, so we can't split on those.
  const methMatch = summary.match(/\n(?=## Methodology\b)/);
  const resMatch = summary.match(/\n(?=## Results\b)/);

  if (methMatch && resMatch && methMatch.index! < resMatch.index!) {
    return {
      overview: cleanSection(summary.slice(0, methMatch.index!)),
      methodology: cleanSection(summary.slice(methMatch.index!, resMatch.index!)),
      results: cleanSection(summary.slice(resMatch.index!)),
    };
  }

  // Only one section found — split what we can
  if (methMatch) {
    return {
      overview: cleanSection(summary.slice(0, methMatch.index!)),
      methodology: cleanSection(summary.slice(methMatch.index!)),
      results: "",
    };
  }

  if (resMatch) {
    return {
      overview: cleanSection(summary.slice(0, resMatch.index!)),
      methodology: "",
      results: cleanSection(summary.slice(resMatch.index!)),
    };
  }

  return { overview: summary, methodology: "", results: "" };
}

/**
 * Clean a section by trimming whitespace and removing trailing/leading
 * `---` horizontal rules that the prompt template places between sections.
 * These stray rules can confuse markdown renderers when they appear next
 * to tables (whose header rows also use `---`).
 */
function cleanSection(text: string): string {
  return text
    .trim()
    .replace(/^---\s*/m, "")   // leading rule
    .replace(/\n---\s*$/, "")  // trailing rule
    .trim();
}
