/**
 * Tag scoring using IDF-like formula.
 *
 * Tags that appear on 10-30% of papers are the "sweet spot" for retrieval.
 * Ubiquitous tags (>80%) and orphans/singletons get penalized.
 */

export type TagCategory =
  | "orphan"      // 0 papers
  | "singleton"   // 1 paper
  | "narrow"      // <10%
  | "good"        // 10-30% — sweet spot
  | "broad"       // 30-80%
  | "ubiquitous"; // >80%

export interface ScoredTag {
  id: string;
  name: string;
  paperCount: number;
  score: number;       // 0-1, higher = more discriminating
  category: TagCategory;
}

function categorize(paperCount: number, totalPapers: number): TagCategory {
  if (paperCount === 0) return "orphan";
  if (paperCount === 1) return "singleton";
  const pct = paperCount / totalPapers;
  if (pct < 0.1) return "narrow";
  if (pct <= 0.3) return "good";
  if (pct <= 0.8) return "broad";
  return "ubiquitous";
}

/**
 * Compute IDF-like scores for a set of tags.
 *
 * Formula: log(totalPapers / paperCount) / log(totalPapers)
 * - Normalized to 0-1 range
 * - "good" tags (10-30%) get a 1.2x bonus
 * - Orphans and ubiquitous tags get capped at 0
 */
export function computeTagScores(
  tags: { id: string; name: string; paperCount: number }[],
  totalPapers: number,
): ScoredTag[] {
  if (totalPapers === 0) {
    return tags.map((t) => ({ ...t, score: 0, category: "orphan" as TagCategory }));
  }

  const logTotal = Math.log(totalPapers);
  const scored = tags.map((t) => {
    const cat = categorize(t.paperCount, totalPapers);

    // Orphans and ubiquitous tags contribute zero retrieval value
    if (cat === "orphan" || cat === "ubiquitous") {
      return { ...t, score: 0, category: cat };
    }

    // IDF-like score
    let raw = t.paperCount > 0 && logTotal > 0
      ? Math.log(totalPapers / t.paperCount) / logTotal
      : 0;

    // Bonus for "good" range (10-30%)
    if (cat === "good") raw *= 1.2;

    // Singletons are slightly useful but not great
    if (cat === "singleton") raw *= 0.5;

    return { ...t, score: raw, category: cat };
  });

  // Normalize to max = 1.0
  const maxScore = Math.max(...scored.map((s) => s.score), 0.001);
  return scored.map((s) => ({
    ...s,
    score: Math.round((s.score / maxScore) * 1000) / 1000,
  }));
}

/**
 * Rank a paper's tags by score (descending) and return the top N.
 */
export function rankTagsForPaper(
  paperTags: { id: string; name: string; score: number }[],
  limit = 3,
): typeof paperTags {
  return [...paperTags].sort((a, b) => b.score - a.score).slice(0, limit);
}
