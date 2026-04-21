import { XMLParser } from "fast-xml-parser";
import type { RecommendedPaper } from "./types";

const ARXIV_API = "https://export.arxiv.org/api/query";
const DELAY_MS = 3000; // arXiv rate limit: 3s between requests

interface ArxivEntry {
  id: string;
  title: string;
  summary: string;
  published: string;
  author: { name: string } | { name: string }[];
  category: { "@_term": string } | { "@_term": string }[];
  link?: { "@_href": string; "@_title"?: string } | { "@_href": string; "@_title"?: string }[];
}

function parseEntry(entry: ArxivEntry, matchReason?: string): RecommendedPaper {
  const authors = Array.isArray(entry.author)
    ? entry.author.map((a) => a.name)
    : [entry.author?.name].filter(Boolean) as string[];

  const year = entry.published
    ? new Date(entry.published).getFullYear()
    : null;

  // Extract arXiv ID from the entry id URL (e.g. http://arxiv.org/abs/2401.12345v1)
  const idMatch = String(entry.id).match(/(\d{4}\.\d{4,5})(v\d+)?$/);
  const arxivId = idMatch ? idMatch[1] : null;

  return {
    title: String(entry.title || "").replace(/\s+/g, " ").trim(),
    abstract: entry.summary ? String(entry.summary).replace(/\s+/g, " ").trim() : null,
    authors,
    year,
    doi: null,
    arxivId,
    externalUrl: arxivId ? `https://arxiv.org/abs/${arxivId}` : String(entry.id),
    citationCount: null,
    openAccessPdfUrl: arxivId ? `https://arxiv.org/pdf/${arxivId}.pdf` : null,
    source: "arxiv",
    matchReason,
  };
}

/**
 * Search arXiv for recent submissions in a given category.
 */
export async function searchArxivRecent(
  category: string,
  maxResults = 5
): Promise<RecommendedPaper[]> {
  const url = `${ARXIV_API}?search_query=cat:${encodeURIComponent(category)}&sortBy=submittedDate&sortOrder=descending&max_results=${maxResults}`;

  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`[arxiv-search] ${res.status} for category ${category}`);
    return [];
  }

  const xml = await res.text();
  const parser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
  });
  const result = parser.parse(xml);

  const entries: ArxivEntry[] = result.feed?.entry
    ? Array.isArray(result.feed.entry)
      ? result.feed.entry
      : [result.feed.entry]
    : [];

  return entries.map((e) => parseEntry(e, category));
}

/**
 * Search multiple arXiv categories with rate-limiting delay between requests.
 */
export async function searchArxivCategories(
  categories: string[],
  maxPerCategory = 5
): Promise<RecommendedPaper[]> {
  const results: RecommendedPaper[] = [];

  for (let i = 0; i < categories.length; i++) {
    if (i > 0) {
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    }
    const papers = await searchArxivRecent(categories[i], maxPerCategory);
    results.push(...papers);
  }

  return results;
}
