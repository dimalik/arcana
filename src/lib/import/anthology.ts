/**
 * ACL Anthology paper import.
 *
 * ACL Anthology URLs follow the pattern: https://aclanthology.org/{id}/
 * DOIs follow: 10.18653/v1/{id}
 * PDFs are at: https://aclanthology.org/{id}.pdf
 *
 * Metadata is fetched via the DOI (CrossRef/OpenAlex) with fallback
 * to HTML scraping of the anthology page itself.
 */

import { fetchWithRetry } from "@/lib/import/semantic-scholar";
import { fetchDoiMetadata, type DoiMetadata } from "@/lib/import/url";

const ANTHOLOGY_BASE = "https://aclanthology.org";

export interface AnthologyMetadata {
  title: string;
  abstract: string | null;
  authors: string[];
  year: number | null;
  venue: string | null;
  doi: string;
  anthologyId: string;
  pdfUrl: string;
}

/**
 * Parse an ACL Anthology ID from a URL or bare ID.
 * Handles:
 *   - https://aclanthology.org/P19-3019/
 *   - https://aclanthology.org/P19-3019
 *   - https://aclanthology.org/2023.acl-long.1/
 *   - P19-3019
 *   - 2023.acl-long.1
 */
export function parseAnthologyId(input: string): string | null {
  const trimmed = input.trim();

  // Try URL pattern
  const urlMatch = trimmed.match(
    /aclanthology\.org\/([A-Za-z0-9][\w.-]+[A-Za-z0-9])\/?$/
  );
  if (urlMatch) return urlMatch[1];

  // Try bare ID patterns:
  //   Old format: P19-3019, D18-1234, N19-1234, etc.
  //   New format: 2023.acl-long.1, 2022.emnlp-main.42, etc.
  if (/^[A-Z]\d{2}-\d{4}$/i.test(trimmed)) return trimmed;
  if (/^\d{4}\.\w[\w.-]*\.\d+$/i.test(trimmed)) return trimmed;

  return null;
}

/**
 * Fetch metadata for an ACL Anthology paper.
 * Strategy: DOI lookup (via OpenAlex/CrossRef) → HTML scrape fallback.
 */
export async function fetchAnthologyMetadata(
  anthologyId: string
): Promise<AnthologyMetadata> {
  const doi = `10.18653/v1/${anthologyId}`;
  const pdfUrl = `${ANTHOLOGY_BASE}/${anthologyId}.pdf`;

  // Try DOI-based metadata first (most reliable for structured data)
  const doiMeta = await fetchDoiMetadata(doi);

  if (doiMeta) {
    return {
      title: doiMeta.title,
      abstract: doiMeta.abstract,
      authors: doiMeta.authors,
      year: doiMeta.year,
      venue: doiMeta.venue,
      doi,
      anthologyId,
      pdfUrl,
    };
  }

  // Fallback: scrape the anthology page
  const pageUrl = `${ANTHOLOGY_BASE}/${anthologyId}/`;
  const res = await fetchWithRetry(pageUrl, "anthology", 200);

  if (!res) {
    throw new Error(`Could not fetch ACL Anthology page for ${anthologyId}`);
  }

  const html = await res.text();
  return parseAnthologyPage(html, anthologyId, doi, pdfUrl);
}

/**
 * Parse metadata from ACL Anthology HTML page.
 */
function parseAnthologyPage(
  html: string,
  anthologyId: string,
  doi: string,
  pdfUrl: string
): AnthologyMetadata {
  // Title: <h2 id="title"> or <meta property="og:title">
  const titleMatch =
    html.match(/<h2[^>]*id="title"[^>]*>([^<]+)<\/h2>/i) ||
    html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]+)"/i);
  const title = titleMatch
    ? titleMatch[1].trim().replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    : anthologyId;

  // Authors: from <meta name="citation_author"> or from the page's author links
  const authorMatches = html.matchAll(
    /<meta[^>]*name="citation_author"[^>]*content="([^"]+)"/gi
  );
  let authors = Array.from(authorMatches, (m) => m[1]);

  if (authors.length === 0) {
    // Fallback: author links in the page
    const authorLinkMatches = html.matchAll(
      /class="[^"]*author[^"]*"[^>]*>([^<]+)</gi
    );
    authors = Array.from(authorLinkMatches, (m) => m[1].trim());
  }

  // Year: from citation_date or URL pattern
  const yearMatch =
    html.match(/<meta[^>]*name="citation_(?:date|publication_date)"[^>]*content="(\d{4})/i) ||
    anthologyId.match(/^(\d{4})\./);
  const year = yearMatch ? parseInt(yearMatch[1], 10) : null;

  // Venue: from booktitle or journal in BibTeX block
  const venueMatch = html.match(
    /(?:booktitle|journal)\s*=\s*["{]([^"}]+)["}]/i
  );
  const venue = venueMatch ? venueMatch[1].trim() : null;

  // Abstract: from <div class="acl-abstract"> or <span class="d-block">
  const abstractMatch =
    html.match(/<div[^>]*class="[^"]*acl-abstract[^"]*"[^>]*>[\s\S]*?<span[^>]*>([\s\S]*?)<\/span>/i) ||
    html.match(/<meta[^>]*name="description"[^>]*content="([^"]+)"/i);
  const abstract = abstractMatch
    ? abstractMatch[1].trim().replace(/<[^>]+>/g, "").replace(/\s+/g, " ")
    : null;

  return {
    title,
    abstract,
    authors,
    year,
    venue,
    doi,
    anthologyId,
    pdfUrl,
  };
}

/**
 * Download the PDF for an ACL Anthology paper.
 */
export async function downloadAnthologyPdf(
  anthologyId: string
): Promise<string> {
  const pdfUrl = `${ANTHOLOGY_BASE}/${anthologyId}.pdf`;

  const fs = await import("fs/promises");
  const path = await import("path");
  const { v4: uuid } = await import("uuid");

  const filename = `anthology-${anthologyId.replace(/[\/\\]/g, "-")}-${uuid().slice(0, 8)}.pdf`;
  const filePath = path.join("uploads", filename);

  // Ensure uploads directory exists
  await fs.mkdir("uploads", { recursive: true });

  const res = await fetch(pdfUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (compatible; PaperFinder/1.0; +mailto:paperfinder@localhost)",
    },
  });

  if (!res.ok) {
    throw new Error(`Failed to download PDF: ${res.status} ${res.statusText}`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(filePath, buffer);
  return filePath;
}
