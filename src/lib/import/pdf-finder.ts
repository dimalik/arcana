/**
 * Multi-source open-access PDF finder.
 *
 * Tries sources in priority order:
 *   1. Provided URL (from OpenAlex/S2 during discovery)
 *   2. Direct arXiv PDF (if arXiv paper)
 *   3. Unpaywall (best OA coverage, free with email)
 *   4. Semantic Scholar openAccessPdf
 *   5. Europe PMC (biomedical papers)
 *   6. Publisher page scraping (follow DOI, extract PDF links from HTML)
 *
 * Returns the downloaded PDF buffer or null.
 */

import { fetchWithRetry } from "./semantic-scholar";
import { searchDuckDuckGo } from "./web-search";
import { titleSimilarity } from "@/lib/references/match";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { v4 as uuidv4 } from "uuid";

const UNPAYWALL_EMAIL =
  process.env.CROSSREF_MAILTO || "paperfinder@localhost";

export interface PdfDownloadResult {
  filePath: string; // relative path like "uploads/doi-abc123.pdf"
  source: string; // which source provided the PDF
  needsConfirmation?: boolean; // true if found via web search with close but not exact title match
  webSearchUrl?: string; // the URL found via web search (audit trail)
}

/**
 * Try to find and download an open-access PDF from multiple sources.
 * Saves the PDF to uploads/ and returns the relative path.
 */
export async function findAndDownloadPdf(opts: {
  doi?: string | null;
  arxivId?: string | null;
  existingPdfUrl?: string | null;
  title?: string | null;
}): Promise<PdfDownloadResult | null> {
  const candidates = await collectPdfUrls(opts);

  for (const { url, source } of candidates) {
    const buffer = await tryDownloadPdf(url);
    if (buffer) {
      const filePath = await savePdfBuffer(buffer, source);
      console.log(`[pdf-finder] Downloaded PDF from ${source}: ${url}`);
      return { filePath, source };
    }
  }

  if (candidates.length > 0) {
    console.log(
      `[pdf-finder] Tried ${candidates.length} sources, none returned a valid PDF`
    );
  }

  // Last resort: PMC OA package (downloads tar.gz, extracts PDF)
  if (opts.doi) {
    const pmcResult = await tryPmcOaPackage(opts.doi);
    if (pmcResult) return pmcResult;
  }

  // Absolute last resort: web search for the paper title + "pdf"
  if (opts.title) {
    const webResult = await tryWebSearchForPdf(opts.title);
    if (webResult) return webResult;
  }

  return null;
}

// ── Candidate URL collection ─────────────────────────────────────────

interface PdfCandidate {
  url: string;
  source: string;
}

async function collectPdfUrls(opts: {
  doi?: string | null;
  arxivId?: string | null;
  existingPdfUrl?: string | null;
}): Promise<PdfCandidate[]> {
  const candidates: PdfCandidate[] = [];
  const seen = new Set<string>();

  function add(url: string, source: string) {
    if (!url || seen.has(url)) return;
    seen.add(url);
    candidates.push({ url, source });
  }

  // Extract arXiv ID from DOI if not explicitly provided
  // DOIs like "10.48550/arXiv.2502.15902" contain the arXiv ID
  let arxivId = opts.arxivId || null;
  if (!arxivId && opts.doi) {
    const doiArxivMatch = opts.doi.match(/10\.48550\/arXiv\.(\d+\.\d+)/i);
    if (doiArxivMatch) {
      arxivId = doiArxivMatch[1];
      console.log(`[pdf-finder] Extracted arXiv ID ${arxivId} from DOI ${opts.doi}`);
    }
  }

  // 1. Existing URL (already known from discovery/OpenAlex)
  if (opts.existingPdfUrl) {
    add(opts.existingPdfUrl, "existing");
  }

  // 2. ArXiv direct (always works for arXiv papers)
  if (arxivId) {
    add(`https://arxiv.org/pdf/${arxivId}.pdf`, "arxiv");
  }

  // 3-5. API lookups (run in parallel for speed)
  if (opts.doi) {
    const [unpaywall, s2, pmcUrls] = await Promise.all([
      fetchUnpaywallPdfUrl(opts.doi),
      fetchS2PdfUrl(opts.doi),
      fetchEuropePmcPdfUrls(opts.doi),
    ]);

    // PMC URLs first — they're the most reliable (no Cloudflare, always OA)
    for (const pmcUrl of pmcUrls) {
      add(pmcUrl, "europepmc");
    }
    if (unpaywall) add(unpaywall, "unpaywall");
    if (s2) add(s2, "semantic-scholar");

  }

  // 6. Follow DOI to publisher page and scrape for PDF links (last resort)
  if (opts.doi) {
    const publisherPdfs = await scrapePublisherPdfUrls(opts.doi);
    for (const pdfUrl of publisherPdfs) {
      add(pdfUrl, "publisher");
    }
  }

  return candidates;
}

// ── Unpaywall ────────────────────────────────────────────────────────

async function fetchUnpaywallPdfUrl(
  doi: string
): Promise<string | null> {
  const url = `https://api.unpaywall.org/v2/${doi}?email=${encodeURIComponent(UNPAYWALL_EMAIL)}`;
  const res = await fetchWithRetry(url, "unpaywall", 200);
  if (!res) return null;

  try {
    const data = await res.json();
    // best_oa_location has the highest-quality OA version
    return (
      data.best_oa_location?.url_for_pdf ||
      data.best_oa_location?.url_for_landing_page ||
      null
    );
  } catch {
    return null;
  }
}

// ── Semantic Scholar ─────────────────────────────────────────────────

async function fetchS2PdfUrl(doi: string): Promise<string | null> {
  const url = `https://api.semanticscholar.org/graph/v1/paper/DOI:${doi}?fields=openAccessPdf`;
  const { getS2Headers } = await import("./semantic-scholar");
  const headers = await getS2Headers();
  const res = await fetchWithRetry(url, "s2", 1100, headers);
  if (!res) return null;

  try {
    const data = await res.json();
    return data.openAccessPdf?.url || null;
  } catch {
    return null;
  }
}

// ── Europe PMC ───────────────────────────────────────────────────────

async function fetchEuropePmcPdfUrls(doi: string): Promise<string[]> {
  const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=DOI:${encodeURIComponent(doi)}&format=json&resultType=core&pageSize=1`;
  const res = await fetchWithRetry(url, "europepmc", 200);
  if (!res) return [];

  try {
    const data = await res.json();
    const result = data.resultList?.result?.[0];
    if (!result) return [];

    const pdfUrls: string[] = [];

    // Collect ALL PDF URLs from fullTextUrlList
    const urls = result.fullTextUrlList?.fullTextUrl;
    if (Array.isArray(urls)) {
      // Prefer Europe_PMC's own PDFs (no Cloudflare), then others
      const sorted = [...urls].filter(
        (u: { documentStyle?: string }) => u.documentStyle === "pdf"
      ).sort((a: { site?: string }, b: { site?: string }) => {
        // Europe_PMC PDFs first (most reliable), publisher PDFs last (may have Cloudflare)
        const aIsPmc = (a.site || "").includes("Europe_PMC") ? 0 : 1;
        const bIsPmc = (b.site || "").includes("Europe_PMC") ? 0 : 1;
        return aIsPmc - bIsPmc;
      });
      for (const entry of sorted) {
        if ((entry as { url?: string }).url) pdfUrls.push((entry as { url: string }).url);
      }
    }

    // Also add PMC render URL if we have a PMCID (reliable, no Cloudflare)
    if (result.pmcid) {
      const pmcUrl = `https://europepmc.org/articles/${result.pmcid}?pdf=render`;
      if (!pdfUrls.includes(pmcUrl)) {
        pdfUrls.unshift(pmcUrl); // Highest priority — always works
      }
    }

    return pdfUrls;
  } catch {
    return [];
  }
}

// ── PMC OA Package (tar.gz with PDF) ────────────────────────────────

/**
 * Download a PDF from PMC's Open Access FTP package.
 * This is the most reliable source for PMC papers — even when publisher
 * sites are behind Cloudflare, PMC's FTP always serves the OA PDF.
 *
 * Flow: DOI → Europe PMC API (get PMCID) → PMC OA service (get FTP URL) → download tar.gz → extract PDF
 */
async function tryPmcOaPackage(doi: string): Promise<PdfDownloadResult | null> {
  try {
    // Step 1: Get PMCID from Europe PMC
    const pmcSearchUrl = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=DOI:${encodeURIComponent(doi)}&format=json&pageSize=1`;
    const pmcSearchRes = await fetchWithRetry(pmcSearchUrl, "europepmc", 200);
    if (!pmcSearchRes) return null;

    const pmcData = await pmcSearchRes.json();
    const pmcid = pmcData.resultList?.result?.[0]?.pmcid;
    if (!pmcid) return null;

    // Step 2: Get FTP URL from PMC OA service
    const oaUrl = `https://www.ncbi.nlm.nih.gov/pmc/utils/oa/oa.fcgi?id=${pmcid}`;
    const oaRes = await fetch(oaUrl, { signal: AbortSignal.timeout(10_000) });
    if (!oaRes.ok) return null;

    const oaXml = await oaRes.text();
    const ftpMatch = oaXml.match(/href="(ftp:\/\/[^"]+\.tar\.gz)"/);
    if (!ftpMatch) return null;

    // Convert FTP URL to HTTPS (NCBI supports both)
    const tarUrl = ftpMatch[1].replace("ftp://ftp.ncbi.nlm.nih.gov", "https://ftp.ncbi.nlm.nih.gov");
    console.log(`[pdf-finder] Downloading PMC OA package: ${tarUrl}`);

    // Step 3: Download tar.gz
    const tarRes = await fetch(tarUrl, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(120_000), // Large packages
    });
    if (!tarRes.ok) return null;

    const tarBuffer = Buffer.from(await tarRes.arrayBuffer());

    // Step 4: Extract PDF from tar.gz
    // Use zlib to decompress, then scan for PDF file entries
    const { gunzipSync } = await import("zlib");
    const tarData = gunzipSync(tarBuffer);

    // Simple tar parser: each entry has a 512-byte header with filename at offset 0
    // and filesize (octal) at offset 124, followed by the file data padded to 512 bytes
    let offset = 0;
    while (offset < tarData.length - 512) {
      const header = tarData.subarray(offset, offset + 512);
      const nameEnd = header.indexOf(0);
      const name = header.subarray(0, Math.min(nameEnd, 100)).toString("utf-8");
      if (!name) break;

      const sizeStr = header.subarray(124, 136).toString("utf-8").trim();
      const size = parseInt(sizeStr, 8) || 0;

      offset += 512; // Move past header

      // Look for the main PDF (not supplemental/reviewer files)
      if (name.endsWith(".pdf") && !name.includes("supplement") && !name.includes("reviewer") && !name.includes("response") && !name.includes("original_submission") && !name.includes("revision")) {
        const pdfData = tarData.subarray(offset, offset + size);
        // Validate it's a real PDF
        if (pdfData.length >= 5 && pdfData.subarray(0, 5).toString() === "%PDF-") {
          const filePath = await savePdfBuffer(Buffer.from(pdfData), "pmc-oa");
          console.log(`[pdf-finder] Extracted PDF from PMC OA package: ${name}`);
          return { filePath, source: "pmc-oa" };
        }
      }

      // Advance past file data (padded to 512 bytes)
      offset += Math.ceil(size / 512) * 512;
    }

    console.log(`[pdf-finder] No suitable PDF found in PMC OA package for ${pmcid}`);
    return null;
  } catch (err) {
    console.log(`[pdf-finder] PMC OA package failed for DOI ${doi}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

// ── Publisher page scraping ──────────────────────────────────────────

/**
 * Follow a DOI to the publisher's landing page and extract PDF URLs from HTML.
 *
 * Most academic publishers embed PDF links in standard meta tags:
 *   <meta name="citation_pdf_url" content="...">
 *   <meta property="citation_pdf_url" content="...">
 *
 * We also check for common patterns in <a href> and <link> tags, and
 * apply publisher-specific URL transformations (e.g., /article/ → /article-pdf/).
 */
async function scrapePublisherPdfUrls(doi: string): Promise<string[]> {
  try {
    // Follow DOI redirect to get the publisher URL
    const doiUrl = `https://doi.org/${doi}`;
    const res = await fetch(doiUrl, {
      headers: { ...BROWSER_HEADERS, Accept: "text/html,application/xhtml+xml,*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) return [];

    const finalUrl = res.url; // The resolved publisher URL after redirects
    const html = await res.text();
    const candidates: string[] = [];
    const seen = new Set<string>();

    const add = (url: string) => {
      if (!url || seen.has(url)) return;
      try {
        // Resolve relative URLs against the final page URL
        const resolved = new URL(url, finalUrl).href;
        if (!seen.has(resolved)) {
          seen.add(resolved);
          candidates.push(resolved);
        }
      } catch { /* invalid URL */ }
    };

    // 1. citation_pdf_url meta tag — the gold standard for academic publishers
    const citationPdfMatch = html.match(/<meta\s+(?:name|property)\s*=\s*["']citation_pdf_url["']\s+content\s*=\s*["']([^"']+)["']/i);
    if (citationPdfMatch) {
      add(citationPdfMatch[1]);
    }
    // Also match reversed attribute order: content before name
    const citationPdfMatch2 = html.match(/<meta\s+content\s*=\s*["']([^"']+)["']\s+(?:name|property)\s*=\s*["']citation_pdf_url["']/i);
    if (citationPdfMatch2) {
      add(citationPdfMatch2[1]);
    }

    // 2. <link rel="alternate" type="application/pdf">
    const linkPdfMatch = html.match(/<link\s+[^>]*type\s*=\s*["']application\/pdf["'][^>]*href\s*=\s*["']([^"']+)["']/i);
    if (linkPdfMatch) {
      add(linkPdfMatch[1]);
    }

    // 3. Common publisher PDF URL patterns based on the landing page URL
    const publisherPatterns = generatePublisherPdfUrls(finalUrl);
    for (const pdfUrl of publisherPatterns) {
      add(pdfUrl);
    }

    // 4. Scan for PDF links in the HTML (href="...pdf..." patterns)
    // Be selective — only match links that look like direct PDF downloads
    const pdfLinkRegex = /href\s*=\s*["']([^"']*\.pdf(?:\?[^"']*)?)["']/gi;
    let match;
    while ((match = pdfLinkRegex.exec(html)) !== null) {
      // Skip navigation/utility PDFs
      const href = match[1];
      if (href.includes("policy") || href.includes("terms") || href.includes("license")) continue;
      add(href);
    }

    // 5. Look for PDF download buttons/links (common class names and text)
    const downloadLinkRegex = /href\s*=\s*["']([^"']+)["'][^>]*(?:class\s*=\s*["'][^"']*(?:pdf|download)[^"']*["']|>[\s\S]*?(?:Download\s*PDF|Full\s*Text\s*PDF|PDF\s*Download))/gi;
    while ((match = downloadLinkRegex.exec(html)) !== null) {
      add(match[1]);
    }

    if (candidates.length > 0) {
      console.log(`[pdf-finder] Scraped ${candidates.length} PDF candidate(s) from publisher page: ${finalUrl}`);
    }

    return candidates;
  } catch (err) {
    console.log(`[pdf-finder] Publisher scrape failed for DOI ${doi}:`, err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Generate likely PDF URLs from known publisher URL patterns.
 * These are URL transformations that work for major publishers.
 */
function generatePublisherPdfUrls(landingUrl: string): string[] {
  const urls: string[] = [];

  try {
    const u = new URL(landingUrl);
    const host = u.hostname;
    const path = u.pathname;

    // Oxford Academic: /article/... → /article-pdf/...
    if (host.includes("academic.oup.com") && path.includes("/article/")) {
      urls.push(landingUrl.replace("/article/", "/article-pdf/"));
    }

    // Springer/Nature: add .pdf suffix
    if ((host.includes("link.springer.com") || host.includes("nature.com")) && !path.endsWith(".pdf")) {
      urls.push(`${landingUrl}.pdf`);
      // Springer content PDFs
      if (path.includes("/article/")) {
        urls.push(landingUrl.replace("/article/", "/content/pdf/") + ".pdf");
      }
    }

    // Wiley: /doi/abs/ or /doi/full/ → /doi/pdfdirect/
    if (host.includes("onlinelibrary.wiley.com")) {
      urls.push(landingUrl.replace(/\/doi\/(abs|full)\//, "/doi/pdfdirect/"));
    }

    // MDPI: add /pdf at the end
    if (host.includes("mdpi.com") && !path.endsWith("/pdf")) {
      urls.push(`${landingUrl}/pdf`);
    }

    // PLoS: add ?type=printable
    if (host.includes("journals.plos.org") && !landingUrl.includes("type=printable")) {
      urls.push(`${landingUrl}?type=printable`);
    }

    // ScienceDirect: /science/article/pii/XXX → /science/article/pii/XXX/pdf
    if (host.includes("sciencedirect.com") && path.includes("/pii/") && !path.endsWith("/pdf")) {
      urls.push(`${landingUrl}/pdf`);
    }

    // Frontiers: add /pdf
    if (host.includes("frontiersin.org") && !path.endsWith("/pdf")) {
      urls.push(`${landingUrl}/pdf`);
    }

    // IEEE: /document/XXX → /stamp/stamp.jsp?tp=&arnumber=XXX
    if (host.includes("ieeexplore.ieee.org") && path.includes("/document/")) {
      const arnumber = path.match(/\/document\/(\d+)/)?.[1];
      if (arnumber) {
        urls.push(`https://ieeexplore.ieee.org/stamp/stamp.jsp?tp=&arnumber=${arnumber}`);
      }
    }

    // ACM DL: /doi/XXX → /doi/pdf/XXX
    if (host.includes("dl.acm.org") && path.startsWith("/doi/") && !path.includes("/pdf/")) {
      urls.push(landingUrl.replace(/\/doi\//, "/doi/pdf/"));
    }

    // GigaScience (Oxford): same as OUP pattern
    // Already covered by academic.oup.com pattern above

  } catch { /* invalid URL */ }

  return urls;
}

// ── PDF download + validation ────────────────────────────────────────

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "application/pdf,*/*",
};

async function tryDownloadPdf(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) return null;

    const buffer = Buffer.from(await res.arrayBuffer());

    // Validate: PDF files start with %PDF
    if (buffer.length < 5 || buffer.subarray(0, 5).toString() !== "%PDF-") {
      return null;
    }

    return buffer;
  } catch {
    return null;
  }
}

// ── Save to disk ─────────────────────────────────────────────────────

async function savePdfBuffer(
  buffer: Buffer,
  source: string
): Promise<string> {
  const uploadDir = path.join(process.cwd(), "uploads");
  await mkdir(uploadDir, { recursive: true });
  const filename = `${source}-${uuidv4().slice(0, 8)}.pdf`;
  const fullPath = path.join(uploadDir, filename);
  await writeFile(fullPath, buffer);
  return `uploads/${filename}`;
}

// ── Web search fallback ──────────────────────────────────────────────

/**
 * Last resort: search the web for a PDF of the paper.
 * Useful for paywalled papers that might be on arXiv under a slightly different title,
 * or on institutional repositories.
 */
async function tryWebSearchForPdf(title: string): Promise<PdfDownloadResult | null> {
  try {
    // Try two queries: exact title with filetype, then relaxed
    const queries = [
      `"${title}" filetype:pdf`,
      `"${title}" pdf`,
    ];

    for (const query of queries) {
      const results = await searchDuckDuckGo(query, 5);

      for (const result of results) {
        // Check title similarity — must be a reasonable match
        const sim = titleSimilarity(title, result.title.replace(/\s*\[PDF\]\s*/gi, "").replace(/\s*-\s*$/, "").trim());

        // Skip low-confidence matches
        if (sim < 0.6) continue;

        // Check if URL looks like a direct PDF link
        const isPdfUrl = /\.pdf($|\?)/i.test(result.url);

        // For direct PDF URLs, try downloading even with moderate similarity
        if (isPdfUrl && sim >= 0.6) {
          const buffer = await tryDownloadPdf(result.url);
          if (buffer) {
            const filePath = await savePdfBuffer(buffer, "websearch");
            const needsConfirmation = sim < 0.85;
            console.log(`[pdf-finder] Web search found PDF (similarity=${sim.toFixed(2)}, confirm=${needsConfirmation}): ${result.url}`);
            return { filePath, source: "websearch", needsConfirmation, webSearchUrl: result.url };
          }
        }

        // For non-PDF URLs with high similarity, try fetching — might redirect to PDF
        if (!isPdfUrl && sim >= 0.85) {
          const buffer = await tryDownloadPdf(result.url);
          if (buffer) {
            const filePath = await savePdfBuffer(buffer, "websearch");
            console.log(`[pdf-finder] Web search found PDF via redirect (similarity=${sim.toFixed(2)}): ${result.url}`);
            return { filePath, source: "websearch", webSearchUrl: result.url };
          }
        }
      }
    }
  } catch (err) {
    console.warn("[pdf-finder] Web search fallback failed:", (err as Error).message);
  }
  return null;
}
