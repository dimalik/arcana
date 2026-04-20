export interface SectionNormalizationRule {
  slug: string;
  patterns: readonly RegExp[];
}

const SECTION_NORMALIZATION_RULES: readonly SectionNormalizationRule[] = [
  { slug: "introduction", patterns: [/^1?\s*introduction$/i, /^background$/i] },
  { slug: "related_work", patterns: [/related work/i, /prior work/i, /literature review/i] },
  {
    slug: "method",
    patterns: [/method/i, /approach/i, /model/i, /experimental setup/i, /implementation details/i],
  },
  { slug: "results", patterns: [/results?/i, /experiments?/i, /analysis/i] },
  { slug: "discussion", patterns: [/discussion/i] },
  { slug: "limitations", patterns: [/limitation/i] },
  { slug: "conclusion", patterns: [/conclusion/i] },
  { slug: "future_work", patterns: [/future work/i] },
];

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}

function extractSectionNumber(label: string): string | null {
  const match = label.trim().match(/^(\d+(?:\.\d+)*)\b/);
  return match ? match[1] : null;
}

function extractAppendixLetter(label: string): string | null {
  const match = label.trim().match(/^appendix\s+([a-z])\b/i);
  return match ? match[1].toUpperCase() : null;
}

export function normalizeSectionLabel(
  label: string | null | undefined,
): string {
  const raw = (label ?? "").trim();
  if (!raw) return "unknown";

  const appendixLetter = extractAppendixLetter(raw);
  if (appendixLetter) return `appendix/${appendixLetter}`;

  const sectionNumber = extractSectionNumber(raw);
  for (const rule of SECTION_NORMALIZATION_RULES) {
    if (rule.patterns.some((pattern) => pattern.test(raw))) {
      return sectionNumber ? `${rule.slug}/${sectionNumber}` : rule.slug;
    }
  }

  const slug = slugify(raw);
  if (!slug) return "unknown";
  return sectionNumber ? `${slug}/${sectionNumber}` : slug;
}

export { SECTION_NORMALIZATION_RULES };
