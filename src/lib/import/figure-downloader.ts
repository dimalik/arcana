/**
 * Download figures from arXiv HTML views and publisher pages.
 * Stores them as PaperFigure records (sourceMethod="html_download").
 *
 * This is cheaper and higher quality than PDF-based figure extraction
 * since publisher/arXiv HTML pages serve figures as separate image files.
 */

import { prisma } from "@/lib/prisma";
import { writeFile, mkdir } from "fs/promises";
import path from "path";

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,*/*",
};

interface FigureCandidate {
  url: string;
  caption: string;
  type: "figure" | "table" | "diagram";
}

/**
 * Download figures from arXiv HTML or publisher pages for a paper.
 * Returns count of figures downloaded.
 */
export async function downloadFiguresFromHtml(
  paperId: string,
  opts: { arxivId?: string | null; doi?: string | null }
): Promise<{ downloaded: number }> {
  const figures: FigureCandidate[] = [];

  // Try arXiv HTML first (most reliable, always available for recent papers)
  if (opts.arxivId) {
    const arxivFigs = await extractArxivFigures(opts.arxivId);
    figures.push(...arxivFigs);
  }

  // Try publisher page if no arXiv figures found
  if (figures.length === 0 && opts.doi) {
    const pubFigs = await extractPublisherFigures(opts.doi);
    figures.push(...pubFigs);
  }

  if (figures.length === 0) return { downloaded: 0 };

  // Download and store figures
  const figDir = path.join(process.cwd(), "uploads", "figures", paperId);
  await mkdir(figDir, { recursive: true });

  let downloaded = 0;
  for (let i = 0; i < figures.length; i++) {
    const fig = figures[i];
    try {
      const imgRes = await fetch(fig.url, {
        headers: { ...BROWSER_HEADERS, Accept: "image/*,*/*" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!imgRes.ok) continue;

      const contentType = imgRes.headers.get("content-type") || "";
      if (!contentType.startsWith("image/") && !contentType.includes("svg")) continue;

      const buffer = Buffer.from(await imgRes.arrayBuffer());
      if (buffer.length < 500) continue; // Skip tiny images (tracking pixels, etc.)
      if (buffer.length > 15_000_000) continue; // Skip >15MB images

      const ext = contentType.includes("svg") ? "svg"
        : contentType.includes("png") ? "png"
        : contentType.includes("gif") ? "gif"
        : contentType.includes("webp") ? "webp"
        : "jpg";
      const filename = `html-${i}.${ext}`;
      const fullPath = path.join(figDir, filename);
      await writeFile(fullPath, buffer);

      const imagePath = `uploads/figures/${paperId}/${filename}`;

      // Upsert PaperFigure (sourceMethod=html_download for HTML source)
      await prisma.paperFigure.upsert({
        where: {
          paperId_sourceMethod_figureLabel: { paperId, sourceMethod: "html_download", figureLabel: `html-fig-${i}` },
        },
        create: {
          paperId,
          sourceMethod: "html_download",
          sourceUrl: fig.url,
          figureLabel: `html-fig-${i}`,
          figureIndex: i,
          type: fig.type,
          captionText: fig.caption || null,
          captionSource: fig.caption ? "html" : "none",
          imagePath,
        },
        update: {
          type: fig.type,
          captionText: fig.caption || null,
          imagePath,
        },
      });

      downloaded++;
    } catch {
      // Skip individual figure failures
    }
  }

  if (downloaded > 0) {
    console.log(`[figure-downloader] Downloaded ${downloaded}/${figures.length} figures for paper ${paperId}`);
  }
  return { downloaded };
}

// ── ArXiv HTML figures ──────────────────────────────────────────────

async function extractArxivFigures(arxivId: string): Promise<FigureCandidate[]> {
  try {
    const url = `https://arxiv.org/html/${arxivId}`;
    const res = await fetch(url, {
      headers: BROWSER_HEADERS,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return [];

    const html = await res.text();
    const baseUrl = res.url; // Follow redirects

    return extractFiguresFromHtml(html, baseUrl);
  } catch {
    return [];
  }
}

// ── Publisher page figures ───────────────────────────────────────────

async function extractPublisherFigures(doi: string): Promise<FigureCandidate[]> {
  try {
    const doiUrl = `https://doi.org/${doi}`;
    const res = await fetch(doiUrl, {
      headers: BROWSER_HEADERS,
      redirect: "follow",
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return [];

    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("html")) return [];

    const html = await res.text();
    // Skip Cloudflare challenge pages
    if (html.includes("Just a moment...") || html.includes("cf-browser-verification")) return [];

    return extractFiguresFromHtml(html, res.url);
  } catch {
    return [];
  }
}

// ── HTML figure extraction ──────────────────────────────────────────

const SKIP_PATTERNS = /logo|icon|banner|avatar|header|footer|social|tracking|pixel|badge|button|arrow|spinner|loading|captcha|widget/i;

function extractFiguresFromHtml(html: string, baseUrl: string): FigureCandidate[] {
  const figures: FigureCandidate[] = [];
  const seenUrls = new Set<string>();

  // Strategy 1: <figure> elements with <img> and optional <figcaption>
  const figureBlockRegex = /<figure[^>]*>([\s\S]*?)<\/figure>/gi;
  let match: RegExpExecArray | null;
  while ((match = figureBlockRegex.exec(html)) !== null) {
    const block = match[1];

    // Extract img src
    const imgMatch = block.match(/<img[^>]+src=["']([^"']+)["']/i);
    if (!imgMatch) continue;

    const imgSrc = imgMatch[1];
    if (SKIP_PATTERNS.test(imgSrc)) continue;

    let resolvedUrl: string;
    try {
      resolvedUrl = new URL(imgSrc, baseUrl).href;
    } catch { continue; }

    if (seenUrls.has(resolvedUrl)) continue;
    seenUrls.add(resolvedUrl);

    // Extract caption from <figcaption>
    const captionMatch = block.match(/<figcaption[^>]*>([\s\S]*?)<\/figcaption>/i);
    const caption = captionMatch
      ? captionMatch[1].replace(/<[^>]+>/g, "").trim().slice(0, 500)
      : "";

    // Determine type from caption text
    const type = /^table\s/i.test(caption) ? "table" as const
      : /diagram|flowchart|architecture/i.test(caption) ? "diagram" as const
      : "figure" as const;

    figures.push({ url: resolvedUrl, caption, type });
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
        resolvedUrl = new URL(src, baseUrl).href;
      } catch { continue; }

      if (seenUrls.has(resolvedUrl)) continue;
      seenUrls.add(resolvedUrl);

      figures.push({ url: resolvedUrl, caption: alt.slice(0, 500), type: "figure" });
    }
  }

  return figures;
}
