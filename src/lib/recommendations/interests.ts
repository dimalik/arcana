import { prisma } from "@/lib/prisma";
import { mergePaperVisibilityWhere } from "@/lib/papers/visibility";

export interface ContentQuery {
  query: string;             // search phrase (title or key finding)
  sourcePaperTitle: string;  // for "Similar to: ..." display
  weight: number;            // 0-1, engagement-based
}

export interface PaperSeed {
  s2Id: string;   // formatted as "DOI:xxx" or "ArXiv:xxx"
  weight: number;
  title: string;
}

export interface UserInterests {
  paperIds: PaperSeed[];          // DOI/arXiv IDs for S2 Recommendations API
  arxivCategories: string[];      // for arXiv latest search
  contentQueries: ContentQuery[];  // keyword fallback
  newestYear: number | null;
}

const ACADEMIC_PREFIX_RE = /^(a\s+)?(study|survey|review|analysis|investigation|exploration|overview|examination|comparison)\s+(of|on|in)\s+/i;

function cleanTitle(title: string): string {
  let cleaned = title.replace(ACADEMIC_PREFIX_RE, "").trim();
  if (cleaned.length > 80) cleaned = cleaned.slice(0, 80).replace(/\s\S*$/, "");
  return cleaned;
}

function truncateQuery(text: string, maxLen = 80): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).replace(/\s\S*$/, "");
}

// Valid arXiv category code pattern (e.g., cs.CL, math.AG, hep-ph)
const ARXIV_CATEGORY_RE = /^[a-z-]+(\.[A-Z]{2,})?$/;

/**
 * Extract user interests from their library.
 * When tagIds are provided, scopes to papers with those tags (for filtered recommendations).
 */
export async function extractInterests(userId: string, tagIds?: string[]): Promise<UserInterests> {
  // When tags are selected, scope all queries to papers that have at least one of those tags
  const tagScope = tagIds && tagIds.length > 0
    ? { tags: { some: { tagId: { in: tagIds } } } }
    : {};

  const [engagedPapers, arxivPapers, yearAgg] = await Promise.all([
    prisma.paper.findMany({
      where: mergePaperVisibilityWhere(userId, {
        processingStatus: "COMPLETED",
        ...tagScope,
        ...(tagIds && tagIds.length > 0
          ? {}
          : {
              OR: [
                { isLiked: true },
                { engagementScore: { gt: 0 } },
              ],
            }),
      }),
      select: {
        title: true,
        keyFindings: true,
        isLiked: true,
        engagementScore: true,
        doi: true,
        arxivId: true,
      },
      orderBy: [
        { isLiked: "desc" },
        { engagementScore: "desc" },
      ],
      take: 10,
    }),
    // Fetch arXiv papers to extract category codes from their URLs/metadata
    prisma.paper.findMany({
      where: mergePaperVisibilityWhere(userId, {
        sourceType: "ARXIV",
        processingStatus: "COMPLETED",
        ...tagScope,
      }),
      select: {
        arxivId: true,
        sourceUrl: true,
      },
      take: 50,
    }),
    prisma.paper.aggregate({
      where: mergePaperVisibilityWhere(userId, tagScope),
      _max: { year: true },
    }),
  ]);

  // Compute normalized weights
  const maxScore = engagedPapers.reduce(
    (max, p) => Math.max(max, p.engagementScore + (p.isLiked ? 5 : 0)),
    1
  );

  // Build paper IDs for S2 Recommendations API
  const paperIds: PaperSeed[] = [];
  for (const paper of engagedPapers) {
    const weight = (paper.engagementScore + (paper.isLiked ? 5 : 0)) / maxScore;
    if (paper.doi) {
      paperIds.push({ s2Id: `DOI:${paper.doi}`, weight, title: paper.title });
    } else if (paper.arxivId) {
      paperIds.push({ s2Id: `ArXiv:${paper.arxivId}`, weight, title: paper.title });
    }
  }

  // Extract arXiv categories from arxiv IDs by querying the arXiv API
  // For now, use common category prefixes from arxiv IDs (e.g., 2301.xxxxx → check paper metadata)
  // We'll extract categories from the source URLs or use a heuristic
  const categoryFreq = new Map<string, number>();
  for (const paper of arxivPapers) {
    // Extract categories from sourceUrl if it contains category info
    // ArXiv URLs sometimes have category: arxiv.org/abs/cs/0601001 (old format)
    const url = paper.sourceUrl || "";
    const oldFormatMatch = url.match(/arxiv\.org\/abs\/([a-z-]+(?:\.[A-Z]{2,})?)\//);
    if (oldFormatMatch) {
      const cat = oldFormatMatch[1];
      if (ARXIV_CATEGORY_RE.test(cat)) {
        categoryFreq.set(cat, (categoryFreq.get(cat) || 0) + 1);
      }
    }
  }

  // If we couldn't extract categories from URLs, use broad categories based on paper content
  // For a more robust approach, we'd query arXiv API for each paper's categories
  // but that's too many API calls. Instead, use the tags assigned to arXiv papers.
  if (categoryFreq.size === 0) {
    const arxivPapersWithTags = await prisma.paper.findMany({
      where: mergePaperVisibilityWhere(userId, {
        sourceType: "ARXIV",
        processingStatus: "COMPLETED",
        ...tagScope,
      }),
      select: {
        tags: { select: { tag: { select: { name: true } } } },
      },
      take: 20,
    });

    // Map common ML/AI/NLP tag names to arXiv categories
    const tagToCategoryMap: Record<string, string> = {
      "machine learning": "cs.LG",
      "deep learning": "cs.LG",
      "natural language processing": "cs.CL",
      "nlp": "cs.CL",
      "computer vision": "cs.CV",
      "reinforcement learning": "cs.LG",
      "artificial intelligence": "cs.AI",
      "robotics": "cs.RO",
      "information retrieval": "cs.IR",
      "speech": "cs.SD",
      "cryptography": "cs.CR",
      "databases": "cs.DB",
      "networks": "cs.NI",
      "optimization": "math.OC",
      "statistics": "stat.ML",
    };

    for (const paper of arxivPapersWithTags) {
      for (const { tag } of paper.tags) {
        const lower = tag.name.toLowerCase();
        const cat = tagToCategoryMap[lower];
        if (cat) {
          categoryFreq.set(cat, (categoryFreq.get(cat) || 0) + 1);
        }
      }
    }
  }

  // Sort categories by frequency, take top 4
  const arxivCategories = Array.from(categoryFreq.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([cat]) => cat);

  // Build content queries (keyword fallback)
  const contentQueries: ContentQuery[] = [];
  const MAX_QUERIES = 8;

  for (const paper of engagedPapers) {
    if (contentQueries.length >= MAX_QUERIES) break;

    const weight = (paper.engagementScore + (paper.isLiked ? 5 : 0)) / maxScore;
    const slots = weight >= 0.5 ? 2 : 1;

    // Slot 1: cleaned title
    const cleaned = cleanTitle(paper.title);
    if (cleaned.length >= 15 && contentQueries.length < MAX_QUERIES) {
      contentQueries.push({
        query: cleaned,
        sourcePaperTitle: paper.title,
        weight,
      });
    }

    // Slot 2 (high-weight only): first key finding
    if (slots >= 2 && paper.keyFindings && contentQueries.length < MAX_QUERIES) {
      try {
        const findings: string[] = JSON.parse(paper.keyFindings);
        const finding = findings.find((f) => f.length >= 20);
        if (finding) {
          contentQueries.push({
            query: truncateQuery(finding),
            sourcePaperTitle: paper.title,
            weight,
          });
        }
      } catch {
        // skip malformed JSON
      }
    }
  }

  const newestYear = yearAgg._max.year ?? null;

  return { paperIds, arxivCategories, contentQueries, newestYear };
}
