/**
 * Multi-source open-access PDF finder.
 *
 * Tries sources in priority order:
 *   1. Provided URL (from OpenAlex/S2 during discovery)
 *   2. Unpaywall (best OA coverage, free with email)
 *   3. Semantic Scholar openAccessPdf
 *   4. Europe PMC (biomedical papers)
 *
 * Returns the downloaded PDF buffer or null.
 */

import { fetchWithRetry } from "./semantic-scholar";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { v4 as uuidv4 } from "uuid";

const UNPAYWALL_EMAIL =
  process.env.CROSSREF_MAILTO || "paperfinder@localhost";

export interface PdfDownloadResult {
  filePath: string; // relative path like "uploads/doi-abc123.pdf"
  source: string; // which source provided the PDF
}

/**
 * Try to find and download an open-access PDF from multiple sources.
 * Saves the PDF to uploads/ and returns the relative path.
 */
export async function findAndDownloadPdf(opts: {
  doi?: string | null;
  arxivId?: string | null;
  existingPdfUrl?: string | null;
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

  // 1. Existing URL (already known from discovery/OpenAlex)
  if (opts.existingPdfUrl) {
    add(opts.existingPdfUrl, "existing");
  }

  // 2. ArXiv direct (always works for arXiv papers)
  if (opts.arxivId) {
    add(`https://arxiv.org/pdf/${opts.arxivId}.pdf`, "arxiv");
  }

  // 3-5. API lookups (run in parallel for speed)
  if (opts.doi) {
    const [unpaywall, s2, pmc] = await Promise.all([
      fetchUnpaywallPdfUrl(opts.doi),
      fetchS2PdfUrl(opts.doi),
      fetchEuropePmcPdfUrl(opts.doi),
    ]);

    if (unpaywall) add(unpaywall, "unpaywall");
    if (s2) add(s2, "semantic-scholar");
    if (pmc) add(pmc, "europepmc");
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
  const headers = process.env.S2_API_KEY
    ? { "x-api-key": process.env.S2_API_KEY }
    : undefined;
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

async function fetchEuropePmcPdfUrl(doi: string): Promise<string | null> {
  const url = `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=DOI:${encodeURIComponent(doi)}&format=json&resultType=core&pageSize=1`;
  const res = await fetchWithRetry(url, "europepmc", 200);
  if (!res) return null;

  try {
    const data = await res.json();
    const result = data.resultList?.result?.[0];
    if (!result) return null;

    // Look for PDF in fullTextUrlList
    const urls = result.fullTextUrlList?.fullTextUrl;
    if (Array.isArray(urls)) {
      const pdf = urls.find(
        (u: { documentStyle?: string }) => u.documentStyle === "pdf"
      );
      if (pdf?.url) return pdf.url;
    }

    // Fall back to PMC PDF URL if available
    if (result.pmcid) {
      return `https://europepmc.org/backend/ptpmcrender.fcgi?accid=${result.pmcid}&blobtype=pdf`;
    }

    return null;
  } catch {
    return null;
  }
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
