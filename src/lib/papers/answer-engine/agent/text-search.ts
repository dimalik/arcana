import "server-only";

import { normalizeAnalysisText } from "@/lib/papers/analysis/normalization/text";

const STOP_WORDS = new Set([
  "a", "about", "am", "an", "are", "after", "be", "been", "being", "before",
  "can", "could", "does", "from", "give", "have", "how", "i", "is", "into",
  "just", "like", "me", "more", "most", "paper", "papers", "please", "show",
  "that", "the", "their", "them", "this", "to", "us", "was", "were", "what",
  "when", "where", "which", "with", "would", "you",
]);

export function tokenizeQuery(value: string): string[] {
  return normalizeAnalysisText(value)
    .split(" ")
    .map((token) => token.trim())
    .filter((token) => token.length > 2 && !STOP_WORDS.has(token));
}

export interface QuerySpanMatch {
  text: string;
  score: number;
}

/**
 * Find short spans in `text` that match any token from `query`. Zero-dependency
 * version — no `QueryAnalysis`. Returns ranked, deduplicated spans.
 */
export function findQueryMatches(
  text: string | null | undefined,
  query: string,
  limit = 3,
): QuerySpanMatch[] {
  if (!text) return [];
  const tokens = tokenizeQuery(query);
  if (tokens.length === 0) return [];

  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  const lower = cleaned.toLowerCase();

  const seen = new Map<string, QuerySpanMatch>();
  for (const token of tokens) {
    const needle = token.toLowerCase();
    let cursor = 0;
    while (cursor < lower.length) {
      const idx = lower.indexOf(needle, cursor);
      if (idx < 0) break;
      const left = Math.max(0, idx - 20);
      const right = Math.min(cleaned.length, idx + needle.length + 420);
      const snippet = cleaned.slice(left, right).trim();
      const score = tokens.reduce(
        (sum, t) => (snippet.toLowerCase().includes(t.toLowerCase()) ? sum + 1 : sum),
        0,
      );
      const existing = seen.get(snippet);
      if (!existing || existing.score < score) {
        seen.set(snippet, { text: snippet, score });
      }
      cursor = idx + needle.length;
    }
  }

  return Array.from(seen.values())
    .sort((a, b) => b.score - a.score || b.text.length - a.text.length)
    .slice(0, limit);
}
