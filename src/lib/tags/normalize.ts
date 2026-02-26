/**
 * Tag normalization and fuzzy matching.
 *
 * Prevents duplicate tags like "nlp" vs "natural-language-processing"
 * by normalizing strings and computing similarity scores.
 */

// Common abbreviation expansions (bidirectional lookup)
const ABBREVIATIONS: Record<string, string[]> = {
  nlp: ["natural-language-processing", "natural-language"],
  cv: ["computer-vision"],
  ml: ["machine-learning"],
  dl: ["deep-learning"],
  rl: ["reinforcement-learning"],
  gan: ["generative-adversarial-network", "generative-adversarial-networks"],
  llm: ["large-language-model", "large-language-models"],
  cnn: ["convolutional-neural-network", "convolutional-neural-networks"],
  rnn: ["recurrent-neural-network", "recurrent-neural-networks"],
  vae: ["variational-autoencoder", "variational-autoencoders"],
  rag: ["retrieval-augmented-generation"],
  asr: ["automatic-speech-recognition", "speech-recognition"],
  ocr: ["optical-character-recognition"],
  ner: ["named-entity-recognition"],
  vit: ["vision-transformer", "vision-transformers"],
  gnn: ["graph-neural-network", "graph-neural-networks"],
  svm: ["support-vector-machine", "support-vector-machines"],
  pca: ["principal-component-analysis"],
  ai: ["artificial-intelligence"],
  ir: ["information-retrieval"],
  qa: ["question-answering"],
  mt: ["machine-translation"],
  tts: ["text-to-speech"],
  ssl: ["self-supervised-learning"],
};

// Build reverse map: expansion → abbreviation
const REVERSE_ABBREVIATIONS: Record<string, string> = {};
for (const [abbr, expansions] of Object.entries(ABBREVIATIONS)) {
  for (const exp of expansions) {
    REVERSE_ABBREVIATIONS[exp] = abbr;
  }
}

/**
 * Normalize a tag to a canonical form for comparison.
 * - lowercase
 * - replace spaces/underscores with hyphens
 * - strip trailing 's' for simple depluralization
 * - collapse multiple hyphens
 */
export function normalizeTag(tag: string): string {
  let s = tag.toLowerCase().trim();
  s = s.replace(/[\s_]+/g, "-");
  s = s.replace(/-+/g, "-");
  s = s.replace(/^-|-$/g, "");
  // Simple depluralization: strip trailing 's' if word is > 4 chars
  // but not for words ending in 'ss', 'us', 'is'
  if (s.length > 4 && s.endsWith("s") && !s.endsWith("ss") && !s.endsWith("us") && !s.endsWith("is")) {
    s = s.slice(0, -1);
  }
  return s;
}

/**
 * Produce a "stem" by stripping hyphens entirely.
 * Used for substring/containment checks.
 */
function stem(tag: string): string {
  return normalizeTag(tag).replace(/-/g, "");
}

/**
 * Levenshtein distance between two strings.
 */
function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () =>
    Array(n + 1).fill(0)
  );
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

/**
 * Compute similarity score between two tag strings (0-1, higher = more similar).
 */
export function tagSimilarity(a: string, b: string): number {
  const na = normalizeTag(a);
  const nb = normalizeTag(b);

  // Exact match after normalization
  if (na === nb) return 1.0;

  // Check abbreviation equivalence
  const abbrA = ABBREVIATIONS[na];
  const abbrB = ABBREVIATIONS[nb];
  if (abbrA && abbrA.some((exp) => normalizeTag(exp) === nb)) return 1.0;
  if (abbrB && abbrB.some((exp) => normalizeTag(exp) === na)) return 1.0;
  // Both map to the same abbreviation
  const revA = REVERSE_ABBREVIATIONS[na];
  const revB = REVERSE_ABBREVIATIONS[nb];
  if (revA && revA === revB) return 1.0;
  if (revA && revA === nb) return 1.0;
  if (revB && revB === na) return 1.0;

  // Stem-based containment
  const sa = stem(a);
  const sb = stem(b);
  if (sa === sb) return 0.95;
  if (sa.length >= 4 && sb.length >= 4) {
    if (sa.includes(sb) || sb.includes(sa)) return 0.85;
  }

  // Levenshtein on normalized forms
  const maxLen = Math.max(na.length, nb.length);
  if (maxLen === 0) return 1.0;
  const dist = levenshtein(na, nb);
  const lev = 1 - dist / maxLen;

  // Levenshtein on stems (catches "transformers" vs "transformer")
  const stemDist = levenshtein(sa, sb);
  const stemMaxLen = Math.max(sa.length, sb.length);
  const stemLev = stemMaxLen > 0 ? 1 - stemDist / stemMaxLen : 1.0;

  return Math.max(lev, stemLev);
}

/**
 * Given a candidate tag name and list of existing tags,
 * find the best matching existing tag if similarity >= threshold.
 *
 * Returns the matching existing tag or null if no good match.
 */
export function findMatchingTag(
  candidate: string,
  existingTags: { id: string; name: string }[],
  threshold = 0.8
): { id: string; name: string; similarity: number } | null {
  let best: { id: string; name: string; similarity: number } | null = null;

  for (const tag of existingTags) {
    const sim = tagSimilarity(candidate, tag.name);
    if (sim >= threshold && (!best || sim > best.similarity)) {
      best = { id: tag.id, name: tag.name, similarity: sim };
    }
  }

  return best;
}

/**
 * Find groups of duplicate tags from a full list.
 * Returns arrays of tags that are similar to each other.
 */
export function findDuplicateGroups(
  tags: { id: string; name: string }[],
  threshold = 0.8
): { id: string; name: string }[][] {
  const used = new Set<string>();
  const groups: { id: string; name: string }[][] = [];

  for (let i = 0; i < tags.length; i++) {
    if (used.has(tags[i].id)) continue;

    const group = [tags[i]];
    for (let j = i + 1; j < tags.length; j++) {
      if (used.has(tags[j].id)) continue;
      if (tagSimilarity(tags[i].name, tags[j].name) >= threshold) {
        group.push(tags[j]);
        used.add(tags[j].id);
      }
    }

    if (group.length > 1) {
      used.add(tags[i].id);
      groups.push(group);
    }
  }

  return groups;
}
