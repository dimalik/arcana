/**
 * Search utilities for Mind Palace and library search.
 *
 * Provides stemming, normalization, and LLM-powered query expansion
 * to improve recall without sacrificing precision.
 */

import { generateText } from "ai";
import { getModel } from "@/lib/llm/provider";
import { getDefaultModel } from "@/lib/llm/auto-process";

// ── Lightweight suffix stemmer ──────────────────────────────────
// Not a full Porter stemmer — just handles the most common suffixes
// that cause misses in academic text. Deliberately conservative to
// avoid collapsing distinct concepts (e.g., "general" ≠ "generate").

const SUFFIX_RULES: [RegExp, string][] = [
  // Plurals
  [/ies$/i, "y"],
  [/sses$/i, "ss"],
  [/([^s])s$/i, "$1"],
  // -ing
  [/ating$/i, "ate"],
  [/izing$/i, "ize"],
  [/ising$/i, "ise"],
  [/([a-z]{3,})ing$/i, "$1"],
  // -tion/-sion variants
  [/isation$/i, "ize"],
  [/ization$/i, "ize"],
  // -ed
  [/ated$/i, "ate"],
  [/ized$/i, "ize"],
  [/ised$/i, "ise"],
  [/([a-z]{3,})ed$/i, "$1"],
  // -ly
  [/ously$/i, "ous"],
  [/ively$/i, "ive"],
  [/ally$/i, "al"],
  // British/American spelling
  [/isation$/i, "ization"],
  [/ise$/i, "ize"],
  [/colour/i, "color"],
  [/behaviour/i, "behavior"],
  [/analyse/i, "analyze"],
  [/optimise/i, "optimize"],
  [/generalise/i, "generalize"],
  [/normalise/i, "normalize"],
];

// Common abbreviation expansions for ML/research
const ABBREVIATIONS: Record<string, string[]> = {
  cnn: ["convolutional", "neural", "network"],
  rnn: ["recurrent", "neural", "network"],
  lstm: ["long", "short", "term", "memory"],
  gpt: ["generative", "pretrained", "transformer"],
  bert: ["bidirectional", "encoder", "representations", "transformers"],
  llm: ["large", "language", "model"],
  rl: ["reinforcement", "learning"],
  rlhf: ["reinforcement", "learning", "human", "feedback"],
  gan: ["generative", "adversarial", "network"],
  vae: ["variational", "autoencoder"],
  mlp: ["multilayer", "perceptron"],
  nlp: ["natural", "language", "processing"],
  cv: ["computer", "vision"],
  sgd: ["stochastic", "gradient", "descent"],
  adam: ["adaptive", "moment", "estimation"],
  ppo: ["proximal", "policy", "optimization"],
  dpo: ["direct", "preference", "optimization"],
  sft: ["supervised", "finetuning"],
  lora: ["low", "rank", "adaptation"],
  rag: ["retrieval", "augmented", "generation"],
  moe: ["mixture", "experts"],
  kl: ["kullback", "leibler"],
  mae: ["mean", "absolute", "error"],
  mse: ["mean", "squared", "error"],
  auc: ["area", "under", "curve"],
  roc: ["receiver", "operating", "characteristic"],
  gpu: ["graphics", "processing", "unit"],
  tpu: ["tensor", "processing", "unit"],
};

/**
 * Stem a single word — returns the normalized form.
 */
export function stem(word: string): string {
  let w = word.toLowerCase();
  for (const [pattern, replacement] of SUFFIX_RULES) {
    const stemmed = w.replace(pattern, replacement);
    // Only accept if the stem is at least 3 chars (avoid over-stemming)
    if (stemmed !== w && stemmed.length >= 3) {
      w = stemmed;
      break; // Apply at most one rule
    }
  }
  return w;
}

/**
 * Tokenize and stem a query string.
 * Returns both original terms and stemmed variants (deduped).
 */
export function stemTerms(query: string): string[] {
  const raw = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  const all = new Set<string>();

  for (const term of raw) {
    all.add(term);
    const stemmed = stem(term);
    if (stemmed !== term) all.add(stemmed);

    // Expand known abbreviations
    const abbr = ABBREVIATIONS[term];
    if (abbr) {
      for (const expanded of abbr) {
        if (expanded.length > 2) all.add(expanded);
      }
    }
  }

  return Array.from(all);
}

/**
 * Score how well a text matches a set of query terms.
 * Uses stemmed matching — both the terms and the text are stemmed.
 */
export function scoreText(text: string, queryTerms: string[]): number {
  const lower = text.toLowerCase();
  let score = 0;
  for (const term of queryTerms) {
    // Count occurrences — escape regex special chars in term
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = lower.match(new RegExp(escaped, "g"));
    if (matches) score += matches.length;
  }
  return score;
}

/**
 * Score with weighted text sections (e.g., title=3x, abstract=2x).
 */
export function scoreWeighted(
  sections: { text: string; weight: number }[],
  queryTerms: string[],
): number {
  let score = 0;
  for (const { text, weight } of sections) {
    score += scoreText(text, queryTerms) * weight;
  }
  return score;
}

// ── Relevance filtering for paper imports ─────────────────────

/**
 * Filter search results by relevance to the query BEFORE importing.
 * Uses stemmed term matching on title (3x weight) + abstract (2x weight).
 * Returns only papers scoring above the threshold, preserving original order.
 */
export function filterByRelevance<T extends { title: string; abstract?: string | null }>(
  results: T[],
  query: string,
  minScore = 2,
): T[] {
  const terms = stemTerms(query);
  return results.filter((r) => {
    const score = scoreWeighted(
      [
        { text: r.title, weight: 3 },
        { text: r.abstract || "", weight: 2 },
      ],
      terms,
    );
    return score >= minScore;
  });
}

// ── LLM query expansion ────────────────────────────────────────

// Cache to avoid re-expanding the same query within a session
const expansionCache = new Map<string, string[]>();

/**
 * Use the LLM to expand a search query with synonyms and related terms.
 * Returns additional terms to search for (does NOT include original terms).
 *
 * Cheap: uses a single short generateText call with no tools.
 * Cached: same query in the same process won't re-call the LLM.
 */
export async function expandQuery(query: string): Promise<string[]> {
  const cacheKey = query.toLowerCase().trim();
  if (expansionCache.has(cacheKey)) return expansionCache.get(cacheKey)!;

  try {
    const { provider, modelId, proxyConfig } = await getDefaultModel();
    const model = await getModel(provider, modelId, proxyConfig);

    const { text } = await generateText({
      model,
      system: "You expand search queries for an academic paper database. Given a query, output 5-10 synonyms, related terms, and alternative phrasings that would help find relevant papers. Output ONLY a comma-separated list of terms, nothing else. Be specific to the research domain.",
      messages: [
        { role: "user", content: query },
      ],
    });

    const expanded = text
      .split(/,|\n/)
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length > 2 && t.length < 50)
      .slice(0, 10);

    expansionCache.set(cacheKey, expanded);
    return expanded;
  } catch {
    // LLM expansion is best-effort — fall back to no expansion
    expansionCache.set(cacheKey, []);
    return [];
  }
}

/**
 * Full query processing: stem original terms + expand via LLM + stem expansions.
 * Returns a deduplicated list of all terms to search for.
 */
export async function processQuery(query: string): Promise<string[]> {
  // Start stemming and LLM expansion in parallel
  const stemmed = stemTerms(query);
  const expanded = await expandQuery(query);

  const all = new Set(stemmed);
  for (const term of expanded) {
    // Add each expanded term and its stemmed variant
    const words = term.split(/\s+/).filter((w) => w.length > 2);
    for (const w of words) {
      all.add(w);
      const s = stem(w);
      if (s !== w) all.add(s);
    }
  }

  return Array.from(all);
}
