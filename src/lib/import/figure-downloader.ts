/**
 * Download figures from arXiv HTML views and publisher pages.
 *
 * Uses provenance-aware source methods:
 *   - "arxiv_html"     — from arxiv.org/html/{id}, confidence: high
 *   - "publisher_html"  — from publisher DOI landing page, confidence: medium
 *
 * Each figure gets: figureLabel (parsed from caption), assetHash (SHA-256),
 * captionSource ("html_figcaption"), confidence, sourceUrl.
 */

import { writeFile, mkdir } from "fs/promises";
import { createHash } from "crypto";
import path from "path";

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,*/*",
};

interface FigureCandidate {
  url: string;
  caption: string;
  figureLabel: string | null;
  type: "figure" | "table";
  /** For table <figure> blocks: the raw HTML of the <table> element. */
  tableHtml?: string;
}

/** Parse "Figure 3", "Table 1", "Fig. 2a" etc from the start of a caption. */
function parseFigureLabel(caption: string): string | null {
  const m = caption.match(/^((?:Figure|Fig\.?|Table)\s+\d+[a-z]?)/i);
  return m ? m[1] : null;
}

export interface HtmlFigureRecord {
  figureLabel: string;
  captionText: string | null;
  captionSource: string;
  sourceMethod: string;
  sourceUrl: string;
  confidence: string;
  imagePath: string | null;
  assetHash: string | null;
  type: "figure" | "table";
  /** For HTML tables: the structured table HTML content. */
  tableHtml?: string;
}

export interface FigureDownloadResult {
  downloaded: number;
  source: "arxiv_html" | "publisher_html" | null;
  sourceUrl: string | null;
  /** Figures written in THIS run — use for merge input, not DB reads. */
  figures: HtmlFigureRecord[];
}

/**
 * Download figures from arXiv HTML or publisher pages for a paper.
 * Returns count of figures downloaded and which source was used.
 */
export async function downloadFiguresFromHtml(
  paperId: string,
  opts: { arxivId?: string | null; doi?: string | null }
): Promise<FigureDownloadResult> {
  let figures: FigureCandidate[] = [];
  let source: "arxiv_html" | "publisher_html" | null = null;
  let sourcePageUrl: string | null = null;

  // Try arXiv HTML first (most reliable, always available for recent papers)
  if (opts.arxivId) {
    const result = await extractArxivFigures(opts.arxivId);
    if (result.figures.length > 0) {
      figures = result.figures;
      source = "arxiv_html";
      sourcePageUrl = result.pageUrl;
    }
  }

  // Try publisher page if no arXiv figures found
  if (figures.length === 0 && opts.doi) {
    const result = await extractPublisherFigures(opts.doi);
    if (result.figures.length > 0) {
      figures = result.figures;
      source = "publisher_html";
      sourcePageUrl = result.pageUrl;
    }
  }

  if (figures.length === 0 || !source) return { downloaded: 0, source: null, sourceUrl: null, figures: [] };

  const confidence = source === "arxiv_html" ? "high" : "medium";

  // Download and store figures
  const figDir = path.join(process.cwd(), "uploads", "figures", paperId);
  await mkdir(figDir, { recursive: true });

  // Download images to disk. No DB writes — the orchestrator's transaction
  // handles all PaperFigure persistence.
  let downloaded = 0;
  const written: HtmlFigureRecord[] = [];
  for (let i = 0; i < figures.length; i++) {
    const fig = figures[i];

    // Table figures from HTML: no image to download, store structured content
    if (fig.tableHtml && !fig.url) {
      const figureLabel = fig.figureLabel || `html-table-${i}`;
      written.push({
        figureLabel,
        captionText: fig.caption || null,
        captionSource: fig.caption ? "html_figcaption" : "none",
        sourceMethod: source,
        sourceUrl: "",
        confidence,
        imagePath: null,
        assetHash: null,
        type: "table",
        tableHtml: fig.tableHtml,
      });
      downloaded++;
      continue;
    }

    try {
      const imgRes = await fetch(fig.url, {
        headers: { ...BROWSER_HEADERS, Accept: "image/*,*/*" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!imgRes.ok) continue;

      const contentType = imgRes.headers.get("content-type") || "";
      if (!contentType.startsWith("image/") && !contentType.includes("svg")) continue;

      const buffer = Buffer.from(await imgRes.arrayBuffer());
      if (buffer.length < 500) continue;
      if (buffer.length > 15_000_000) continue;

      // Quality gate: reject assets that are likely child elements, not figures.
      // Probe image dimensions from buffer header.
      let imgWidth = 0;
      let imgHeight = 0;
      try {
        if (buffer[0] === 0x89 && buffer[1] === 0x50) { // PNG
          imgWidth = buffer.readUInt32BE(16);
          imgHeight = buffer.readUInt32BE(20);
        } else if (buffer[0] === 0xFF && buffer[1] === 0xD8) { // JPEG
          // Scan for SOF marker
          let off = 2;
          while (off < buffer.length - 8) {
            if (buffer[off] === 0xFF && (buffer[off + 1] >= 0xC0 && buffer[off + 1] <= 0xCF) && buffer[off + 1] !== 0xC4 && buffer[off + 1] !== 0xC8) {
              imgHeight = buffer.readUInt16BE(off + 5);
              imgWidth = buffer.readUInt16BE(off + 7);
              break;
            }
            off += 2 + buffer.readUInt16BE(off + 2);
          }
        }
      } catch { /* skip dimension check */ }

      // Reject clearly bad assets
      if (imgWidth > 0 && imgHeight > 0) {
        const aspect = imgWidth / imgHeight;
        const isTiny = imgWidth < 100 || imgHeight < 50;
        const isExtreme = aspect > 15 || aspect < 0.05; // legend strips, thin bars
        if (isTiny || isExtreme) continue;
      }

      // Demote unlabeled assets — they're likely child elements, not figures
      const figureLabel = fig.figureLabel || `html-fig-${i}`;
      const hasLabel = !!fig.figureLabel;
      const figConfidence = hasLabel ? confidence : "low";

      const assetHash = createHash("sha256").update(buffer).digest("hex");

      const ext = contentType.includes("svg") ? "svg"
        : contentType.includes("png") ? "png"
        : contentType.includes("gif") ? "gif"
        : contentType.includes("webp") ? "webp"
        : "jpg";
      const filename = `html-${i}.${ext}`;
      const fullPath = path.join(figDir, filename);
      await writeFile(fullPath, buffer);

      const imagePath = `uploads/figures/${paperId}/${filename}`;

      written.push({
        figureLabel,
        captionText: fig.caption || null,
        captionSource: fig.caption ? "html_figcaption" : "none",
        sourceMethod: source,
        sourceUrl: fig.url,
        confidence: figConfidence,
        imagePath,
        assetHash,
        type: fig.type,
      });
      downloaded++;
    } catch {
      // Skip individual figure failures
    }
  }

  if (downloaded > 0) {
    console.log(`[figure-downloader] ${source}: ${downloaded}/${figures.length} figures for paper ${paperId}`);
  }
  return { downloaded, source, sourceUrl: sourcePageUrl, figures: written };
}

// ── ArXiv HTML figures ──────────────────────────────────────────────

interface HtmlExtractionResult {
  figures: FigureCandidate[];
  pageUrl: string | null;
}

async function extractArxivFigures(arxivId: string): Promise<HtmlExtractionResult> {
  try {
    const url = `https://arxiv.org/html/${arxivId}`;
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { figures: [], pageUrl: null };

    const html = await res.text();
    const baseUrl = res.url;

    return { figures: extractFiguresFromHtml(html, baseUrl), pageUrl: baseUrl };
  } catch {
    return { figures: [], pageUrl: null };
  }
}

// ── Publisher page figures ───────────────────────────────────────────

async function extractPublisherFigures(doi: string): Promise<HtmlExtractionResult> {
  try {
    const doiUrl = `https://doi.org/${doi}`;
    const res = await fetch(doiUrl, {
      headers: BROWSER_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return { figures: [], pageUrl: null };

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("html")) return { figures: [], pageUrl: null };

    const html = await res.text();
    if (html.includes("Just a moment...") || html.includes("cf-browser-verification")) {
      return { figures: [], pageUrl: null };
    }

    return { figures: extractFiguresFromHtml(html, res.url), pageUrl: res.url };
  } catch {
    return { figures: [], pageUrl: null };
  }
}

// ── HTML figure extraction ──────────────────────────────────────────

const SKIP_PATTERNS = /logo|icon|banner|avatar|header|footer|social|tracking|pixel|badge|button|arrow|spinner|loading|captcha|widget/i;

export function extractFiguresFromHtml(html: string, baseUrl: string): FigureCandidate[] {
  const figures: FigureCandidate[] = [];
  const seenUrls = new Set<string>();

  // Respect <base href="..."> if present (arXiv HTML uses this for relative image paths)
  const baseTag = html.match(/<base[^>]+href=["']([^"']+)["']/i);
  const effectiveBase = baseTag ? new URL(baseTag[1], baseUrl).href : baseUrl;

  // Strategy 1: <figure> elements — handles both <img> figures and <table> figures
  const figureBlockRegex = /<figure[^>]*>([\s\S]*?)<\/figure>/gi;
  let match: RegExpExecArray | null;
  while ((match = figureBlockRegex.exec(html)) !== null) {
    const block = match[1];

    // Extract caption
    const captionMatch = block.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i);
    const caption = captionMatch
      ? captionMatch[1].replace(/<[^>]+>/g, "").trim().slice(0, 500)
      : "";
    const figureLabel = parseFigureLabel(caption);

    // Check for table content inside the figure block.
    // arXiv HTML uses two patterns:
    //   1. Standard <table> elements (most papers)
    //   2. LaTeXML <span class="ltx_tabular ..."> nested spans (some papers)
    const hasImg = /<img[^>]+src=/i.test(block);
    const stdTableMatch = block.match(/<table[^>]*>[\s\S]*?<\/table>/i);

    if (stdTableMatch && !hasImg) {
      figures.push({ url: "", caption, figureLabel, type: "table", tableHtml: stdTableMatch[0] });
      continue;
    }

    // ltx_tabular: deeply nested spans, can't regex-match the closing tag.
    // Pragmatic: strip figcaption and use remaining block as table content.
    // May include LaTeXML scaffolding — acceptable for tranche 1.
    if (!hasImg && /class="[^"]*ltx_tabular/.test(block)) {
      const tableHtml = block.replace(/<figcaption[^>]*>[\s\S]*?<\/figcaption>/gi, "").trim();
      if (tableHtml.length > 50) {
        figures.push({ url: "", caption, figureLabel, type: "table", tableHtml });
        continue;
      }
    }

    // Extract img src
    const imgMatch = block.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (!imgMatch) continue;

    const imgSrc = imgMatch[1];
    if (SKIP_PATTERNS.test(imgSrc)) continue;

    let resolvedUrl: string;
    try {
      resolvedUrl = new URL(imgSrc, effectiveBase).href;
    } catch { continue; }

    if (seenUrls.has(resolvedUrl)) continue;
    seenUrls.add(resolvedUrl);

    const type = /^table\s/i.test(caption) ? "table" as const : "figure" as const;

    figures.push({ url: resolvedUrl, caption, figureLabel, type });
  }

  // Strategy 2: Standalone <img> tags with figure-like attributes (if no <figure> blocks found)
  if (figures.length === 0) {
    const imgRegex = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
    while ((match = imgRegex.exec(html)) !== null) {
      const fullTag = match[0];
      const src = match[1];

      if (SKIP_PATTERNS.test(src)) continue;
      if (SKIP_PATTERNS.test(fullTag)) continue;

      // Require some signal that this is a content image
      const alt = fullTag.match(/alt=["']([^"']*?)["']/i)?.[1] || "";
      const isFigure = /fig|figure|table|chart|plot|graph|diagram|result/i.test(src + alt);
      // Also accept large images (width > 200)
      const widthMatch = fullTag.match(/width=["']?(\d+)/i);
      const isLarge = widthMatch && parseInt(widthMatch[1]) > 200;

      if (!isFigure && !isLarge) continue;

      let resolvedUrl: string;
      try {
        resolvedUrl = new URL(src, effectiveBase).href;
      } catch { continue; }

      if (seenUrls.has(resolvedUrl)) continue;
      seenUrls.add(resolvedUrl);

      figures.push({ url: resolvedUrl, caption: alt.slice(0, 500), figureLabel: parseFigureLabel(alt), type: "figure" });
    }
  }

  return figures;
}
