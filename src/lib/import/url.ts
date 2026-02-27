import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { fetchWithRetry } from "@/lib/import/semantic-scholar";

const OPENALEX_BASE = "https://api.openalex.org/works";
const CROSSREF_BASE = "https://api.crossref.org/works";
const CROSSREF_MAILTO = process.env.CROSSREF_MAILTO || "paperfinder@localhost";

// ── DOI types ────────────────────────────────────────────────────────

export interface DoiMetadata {
  title: string;
  abstract: string | null;
  authors: string[];
  year: number | null;
  venue: string | null;
  doi: string;
  openAccessPdfUrl: string | null;
}

// ── DOI extraction ───────────────────────────────────────────────────

/**
 * Extract a DOI from common publisher URL patterns.
 * Returns the bare DOI (e.g. "10.1073/pnas.2005087117") or null.
 */
export function extractDoiFromUrl(url: string): string | null {
  // Patterns:
  //   doi.org/10.XXXX/YYYY
  //   */doi/full/10.XXXX/YYYY
  //   */doi/10.XXXX/YYYY
  //   */article/10.XXXX/YYYY (nature.com)
  const match = url.match(
    /(?:doi\.org\/|\/(?:doi\/(?:full\/)?|article\/))?(10\.\d{4,9}\/[^\s?#]+)/i
  );
  if (!match) return null;
  // Strip trailing punctuation that might have been captured
  return match[1].replace(/[.)]+$/, "");
}

// ── OpenAlex abstract reconstruction ─────────────────────────────────

function reconstructAbstract(
  invertedIndex: Record<string, number[]>
): string {
  const words: [number, string][] = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    for (const pos of positions) {
      words.push([pos, word]);
    }
  }
  words.sort((a, b) => a[0] - b[0]);
  return words.map(([, w]) => w).join(" ");
}

// ── DOI metadata fetch ───────────────────────────────────────────────

/**
 * Fetch paper metadata by DOI. Tries OpenAlex first, falls back to CrossRef.
 */
export async function fetchDoiMetadata(
  doi: string
): Promise<DoiMetadata | null> {
  // 1. Try OpenAlex
  const oaResult = await fetchOpenAlexByDoi(doi);
  if (oaResult) return oaResult;

  // 2. Fall back to CrossRef
  const crResult = await fetchCrossRefByDoi(doi);
  if (crResult) return crResult;

  return null;
}

async function fetchOpenAlexByDoi(
  doi: string
): Promise<DoiMetadata | null> {
  // DOI contains slashes — don't encode it, OpenAlex expects the full URL as path
  const url = `${OPENALEX_BASE}/https://doi.org/${doi}?select=id,doi,title,display_name,publication_year,authorships,primary_location,open_access,abstract_inverted_index`;
  const res = await fetchWithRetry(url, "openalex", 200);
  if (!res) return null;

  const work = await res.json();
  const title = work.title || work.display_name;
  if (!title) return null;

  let abstract: string | null = null;
  if (work.abstract_inverted_index) {
    abstract = reconstructAbstract(work.abstract_inverted_index);
  }

  const authors: string[] = (work.authorships || []).map(
    (a: { author: { display_name: string } }) => a.author.display_name
  );

  const venue =
    work.primary_location?.source?.display_name ||
    work.primary_location?.raw_source_name ||
    null;

  return {
    title,
    abstract,
    authors,
    year: work.publication_year ?? null,
    venue,
    doi,
    openAccessPdfUrl: work.open_access?.oa_url || null,
  };
}

async function fetchCrossRefByDoi(
  doi: string
): Promise<DoiMetadata | null> {
  // DOI contains slashes — don't encode it, CrossRef expects it as path
  const url = `${CROSSREF_BASE}/${doi}?mailto=${encodeURIComponent(CROSSREF_MAILTO)}`;
  const res = await fetchWithRetry(url, "crossref", 150);
  if (!res) return null;

  const data = await res.json();
  const item = data.message;
  if (!item) return null;

  const title = item.title?.[0];
  if (!title) return null;

  let abstract: string | null = item.abstract || null;
  if (abstract) {
    // Strip JATS XML tags
    abstract = abstract.replace(/<[^>]+>/g, "").trim();
  }

  const authors: string[] = (item.author || [])
    .map(
      (a: { given?: string; family?: string }) =>
        [a.given, a.family].filter(Boolean).join(" ")
    )
    .filter(Boolean);

  const year = item.issued?.["date-parts"]?.[0]?.[0] ?? null;
  const venue = item["container-title"]?.[0] || null;

  return {
    title,
    abstract,
    authors,
    year,
    venue,
    doi,
    openAccessPdfUrl: null, // CrossRef doesn't provide OA PDF URLs
  };
}

// ── HTML fetching ────────────────────────────────────────────────────

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
};

/**
 * Fetch HTML from a URL using browser-like headers.
 * Returns the HTML string, trying to get content even from stubborn publishers.
 */
async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow" });
  if (!response.ok) {
    throw new Error(`Failed to fetch URL: ${response.status}`);
  }
  return response.text();
}

// ── Citation meta tag extraction ─────────────────────────────────────

/**
 * Extract paper metadata from HTML meta tags (citation_*, DC.*, og:*).
 * Publishers include these for Google Scholar indexing even on paywalled pages.
 */
export function extractMetaFromHtml(
  html: string,
  url: string
): UrlContent | null {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;

  const meta = (name: string): string | null => {
    const el =
      doc.querySelector(`meta[name="${name}"]`) ||
      doc.querySelector(`meta[property="${name}"]`);
    return el?.getAttribute("content") || null;
  };

  const metaAll = (name: string): string[] => {
    const els = doc.querySelectorAll(`meta[name="${name}"]`);
    return Array.from(els)
      .map((el) => el.getAttribute("content"))
      .filter((v): v is string => !!v);
  };

  const title =
    meta("citation_title") ||
    meta("DC.title") ||
    meta("og:title");

  if (!title) return null;

  const authors = metaAll("citation_author");
  const year = meta("citation_publication_date")?.split(/[/-]/)[0] ||
    meta("citation_date")?.split(/[/-]/)[0] || null;
  const venue = meta("citation_journal_title") || null;
  const abstract =
    meta("citation_abstract") ||
    meta("DC.description") ||
    meta("og:description") ||
    meta("description") ||
    null;
  const doi = meta("citation_doi") || null;
  const pdfUrl = meta("citation_pdf_url") || null;

  return {
    title,
    content: abstract || "",
    excerpt: abstract || "",
    siteName: venue,
    authors,
    year: year ? parseInt(year, 10) || null : null,
    doi,
    pdfUrl,
  };
}

// ── Readability extraction ───────────────────────────────────────────

export interface UrlContent {
  title: string;
  content: string;
  excerpt: string;
  siteName: string | null;
  // Optional fields from meta tag extraction
  authors?: string[];
  year?: number | null;
  doi?: string | null;
  pdfUrl?: string | null;
}

/**
 * Extract content from a URL. Tries:
 * 1. Fetch with browser-like headers
 * 2. Extract citation meta tags (works on most publisher sites)
 * 3. Fall back to Readability for full text extraction
 */
export async function extractUrlContent(url: string): Promise<UrlContent> {
  const html = await fetchHtml(url);
  const dom = new JSDOM(html, { url });

  // Try citation meta tags first — most reliable for publisher sites
  const metaResult = extractMetaFromHtml(html, url);

  // Try Readability for full text
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  // If we have meta tags, use them (possibly enriched with Readability content)
  if (metaResult) {
    return {
      ...metaResult,
      content: article?.textContent || metaResult.content,
      excerpt: metaResult.excerpt || article?.excerpt || "",
    };
  }

  // Pure Readability fallback
  if (article) {
    return {
      title: article.title || "Untitled",
      content: article.textContent || "",
      excerpt: article.excerpt || "",
      siteName: article.siteName || null,
    };
  }

  throw new Error("Could not extract content from URL");
}
