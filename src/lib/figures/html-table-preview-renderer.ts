/**
 * Render structured HTML tables to PNG preview images via Playwright.
 *
 * This is a post-extraction enrichment step, not part of the transactional
 * extraction pipeline. It runs after the merge transaction commits and
 * updates canonical table rows that have structured HTML but no preview.
 *
 * imageSourceMethod is set to "html_table_render" on success.
 */

import { chromium, type Browser } from "playwright";
import { writeFile, mkdir } from "fs/promises";
import { createHash } from "crypto";
import path from "path";

import {
  createRenderedPreview,
  createEnrichmentPreviewSelectionRun,
  publishPreviewSelectionRun,
  upsertRenderedPreviewAsset,
} from "./projection-publication";
import {
  acquirePaperWorkLease,
  releasePaperWorkLease,
} from "./publication-guards";

const HTML_TABLE_RENDERER_VERSION = "html-table-renderer-v1";
const HTML_TABLE_RENDER_TEMPLATE_VERSION = "html-table-css-v1";

const TABLE_CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
    line-height: 1.4;
    padding: 16px;
    background: white;
    color: #1a1a1a;
  }
  table, .ltx_tabular {
    border-collapse: collapse;
    width: auto;
    max-width: 100%;
  }
  td, th, .ltx_td, .ltx_th {
    padding: 4px 10px;
    border: 1px solid #d0d0d0;
    text-align: center;
    vertical-align: middle;
    font-size: 12px;
  }
  th, .ltx_th, .ltx_border_tt .ltx_td:first-child {
    background: #f5f5f5;
    font-weight: 600;
  }
  /* LaTeXML span-based table rendering */
  .ltx_tabular { display: table; }
  .ltx_tr { display: table-row; }
  .ltx_td, .ltx_th { display: table-cell; }
  .ltx_thead { display: table-header-group; }
  .ltx_tbody { display: table-row-group; }
  .ltx_border_tt { border-top: 2px solid #333; }
  .ltx_border_t { border-top: 1px solid #999; }
  .ltx_border_bb { border-bottom: 2px solid #333; }
  .ltx_border_b { border-bottom: 1px solid #999; }
  .ltx_align_left { text-align: left; }
  .ltx_align_center { text-align: center; }
  .ltx_align_right { text-align: right; }
  .ltx_font_bold { font-weight: 700; }
  .ltx_font_italic { font-style: italic; }
  /* Hide LaTeX math annotation noise */
  annotation, .ltx_role_display { display: none; }
  /* Transformed containers — undo scaling */
  .ltx_transformed_outer, .ltx_transformed_inner {
    transform: none !important;
    width: auto !important;
    height: auto !important;
    vertical-align: baseline !important;
  }
  .ltx_inline-block { display: inline-block; width: auto !important; }
`;

function buildHtml(tableContent: string): string {
  return `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<style>${TABLE_CSS}</style>
</head><body>
<div id="table-container">${tableContent}</div>
</body></html>`;
}

interface RenderResult {
  success: boolean;
  imagePath?: string;
  assetHash?: string;
  width?: number;
  height?: number;
  byteSize?: number;
  error?: string;
}

/**
 * Render a single table's HTML to a PNG screenshot.
 */
async function renderTableHtml(
  browser: Browser,
  tableHtml: string,
  outPath: string,
): Promise<RenderResult> {
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  try {
    const html = buildHtml(tableHtml);
    await page.setContent(html, { waitUntil: "load" });

    // Screenshot just the table container
    const container = page.locator("#table-container");
    const box = await container.boundingBox();
    if (!box || box.width < 10 || box.height < 10) {
      return { success: false, error: "table container too small or not rendered" };
    }

    const buffer = await container.screenshot({ type: "png" });
    await writeFile(outPath, buffer);

    const assetHash = createHash("sha256").update(buffer).digest("hex");
    return {
      success: true,
      imagePath: outPath,
      assetHash,
      width: Math.round(box.width),
      height: Math.round(box.height),
      byteSize: buffer.length,
    };
  } catch (err) {
    return { success: false, error: (err as Error).message };
  } finally {
    await page.close();
  }
}

export interface TablePreviewResult {
  rendered: number;
  failed: number;
  skipped: number;
}

/**
 * Post-pass: render previews for active structured tables with no selected preview.
 *
 * Queries the active preview-selection snapshot for rows matching:
 *   selectedPreviewSource=none, type=table,
 *   gapReason=structured_content_no_preview, structuredContent.length > 100
 *
 * On success: writes rendered preview assets and publishes a new enrichment
 * preview-selection snapshot for the active projection.
 */
export async function renderTablePreviews(
  paperId: string,
): Promise<TablePreviewResult> {
  const { prisma } = await import("@/lib/prisma");

  const publicationState = await prisma.paperPublicationState.findUnique({
    where: { paperId },
    select: {
      activeProjectionRunId: true,
      activePreviewSelectionRunId: true,
    },
  });

  if (!publicationState?.activeProjectionRunId || !publicationState.activePreviewSelectionRunId) {
    return { rendered: 0, failed: 0, skipped: 0 };
  }

  const activeProjectionRunId = publicationState.activeProjectionRunId;
  const activePreviewSelectionRunId = publicationState.activePreviewSelectionRunId;

  const candidates = await prisma.previewSelectionFigure.findMany({
    where: {
      previewSelectionRunId: activePreviewSelectionRunId,
      selectedPreviewSource: "none",
      projectionFigure: {
        projectionRunId: activeProjectionRunId,
        type: "table",
        gapReason: "structured_content_no_preview",
      },
    },
    select: {
      projectionFigureId: true,
      projectionFigure: {
        select: {
          figureLabel: true,
          structuredContent: true,
        },
      },
    },
  });

  const eligible = candidates.filter(
    (candidate) => candidate.projectionFigure.structuredContent
      && candidate.projectionFigure.structuredContent.length > 100,
  );
  if (eligible.length === 0) {
    return { rendered: 0, failed: 0, skipped: candidates.length };
  }

  const figDir = path.join(process.cwd(), "uploads", "figures", paperId);
  await mkdir(figDir, { recursive: true });

  let browser: Browser;
  const renderRun = await prisma.renderRun.create({
    data: {
      paperId,
      projectionRunId: activeProjectionRunId,
      rendererVersion: HTML_TABLE_RENDERER_VERSION,
      templateVersion: HTML_TABLE_RENDER_TEMPLATE_VERSION,
      browserVersion: "launch_pending",
      status: "running",
      metadata: JSON.stringify({
        eligibleCount: eligible.length,
        skippedCount: candidates.length - eligible.length,
      }),
    },
    select: { id: true },
  });

  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    await prisma.renderRun.update({
      where: { id: renderRun.id },
      data: {
        status: "failed",
        browserVersion: "launch_failed",
        completedAt: new Date(),
        metadata: JSON.stringify({
          eligibleCount: eligible.length,
          renderedCount: 0,
          failedCount: eligible.length,
          skippedCount: candidates.length - eligible.length,
          error: (err as Error).message,
        }),
      },
    });
    console.warn(`[table-preview] Failed to launch browser: ${(err as Error).message}`);
    return { rendered: 0, failed: eligible.length, skipped: 0 };
  }

  await prisma.renderRun.update({
    where: { id: renderRun.id },
    data: {
      browserVersion: browser.version(),
    },
  });

  let rendered = 0;
  let failed = 0;
  const renderedOutputs: Array<{
    projectionFigureId: string;
    storagePath: string;
    assetHash: string;
    width: number;
    height: number;
    byteSize: number;
    inputHash: string;
  }> = [];

  try {
    for (const row of eligible) {
      const safeLabel = (row.projectionFigure.figureLabel || "table")
        .replace(/[^a-zA-Z0-9]/g, "_")
        .toLowerCase();
      const filename = `table-preview-${safeLabel}.png`;
      const outPath = path.join(figDir, filename);

      const result = await renderTableHtml(
        browser,
        row.projectionFigure.structuredContent!,
        outPath,
      );

      if (result.success) {
        const relativePath = `uploads/figures/${paperId}/${filename}`;
        renderedOutputs.push({
          projectionFigureId: row.projectionFigureId,
          storagePath: relativePath,
          assetHash: result.assetHash!,
          width: result.width!,
          height: result.height!,
          byteSize: result.byteSize!,
          inputHash: createHash("sha256").update(row.projectionFigure.structuredContent!).digest("hex"),
        });
        rendered++;
        console.log(
          `[table-preview] Rendered ${row.projectionFigure.figureLabel} (${result.width}x${result.height})`,
        );
      } else {
        console.warn(`[table-preview] Render failed for ${row.projectionFigure.figureLabel}: ${result.error}`);
        failed++;
      }
    }
  } finally {
    await browser.close();
  }

  if (renderedOutputs.length > 0) {
    try {
      await prisma.$transaction(async (tx) => {
        const leaseToken = await acquirePaperWorkLease(
          tx,
          paperId,
          "html-table-preview-renderer",
        );

        try {
          const replacements = [];
          for (const output of renderedOutputs) {
            const assetId = await upsertRenderedPreviewAsset(tx, paperId, {
              storagePath: output.storagePath,
              contentHash: output.assetHash,
              width: output.width,
              height: output.height,
              byteSize: output.byteSize,
            });
            const renderedPreviewId = await createRenderedPreview(
              tx,
              renderRun.id,
              output.projectionFigureId,
              assetId,
              "html_table",
              output.inputHash,
            );

            replacements.push({
              projectionFigureId: output.projectionFigureId,
              assetId,
              renderedPreviewId,
              sourceMethod: "html_table_render",
            });
          }

          const previewSelectionRunId = await createEnrichmentPreviewSelectionRun(
            tx,
            paperId,
            activeProjectionRunId,
            activePreviewSelectionRunId,
            replacements,
          );

          await publishPreviewSelectionRun(
            tx,
            paperId,
            previewSelectionRunId,
            leaseToken,
            activeProjectionRunId,
          );
        } finally {
          await releasePaperWorkLease(tx, paperId, leaseToken);
        }
      });
    } catch (err) {
      await prisma.renderRun.update({
        where: { id: renderRun.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          metadata: JSON.stringify({
            eligibleCount: eligible.length,
            renderedCount: rendered,
            failedCount: failed,
            skippedCount: candidates.length - eligible.length,
            error: (err as Error).message,
          }),
        },
      });
      throw err;
    }
  }

  await prisma.renderRun.update({
    where: { id: renderRun.id },
    data: {
      status: renderedOutputs.length > 0 ? "completed" : "failed",
      completedAt: new Date(),
      metadata: JSON.stringify({
        eligibleCount: eligible.length,
        renderedCount: rendered,
        failedCount: failed,
        skippedCount: candidates.length - eligible.length,
      }),
    },
  });

  return { rendered, failed, skipped: candidates.length - eligible.length };
}
