import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { findAndDownloadPdf } from "@/lib/import/pdf-finder";
import { createBatchJob } from "@/lib/processing/batch";
import { runTextExtraction } from "@/lib/llm/auto-process";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minutes

/**
 * POST — Bulk-repair papers missing PDFs.
 *
 * Query params:
 *   ?limit=50          max papers to process (default 50)
 *   ?scope=all         "all" | "library" | "research" (default all)
 *   ?reprocess=true    queue for batch reprocessing after PDF download (default true)
 *   ?dryRun=true       just count, don't download
 */
export async function POST(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get("limit") || "50");
  const scope = searchParams.get("scope") || "all";
  const dryRun = searchParams.get("dryRun") === "true";
  const reprocess = searchParams.get("reprocess") !== "false";

  const where: Record<string, unknown> = {
    filePath: null,
    OR: [{ arxivId: { not: null } }, { doi: { not: null } }],
  };
  if (scope === "library") where.isResearchOnly = false;
  else if (scope === "research") where.isResearchOnly = true;

  if (dryRun) {
    const total = await prisma.paper.count({ where });
    return NextResponse.json({ dryRun: true, scope, total });
  }

  const candidates = await prisma.paper.findMany({
    where,
    select: { id: true, title: true, arxivId: true, doi: true, processingStatus: true, fullText: true },
    orderBy: [{ arxivId: "desc" }, { createdAt: "desc" }],
    take: limit,
  });

  let downloaded = 0;
  let failed = 0;
  const toReprocess: string[] = [];
  const errors: string[] = [];

  for (const paper of candidates) {
    try {
      const result = await findAndDownloadPdf({
        doi: paper.doi,
        arxivId: paper.arxivId,
        title: paper.title,
      });

      if (result) {
        await prisma.paper.update({
          where: { id: paper.id },
          data: { filePath: result.filePath },
        });

        // Reprocess if requested — any paper that got a new PDF should be reprocessed
        // to get proper full-text extraction and LLM analysis from the PDF
        if (reprocess) {
          toReprocess.push(paper.id);
        }

        downloaded++;
      } else {
        failed++;
      }

      // Small delay between downloads to avoid rate limits
      await new Promise((r) => setTimeout(r, 500));
    } catch (err) {
      failed++;
      errors.push(`${paper.id}: ${(err as Error).message}`);
    }
  }

  // Extract text from downloaded PDFs (cheap, no LLM), then batch-process
  let textExtracted = 0;
  let batchInfo: string | null = null;
  if (toReprocess.length > 0) {
    for (const paperId of toReprocess) {
      try {
        await runTextExtraction(paperId);
        textExtracted++;
      } catch (err) {
        console.warn(`[repair-pdfs] Text extraction failed for ${paperId}:`, (err as Error).message);
      }
    }

    // Submit to batch API (50% cheaper)
    try {
      const batch = await createBatchJob(toReprocess);
      batchInfo = `Batch submitted: ${batch.requestCount} requests, group=${batch.groupId}`;
      if (batch.skippedForChunking.length > 0) {
        batchInfo += ` (${batch.skippedForChunking.length} skipped — too long for batch)`;
      }
      console.log(`[repair-pdfs] ${batchInfo}`);
    } catch (err) {
      batchInfo = `Batch submission failed: ${(err as Error).message}`;
      console.warn(`[repair-pdfs] ${batchInfo}`);
    }
  }

  return NextResponse.json({
    processed: candidates.length,
    downloaded,
    failed,
    textExtracted,
    queued: toReprocess.length,
    batch: batchInfo,
    errors: errors.slice(0, 10),
  });
}

/**
 * GET — Check how many papers are missing PDFs.
 */
export async function GET() {
  const noPdf = { filePath: null as null };
  const repairable = { ...noPdf, OR: [{ arxivId: { not: null } }, { doi: { not: null } }] as Record<string, unknown>[] };

  const [totalPapers, totalNoPdf, libraryNoPdf, researchNoPdf, withArxiv, withDoi, noIdentifier] = await Promise.all([
    prisma.paper.count(),
    prisma.paper.count({ where: noPdf }),
    prisma.paper.count({ where: { ...noPdf, isResearchOnly: false } }),
    prisma.paper.count({ where: { ...noPdf, isResearchOnly: true } }),
    prisma.paper.count({ where: { ...noPdf, arxivId: { not: null } } }),
    prisma.paper.count({ where: { ...noPdf, doi: { not: null }, arxivId: null } }),
    prisma.paper.count({ where: { ...noPdf, doi: null, arxivId: null } }),
  ]);

  return NextResponse.json({
    totalPapers,
    totalNoPdf,
    libraryNoPdf,
    researchNoPdf,
    repairable: withArxiv + withDoi,
    withArxiv,
    withDoi,
    noIdentifier,
  });
}
