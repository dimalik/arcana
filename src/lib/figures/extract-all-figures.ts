/**
 * Unified figure extraction orchestrator.
 *
 * Runs all applicable extraction sources for a paper based on its identity
 * (DOI → PMC/JATS + publisher, arXivId → arXiv HTML, always → PDF fallback),
 * merges results by figure identity, and reconciles the database.
 *
 * IMPORTANT: merge input comes from extractor return values, NOT DB reads.
 * This ensures reruns are idempotent — stale rows from prior runs never
 * leak into the merge input.
 */

import { prisma } from "@/lib/prisma";
import { writeFile, mkdir } from "fs/promises";
import { createHash } from "crypto";
import path from "path";
import { extractFiguresFromPdf } from "./pdf-figure-pipeline";
import { downloadPmcFigures } from "./pmc-jats-extractor";
import { downloadFiguresFromHtml } from "@/lib/import/figure-downloader";
import { extractWithPublisherParser } from "./publisher-parsers";
import { mergeFigureSources, type MergeableFigure } from "./source-merger";

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
  Accept: "text/html,application/xhtml+xml,*/*",
};

export interface ExtractionReport {
  paperId: string;
  sources: {
    method: string;
    attempted: boolean;
    figuresFound: number;
    error?: string;
  }[];
  totalFigures: number;
  figuresWithImages: number;
  gapPlaceholders: number;
  /** Number of merged figures that failed to persist to DB. */
  persistErrors: number;
}

/** Convert an extractor record to MergeableFigure (fills missing fields with null). */
function toMergeable(rec: {
  figureLabel?: string | null;
  captionText?: string | null;
  captionSource: string;
  sourceMethod: string;
  sourceUrl?: string | null;
  confidence: string;
  imagePath?: string | null;
  assetHash?: string | null;
  pdfPage?: number | null;
  bbox?: string | null;
  type: string;
  width?: number | null;
  height?: number | null;
  tableHtml?: string;
  description?: string | null;
  cropOutcome?: "success" | "rejected" | "failed" | null;
}): MergeableFigure {
  return {
    figureLabel: rec.figureLabel ?? null,
    captionText: rec.captionText ?? null,
    captionSource: rec.captionSource,
    sourceMethod: rec.sourceMethod,
    sourceUrl: rec.sourceUrl ?? null,
    confidence: rec.confidence,
    description: rec.tableHtml || rec.description || null,
    imagePath: rec.imagePath ?? null,
    assetHash: rec.assetHash ?? null,
    pdfPage: rec.pdfPage ?? null,
    bbox: rec.bbox ?? null,
    type: rec.type,
    width: rec.width ?? null,
    height: rec.height ?? null,
    cropOutcome: rec.cropOutcome ?? null,
  };
}

/**
 * Run all applicable extraction sources for a paper and merge results.
 */
export async function extractAllFigures(
  paperId: string,
  opts?: { maxPages?: number; skipPdf?: boolean },
): Promise<ExtractionReport> {
  const paper = await prisma.paper.findUnique({
    where: { id: paperId },
    select: {
      id: true,
      title: true,
      filePath: true,
      doi: true,
      arxivId: true,
      sourceUrl: true,
    },
  });

  if (!paper) throw new Error(`Paper ${paperId} not found`);

  const report: ExtractionReport = {
    paperId,
    sources: [],
    totalFigures: 0,
    figuresWithImages: 0,
    gapPlaceholders: 0,
    persistErrors: 0,
  };

  // allSources collects ONLY figures produced by THIS run's extractors.
  // Never read back from DB — that would re-introduce stale rows.
  const allSources: MergeableFigure[][] = [];

  // ── Source 1: PMC/JATS ────────────────────────────────────────────
  if (paper.doi) {
    try {
      const result = await downloadPmcFigures(paperId, paper.doi);
      report.sources.push({
        method: "pmc_jats",
        attempted: true,
        figuresFound: result.downloaded,
      });
      if (result.figures.length > 0) {
        allSources.push(result.figures.map(toMergeable));
      }
    } catch (err) {
      report.sources.push({
        method: "pmc_jats",
        attempted: true,
        figuresFound: 0,
        error: (err as Error).message,
      });
    }
  } else {
    report.sources.push({ method: "pmc_jats", attempted: false, figuresFound: 0 });
  }

  // ── Source 2: arXiv HTML ──────────────────────────────────────────
  if (paper.arxivId) {
    try {
      const result = await downloadFiguresFromHtml(paperId, {
        arxivId: paper.arxivId,
        doi: null,
      });
      report.sources.push({
        method: "arxiv_html",
        attempted: true,
        figuresFound: result.downloaded,
      });
      if (result.figures.length > 0) {
        allSources.push(result.figures.map(toMergeable));
      }
    } catch (err) {
      report.sources.push({
        method: "arxiv_html",
        attempted: true,
        figuresFound: 0,
        error: (err as Error).message,
      });
    }
  } else {
    report.sources.push({ method: "arxiv_html", attempted: false, figuresFound: 0 });
  }

  // ── Source 3: Publisher HTML ───────────────────────────────────────
  if (paper.doi) {
    try {
      const pubResult = await tryPublisherFigures(paperId, paper.doi);
      report.sources.push({
        method: "publisher_html",
        attempted: true,
        figuresFound: pubResult.downloaded,
      });
      if (pubResult.figures.length > 0) {
        allSources.push(pubResult.figures.map(toMergeable));
      }
    } catch (err) {
      report.sources.push({
        method: "publisher_html",
        attempted: true,
        figuresFound: 0,
        error: (err as Error).message,
      });
    }
  } else {
    report.sources.push({ method: "publisher_html", attempted: false, figuresFound: 0 });
  }

  // ── Source 4: PDF fallback ────────────────────────────────────────
  // Collect labels already covered by high-confidence sources so PDF
  // fallback can skip render+crop for those (avoids generating bad previews
  // when a real arXiv HTML or PMC figure already exists).
  const coveredLabels = new Set<string>();
  for (const srcArray of allSources) {
    for (const fig of srcArray) {
      if (fig.figureLabel && (fig.confidence === "high" || fig.confidence === "medium")) {
        coveredLabels.add(fig.figureLabel.toLowerCase().replace(/^fig\.?\s*/i, "figure ").trim());
      }
    }
  }

  if (paper.filePath && !opts?.skipPdf) {
    try {
      const pdfFigures = await extractFiguresFromPdf(
        paper.filePath,
        paperId,
        { maxPages: opts?.maxPages || 50, coveredLabels },
      );
      report.sources.push({
        method: "pdf_fallback",
        attempted: true,
        figuresFound: pdfFigures.length,
      });
      allSources.push(pdfFigures.map(f => toMergeable({
        ...f,
        sourceUrl: null,
      })));
    } catch (err) {
      report.sources.push({
        method: "pdf_fallback",
        attempted: true,
        figuresFound: 0,
        error: (err as Error).message,
      });
    }
  } else {
    report.sources.push({ method: "pdf_fallback", attempted: false, figuresFound: 0 });
  }

  // ── Merge ─────────────────────────────────────────────────────────
  const merged = mergeFigureSources(...allSources);

  // ── Persist merged rows (transactional) ─────────────────────────────
  //
  // The entire reconcile — upserts, label-drift renames, stale-row
  // demotion — runs in a single transaction. If any write fails the
  // whole batch rolls back, preventing partial mutation of the DB.
  let persistErrors = 0;
  try {
    await prisma.$transaction(async (tx) => {
      const touchedIds = new Set<string>();

      for (let i = 0; i < merged.length; i++) {
        const fig = merged[i];
        const figureLabel = fig.figureLabel
          || (fig.assetHash ? `uncaptioned-${fig.assetHash.slice(0, 12)}` : `uncaptioned-p${fig.pdfPage || 0}-${i}`);

        const fields = {
          sourceUrl: fig.sourceUrl,
          figureIndex: i,
          type: fig.type,
          captionText: fig.captionText,
          captionSource: fig.captionSource,
          confidence: fig.confidence,
          imagePath: fig.imagePath,
          assetHash: fig.assetHash,
          pdfPage: fig.pdfPage,
          bbox: fig.bbox,
          width: fig.width,
          height: fig.height,
          isPrimaryExtraction: fig.isPrimaryExtraction,
          description: fig.description || null,
          gapReason: fig.gapReason || null,
          imageSourceMethod: fig.imageSourceMethod || null,
          // cropOutcome is transient — NOT persisted
        };

        // Preview preservation: if the merge emits imagePath=null for a
        // structured table, but the existing row already has a rendered
        // preview (imageSourceMethod="html_table_render"), preserve it.
        // This prevents reruns from regressing previously good previews.
        let updateFields = fields;
        if (!fig.imagePath && fig.gapReason === "structured_content_no_preview") {
          const existing = await tx.paperFigure.findFirst({
            where: { paperId, sourceMethod: fig.sourceMethod, figureLabel },
            select: { imageSourceMethod: true },
          });
          if (existing?.imageSourceMethod === "html_table_render") {
            const { imagePath: _, assetHash: _a, width: _w, height: _h,
              imageSourceMethod: _ism, gapReason: _gr, ...safeFields } = fields;
            updateFields = safeFields as typeof fields;
          }
        }

        // Label drift: same image exists under a different label.
        if (fig.assetHash) {
          const byHash = await tx.paperFigure.findFirst({
            where: { paperId, sourceMethod: fig.sourceMethod, assetHash: fig.assetHash },
            select: { id: true, figureLabel: true },
          });
          if (byHash && byHash.figureLabel !== figureLabel) {
            const blocker = await tx.paperFigure.findFirst({
              where: { paperId, sourceMethod: fig.sourceMethod, figureLabel },
              select: { id: true },
            });
            if (blocker && blocker.id !== byHash.id) {
              await tx.paperFigure.delete({ where: { id: blocker.id } });
            }
            await tx.paperFigure.update({
              where: { id: byHash.id },
              data: { figureLabel, ...updateFields },
            });
            touchedIds.add(byHash.id);
            continue;
          }
        }

        // Normal path: upsert by (paperId, sourceMethod, figureLabel)
        const row = await tx.paperFigure.upsert({
          where: {
            paperId_sourceMethod_figureLabel: {
              paperId,
              sourceMethod: fig.sourceMethod,
              figureLabel,
            },
          },
          create: {
            paperId,
            sourceMethod: fig.sourceMethod,
            figureLabel,
            ...fields,
          },
          update: updateFields,
          select: { id: true },
        });
        touchedIds.add(row.id);
      }

      // Demote all rows not touched by this run, with one exception:
      // rendered-preview rows (imageSourceMethod=html_table_render) are
      // preserved IF the current extraction still has a matching label.
      // This prevents label drift from destroying expensive previews,
      // while still demoting genuinely stale rows (tables that disappeared).
      const existingRows = await tx.paperFigure.findMany({
        where: { paperId },
        select: { id: true, imageSourceMethod: true, figureLabel: true },
      });
      const mergedLabels = new Set(
        merged.map(f => f.figureLabel || "").filter(Boolean).map(l => l.toLowerCase()),
      );
      const staleIds = existingRows
        .filter(row => {
          if (touchedIds.has(row.id)) return false; // touched this run
          if (row.imageSourceMethod === "html_table_render" && row.figureLabel) {
            // Preserve if the current extraction still has this table
            return !mergedLabels.has(row.figureLabel.toLowerCase());
          }
          return true; // demote everything else
        })
        .map(row => row.id);
      if (staleIds.length > 0) {
        await tx.paperFigure.updateMany({
          where: { id: { in: staleIds } },
          data: { isPrimaryExtraction: false },
        });
        console.log(`[extract-all] Demoted ${staleIds.length} stale rows for paper ${paperId}`);
      }
    });
  } catch (err) {
    // Transaction rolled back — DB unchanged from pre-merge state.
    // Use Math.max(1, ...) so a failure during stale-row reconciliation
    // with zero merged figures still reports as a persist error.
    persistErrors = Math.max(1, merged.length);
    console.error(`[extract-all] Persist transaction failed, rolled back:`, (err as Error).message);
  }

  report.persistErrors = persistErrors;

  // ── Post-pass: render HTML table previews (best-effort, non-transactional) ──
  if (persistErrors === 0) {
    try {
      const { renderTablePreviews } = await import("./html-table-preview-renderer");
      const previewResult = await renderTablePreviews(paperId);
      if (previewResult.rendered > 0) {
        console.log(`[extract-all] Rendered ${previewResult.rendered} table previews for ${paperId}`);
      }
    } catch (err) {
      console.warn(`[extract-all] Table preview rendering skipped: ${(err as Error).message}`);
    }
  }

  // ── Compute report from actual DB state ──────────────────────────────
  // Accounts for preserved previews from prior runs and newly rendered ones,
  // not just what the merge output thought would happen.
  if (persistErrors === 0) {
    const dbCanonical = await prisma.paperFigure.findMany({
      where: { paperId, isPrimaryExtraction: true },
      select: { imagePath: true },
    });
    report.totalFigures = dbCanonical.length;
    report.figuresWithImages = dbCanonical.filter(f => f.imagePath).length;
    report.gapPlaceholders = dbCanonical.filter(f => !f.imagePath).length;
  } else {
    const canonical = merged.filter(f => f.isPrimaryExtraction);
    report.totalFigures = canonical.length;
    report.figuresWithImages = canonical.filter(f => f.imagePath).length;
    report.gapPlaceholders = canonical.filter(f => !f.imagePath).length;
  }

  const summary =
    `[extract-all] ${paper.title}: ${report.totalFigures} figures ` +
    `(${report.figuresWithImages} with images, ${report.gapPlaceholders} gaps` +
    `${persistErrors > 0 ? `, ${persistErrors} persist errors` : ""})` +
    ` from ${report.sources.filter(s => s.attempted && s.figuresFound > 0).map(s => s.method).join(", ") || "none"}`;
  if (persistErrors > 0) {
    console.warn(summary);
  } else {
    console.log(summary);
  }

  return report;
}

// ── Publisher HTML helper ────────────────────────────────────────────

interface PublisherFigureRecord {
  figureLabel: string;
  captionText: string | null;
  captionSource: string;
  sourceMethod: string;
  sourceUrl: string;
  confidence: string;
  imagePath: string;
  assetHash: string;
  type: string;
}

async function tryPublisherFigures(
  paperId: string,
  doi: string,
): Promise<{ downloaded: number; figures: PublisherFigureRecord[] }> {
  const empty = { downloaded: 0, figures: [] as PublisherFigureRecord[] };

  const doiUrl = `https://doi.org/${doi}`;
  const res = await fetch(doiUrl, {
    headers: BROWSER_HEADERS,
    redirect: "follow",
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return empty;

  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("html")) return empty;

  const html = await res.text();
  if (html.includes("Just a moment...") || html.includes("cf-browser-verification")) {
    return empty;
  }

  const pubResult = extractWithPublisherParser(html, res.url);
  if (!pubResult || pubResult.figures.length === 0) return empty;

  const figDir = path.join(process.cwd(), "uploads", "figures", paperId);
  await mkdir(figDir, { recursive: true });

  const written: PublisherFigureRecord[] = [];
  for (let i = 0; i < pubResult.figures.length; i++) {
    const fig = pubResult.figures[i];
    try {
      const imgRes = await fetch(fig.imgUrl, {
        headers: { ...BROWSER_HEADERS, Accept: "image/*,*/*" },
        signal: AbortSignal.timeout(30_000),
      });
      if (!imgRes.ok) continue;

      const ct = imgRes.headers.get("content-type") || "";
      if (!ct.startsWith("image/") && !ct.includes("svg")) continue;

      const buffer = Buffer.from(await imgRes.arrayBuffer());
      if (buffer.length < 500 || buffer.length > 15_000_000) continue;

      const assetHash = createHash("sha256").update(buffer).digest("hex");
      const ext = ct.includes("png") ? "png"
        : ct.includes("svg") ? "svg"
        : ct.includes("gif") ? "gif"
        : ct.includes("webp") ? "webp"
        : "jpg";
      const filename = `pub-${i}.${ext}`;
      await writeFile(path.join(figDir, filename), buffer);

      const imagePath = `uploads/figures/${paperId}/${filename}`;
      const figureLabel = fig.figureLabel || `pub-fig-${i}`;

      // No DB write — the orchestrator's transaction handles all persistence.
      written.push({
        figureLabel,
        captionText: fig.caption || null,
        captionSource: fig.caption ? "html_figcaption" : "none",
        sourceMethod: "publisher_html",
        sourceUrl: fig.imgUrl,
        confidence: "medium",
        imagePath,
        assetHash,
        type: fig.type,
      });
    } catch {
      // Skip individual figure failures
    }
  }

  return { downloaded: written.length, figures: written };
}
