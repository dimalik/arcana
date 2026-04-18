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
import { JSDOM } from "jsdom";

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
  /** For inline/vector figure assets embedded directly in the HTML block. */
  inlineImageData?: string;
  inlineImageMimeType?: string;
  sourceUrl?: string | null;
}

interface FigureAssetCandidate {
  url: string;
  inlineImageData?: string;
  inlineImageMimeType?: string;
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
  qualityStatus: "trusted" | "downgraded" | "suppressed" | "no_candidates";
  reasonCode: string | null;
  rawCandidateCount: number;
  keptCandidateCount: number;
  suppressedCandidateCount: number;
  /** Figures written in THIS run — use for merge input, not DB reads. */
  figures: HtmlFigureRecord[];
}

export interface HtmlTrustDecision {
  figures: FigureCandidate[];
  qualityStatus: "trusted" | "downgraded" | "suppressed" | "no_candidates";
  reasonCode: string | null;
  rawCandidateCount: number;
  keptCandidateCount: number;
  suppressedCandidateCount: number;
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function getDirectChild(element: Element, tagName: string): Element | null {
  const normalized = tagName.toLowerCase();
  for (const child of Array.from(element.children)) {
    if (child.tagName.toLowerCase() === normalized) return child;
  }
  return null;
}

function resolveAssetUrl(rawUrl: string, effectiveBase: string): string | null {
  try {
    return new URL(rawUrl, effectiveBase).href;
  } catch {
    return null;
  }
}

function getCaptionText(element: Element): string {
  const captionEl = getDirectChild(element, "figcaption");
  return (captionEl?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function getElementText(element: Element | null): string {
  return (element?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 500);
}

function isUnlabeledSubfigure(
  figureId: string | null,
  figureClass: string,
  caption: string,
  figureLabel: string | null,
  isNestedFigure: boolean,
): boolean {
  if (figureLabel) return false;
  return (
    isNestedFigure
  ) || (
    !!figureId && /\.sf\d+$/i.test(figureId)
  ) || (
    /\bltx_figure_panel\b/i.test(figureClass) &&
    /^\([a-z]\)\s*/i.test(caption)
  );
}

function extractFigureAssetCandidate(
  figure: Element,
  effectiveBase: string,
): FigureAssetCandidate | null {
  const imgEl = figure.querySelector("img");
  if (imgEl) {
    const rawUrl = imgEl.getAttribute("src");
    if (rawUrl && !SKIP_PATTERNS.test(rawUrl)) {
      const resolvedUrl = resolveAssetUrl(rawUrl, effectiveBase);
      if (resolvedUrl) {
        return { url: resolvedUrl };
      }
    }
  }

  const objectEl = figure.querySelector("object[data], embed[src]");
  if (objectEl) {
    const rawUrl =
      objectEl.getAttribute("data") ||
      objectEl.getAttribute("src");
    if (rawUrl && !SKIP_PATTERNS.test(rawUrl)) {
      const resolvedUrl = resolveAssetUrl(rawUrl, effectiveBase);
      if (resolvedUrl) {
        return { url: resolvedUrl };
      }
    }
  }

  const inlineSvg = figure.querySelector("svg.ltx_picture, svg");
  if (inlineSvg) {
    return {
      url: "",
      inlineImageData: inlineSvg.outerHTML.trim(),
      inlineImageMimeType: "image/svg+xml",
    };
  }

  return null;
}

function extractTableHtmlFromElement(element: Element): string | null {
  const stdTable = element.querySelector("table");
  if (stdTable) {
    return stdTable.outerHTML;
  }

  const ltxTable = element.querySelector(".ltx_tabular");
  if (ltxTable) {
    const clone = element.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("figcaption").forEach((node) => node.remove());
    const tableHtml = clone.innerHTML.trim();
    if (tableHtml.length > 50) {
      return tableHtml;
    }
  }

  return null;
}

function extractMultiCaptionTableCandidates(
  figure: HTMLElement,
  sourceUrl: string | null,
): FigureCandidate[] {
  const directChildren = Array.from(figure.children);
  const directCaptions = directChildren.filter((child) => child.tagName.toLowerCase() === "figcaption");
  if (directCaptions.length <= 1) return [];

  const candidates: FigureCandidate[] = [];
  let pendingBlocks: Element[] = [];

  for (const child of directChildren) {
    if (child.tagName.toLowerCase() === "figcaption") {
      const caption = getElementText(child);
      const figureLabel = parseFigureLabel(caption);
      const type = /^table\s/i.test(caption) ? "table" as const : "figure" as const;

      if (type === "table" && figureLabel) {
        const tableBlock = pendingBlocks[pendingBlocks.length - 1];
        if (tableBlock) {
          const tableHtml = extractTableHtmlFromElement(tableBlock);
          if (tableHtml) {
            candidates.push({
              url: "",
              caption,
              figureLabel,
              type: "table",
              tableHtml,
              sourceUrl,
            });
          }
        }
      }

      pendingBlocks = [];
      continue;
    }

    pendingBlocks.push(child);
  }

  return candidates;
}

export function applyHtmlTrustPolicy(figures: FigureCandidate[]): HtmlTrustDecision {
  if (figures.length === 0) {
    return {
      figures: [],
      qualityStatus: "no_candidates",
      reasonCode: "no_html_candidates",
      rawCandidateCount: 0,
      keptCandidateCount: 0,
      suppressedCandidateCount: 0,
    };
  }

  const labeled = figures.filter((figure) => !!figure.figureLabel);
  const anonymous = figures.filter((figure) => !figure.figureLabel);

  if (anonymous.length === 0) {
    return {
      figures,
      qualityStatus: "trusted",
      reasonCode: null,
      rawCandidateCount: figures.length,
      keptCandidateCount: figures.length,
      suppressedCandidateCount: 0,
    };
  }

  if (labeled.length === 0) {
    return {
      figures: [],
      qualityStatus: "suppressed",
      reasonCode: "anonymous_only_html_candidates",
      rawCandidateCount: figures.length,
      keptCandidateCount: 0,
      suppressedCandidateCount: anonymous.length,
    };
  }

  return {
    figures: labeled,
    qualityStatus: "downgraded",
    reasonCode: "anonymous_html_candidates_suppressed",
    rawCandidateCount: figures.length,
    keptCandidateCount: labeled.length,
    suppressedCandidateCount: anonymous.length,
  };
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
  let trustDecision: HtmlTrustDecision = {
    figures: [],
    qualityStatus: "no_candidates",
    reasonCode: "no_html_candidates",
    rawCandidateCount: 0,
    keptCandidateCount: 0,
    suppressedCandidateCount: 0,
  };

  // Try arXiv HTML first (most reliable, always available for recent papers)
  if (opts.arxivId) {
    const result = await extractArxivFigures(opts.arxivId);
    if (result.pageUrl) {
      trustDecision = applyHtmlTrustPolicy(result.figures);
      figures = trustDecision.figures;
      source = "arxiv_html";
      sourcePageUrl = result.pageUrl;
    }
  }

  // Try publisher page if no arXiv figures found
  if ((source == null || figures.length === 0) && opts.doi) {
    const result = await extractPublisherFigures(opts.doi);
    if (result.pageUrl) {
      trustDecision = applyHtmlTrustPolicy(result.figures);
      figures = trustDecision.figures;
      source = "publisher_html";
      sourcePageUrl = result.pageUrl;
    }
  }

  if (!source) {
    return {
      downloaded: 0,
      source: null,
      sourceUrl: null,
      qualityStatus: "no_candidates",
      reasonCode: "html_source_unavailable",
      rawCandidateCount: 0,
      keptCandidateCount: 0,
      suppressedCandidateCount: 0,
      figures: [],
    };
  }

  if (figures.length === 0) {
    return {
      downloaded: 0,
      source,
      sourceUrl: sourcePageUrl,
      qualityStatus: trustDecision.qualityStatus,
      reasonCode: trustDecision.reasonCode,
      rawCandidateCount: trustDecision.rawCandidateCount,
      keptCandidateCount: 0,
      suppressedCandidateCount: trustDecision.suppressedCandidateCount,
      figures: [],
    };
  }

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
    if (fig.tableHtml && !fig.url && !fig.inlineImageData) {
      const figureLabel = fig.figureLabel || `html-table-${i}`;
      written.push({
        figureLabel,
        captionText: fig.caption || null,
        captionSource: fig.caption ? "html_figcaption" : "none",
        sourceMethod: source,
        sourceUrl: fig.sourceUrl || "",
        confidence,
        imagePath: null,
        assetHash: null,
        type: "table",
        tableHtml: fig.tableHtml,
      });
      downloaded++;
      continue;
    }

    if (!fig.url && !fig.inlineImageData) {
      const figureLabel = fig.figureLabel || `html-fig-${i}`;
      written.push({
        figureLabel,
        captionText: fig.caption || null,
        captionSource: fig.caption ? "html_figcaption" : "none",
        sourceMethod: source,
        sourceUrl: fig.sourceUrl || "",
        confidence: fig.figureLabel ? confidence : "low",
        imagePath: null,
        assetHash: null,
        type: fig.type,
      });
      downloaded++;
      continue;
    }

    if (fig.inlineImageData) {
      try {
        const figureLabel = fig.figureLabel || `html-fig-${i}`;
        const buffer = Buffer.from(fig.inlineImageData, "utf8");
        if (buffer.length < 100) continue;

        const assetHash = createHash("sha256").update(buffer).digest("hex");
        const mimeType = fig.inlineImageMimeType || "image/svg+xml";
        const ext = mimeType.includes("svg") ? "svg" : "bin";
        const filename = `html-${i}.${ext}`;
        const fullPath = path.join(figDir, filename);
        await writeFile(fullPath, buffer);

        written.push({
          figureLabel,
          captionText: fig.caption || null,
          captionSource: fig.caption ? "html_figcaption" : "none",
          sourceMethod: source,
          sourceUrl: fig.sourceUrl || "",
          confidence,
          imagePath: `uploads/figures/${paperId}/${filename}`,
          assetHash,
          type: fig.type,
        });
        downloaded++;
        continue;
      } catch {
        continue;
      }
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
        sourceUrl: fig.sourceUrl || fig.url,
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
  return {
    downloaded,
    source,
    sourceUrl: sourcePageUrl,
    qualityStatus: trustDecision.qualityStatus,
    reasonCode: trustDecision.reasonCode,
    rawCandidateCount: trustDecision.rawCandidateCount,
    keptCandidateCount: trustDecision.keptCandidateCount,
    suppressedCandidateCount: trustDecision.suppressedCandidateCount,
    figures: written,
  };
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
  const dom = new JSDOM(html, { url: baseUrl });
  const document = dom.window.document;
  const figures: FigureCandidate[] = [];
  const seenUrls = new Set<string>();

  // Respect <base href="..."> if present (arXiv HTML uses this for relative image paths)
  const effectiveBase = document.baseURI || baseUrl;

  const allFigures = Array.from(document.querySelectorAll("figure")).filter(
    (figure): figure is HTMLElement => figure instanceof document.defaultView!.HTMLElement,
  );

  for (const figure of allFigures) {
    const figureId = figure.getAttribute("id");
    const figureClass = figure.getAttribute("class") || "";
    const caption = getCaptionText(figure);
    const figureLabel = parseFigureLabel(caption);
    const type = /^table\s/i.test(caption) || /\bltx_table\b/i.test(figureClass) ? "table" as const : "figure" as const;
    const sourceUrl = figureId ? new URL(`#${figureId}`, effectiveBase).href : null;
    const isNestedFigure = !!figure.parentElement?.closest("figure");
    const descendantFigures = Array.from(figure.querySelectorAll("figure")).filter(
      (child): child is HTMLElement => child instanceof document.defaultView!.HTMLElement,
    );
    const hasNestedFigures = descendantFigures.length > 0;

    if (isUnlabeledSubfigure(figureId, figureClass, caption, figureLabel, isNestedFigure)) {
      continue;
    }

    if (type === "table") {
      const multiCaptionTables = extractMultiCaptionTableCandidates(figure, sourceUrl);
      if (multiCaptionTables.length > 0) {
        figures.push(...multiCaptionTables);
        continue;
      }
    }

    if (hasNestedFigures) {
      const descendantHasLabeledFigure = descendantFigures.some((child) => {
        const childCaption = getCaptionText(child);
        return !!parseFigureLabel(childCaption);
      });

      if (figureLabel && !descendantHasLabeledFigure) {
        const semanticOnlyKey = sourceUrl || `${effectiveBase}#semantic-${figures.length}`;
        if (seenUrls.has(semanticOnlyKey)) continue;
        seenUrls.add(semanticOnlyKey);
        const previewBridge = extractFigureAssetCandidate(figure, effectiveBase)
          ?? descendantFigures
            .map((child) => extractFigureAssetCandidate(child, effectiveBase))
            .find((asset): asset is FigureAssetCandidate => !!asset);
        figures.push({
          url: previewBridge?.url ?? "",
          caption,
          figureLabel,
          type,
          inlineImageData: previewBridge?.inlineImageData,
          inlineImageMimeType: previewBridge?.inlineImageMimeType,
          sourceUrl,
        });
      }
      continue;
    }

    if (type === "table") {
      const stdTable = figure.querySelector("table");
      if (stdTable) {
        figures.push({
          url: "",
          caption,
          figureLabel,
          type: "table",
          tableHtml: stdTable.outerHTML,
          sourceUrl,
        });
        continue;
      }

      const tableHtml = extractTableHtmlFromElement(figure);
      if (tableHtml) {
        figures.push({
          url: "",
          caption,
          figureLabel,
          type: "table",
          tableHtml,
          sourceUrl,
        });
        continue;
      }
    }

    const assetCandidate = extractFigureAssetCandidate(figure, effectiveBase);
    const looksLikeFigureContainer =
      /\bltx_figure\b/i.test(figureClass) ||
      /^fig(?:ure)?\s/i.test(caption);
    if (assetCandidate?.url && !seenUrls.has(assetCandidate.url)) {
      seenUrls.add(assetCandidate.url);
      figures.push({
        url: assetCandidate.url,
        caption,
        figureLabel,
        type,
        sourceUrl: sourceUrl || assetCandidate.url,
      });
      continue;
    }

    if (assetCandidate?.inlineImageData && looksLikeFigureContainer) {
      const syntheticUrl = sourceUrl || `${effectiveBase}#inline-svg-${figures.length}`;
      if (seenUrls.has(syntheticUrl)) continue;
      seenUrls.add(syntheticUrl);
      figures.push({
        url: "",
        caption,
        figureLabel,
        type: "figure",
        inlineImageData: assetCandidate.inlineImageData,
        inlineImageMimeType: assetCandidate.inlineImageMimeType ?? "image/svg+xml",
        sourceUrl: syntheticUrl,
      });
    }
  }

  // Strategy 2: Standalone <img> tags with figure-like attributes (if no <figure> blocks found)
  if (figures.length === 0) {
    for (const img of Array.from(document.querySelectorAll("img"))) {
      const src = img.getAttribute("src");
      if (!src || SKIP_PATTERNS.test(src)) continue;
      const fullTag = img.outerHTML;
      if (SKIP_PATTERNS.test(fullTag)) continue;

      const alt = img.getAttribute("alt") || "";
      const isFigure = /fig|figure|table|chart|plot|graph|diagram|result/i.test(src + alt);
      const widthValue = img.getAttribute("width");
      const isLarge = widthValue ? parseInt(widthValue, 10) > 200 : false;

      if (!isFigure && !isLarge) continue;

      const resolvedUrl = resolveAssetUrl(src, effectiveBase);
      if (!resolvedUrl || seenUrls.has(resolvedUrl)) continue;
      seenUrls.add(resolvedUrl);

      figures.push({
        url: resolvedUrl,
        caption: alt.slice(0, 500),
        figureLabel: parseFigureLabel(alt),
        type: "figure",
      });
    }
  }

  return figures;
}
