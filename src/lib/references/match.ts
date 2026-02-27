/**
 * Fuzzy title matching for linking extracted references to library papers.
 */

/** Lowercase, strip punctuation, collapse whitespace */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Compute similarity between two titles: exact (1.0), containment (0.9), or Jaccard overlap */
export function titleSimilarity(a: string, b: string): number {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);

  if (!na || !nb) return 0;

  // Exact match
  if (na === nb) return 1.0;

  // Containment: one title fully contained in the other,
  // but only if the shorter title is a significant portion of the longer one.
  // Without this ratio check, "Attention Is All You Need" would falsely match
  // "TransMLA: Multi-Head Latent Attention Is All You Need".
  const shorter = na.length < nb.length ? na : nb;
  const longer = na.length < nb.length ? nb : na;
  if (longer.includes(shorter) && shorter.length / longer.length >= 0.6) return 0.9;

  // Jaccard word-token overlap
  const tokensA = na.split(" ").filter(Boolean);
  const tokensB = nb.split(" ").filter(Boolean);
  const setB = new Set(tokensB);

  let intersection = 0;
  const seen = new Set<string>();
  for (let i = 0; i < tokensA.length; i++) {
    const w = tokensA[i];
    if (!seen.has(w)) {
      seen.add(w);
      if (setB.has(w)) intersection++;
    }
  }

  const union = seen.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

interface MatchCandidate {
  id: string;
  title: string;
}

interface MatchResult {
  paperId: string;
  confidence: number;
}

/** Find the best-matching library paper for a reference title */
export function findBestMatch(
  refTitle: string,
  libraryPapers: MatchCandidate[],
  threshold = 0.7
): MatchResult | null {
  let best: MatchResult | null = null;

  for (const paper of libraryPapers) {
    const score = titleSimilarity(refTitle, paper.title);
    if (score >= threshold && (!best || score > best.confidence)) {
      best = { paperId: paper.id, confidence: score };
    }
  }

  return best;
}

interface LibraryPaperWithIds {
  id: string;
  title: string;
  doi?: string | null;
  arxivId?: string | null;
}

/**
 * Find a library match using enriched IDs first (DOI, arxivId),
 * falling back to title similarity.
 */
export function findLibraryMatchByIds(
  ref: { doi?: string | null; arxivId?: string | null; title: string },
  libraryPapers: LibraryPaperWithIds[],
  threshold = 0.7
): MatchResult | null {
  // Try exact DOI match
  if (ref.doi) {
    const match = libraryPapers.find(
      (p) => p.doi && p.doi.toLowerCase() === ref.doi!.toLowerCase()
    );
    if (match) return { paperId: match.id, confidence: 1.0 };
  }

  // Try exact arxivId match
  if (ref.arxivId) {
    const match = libraryPapers.find(
      (p) => p.arxivId && p.arxivId === ref.arxivId
    );
    if (match) return { paperId: match.id, confidence: 1.0 };
  }

  // Fall back to title similarity
  return findBestMatch(
    ref.title,
    libraryPapers.map((p) => ({ id: p.id, title: p.title })),
    threshold
  );
}
