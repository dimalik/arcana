import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { findAndDownloadPdf } from "@/lib/import/pdf-finder";
import { createBatchJob } from "@/lib/processing/batch";
import { runTextExtraction } from "@/lib/llm/auto-process";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 minutes

/**
 * POST — Bulk-repair papers missing PDFs.
 * Downloads PDFs for papers that have arxivId or doi but no filePath.
 * Processes in serial with a small delay to avoid rate limits.
 *
 * Query params:
 *   ?limit=50        max papers to process (default 50)
 *   ?dryRun=true     just count, don't download
 *   ?reprocess=true  queue papers for batch reprocessing after PDF download
 */
export async function POST(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get("limit") || "50");
  const dryRun = searchParams.get("dryRun") === "true";
  const reprocess = searchParams.get("reprocess") !== "false"; // default true

  // Find papers missing PDFs that have identifiers we can use
  const candidates = await prisma.paper.findMany({
    where: {
      filePath: null,
      OR: [
        { arxivId: { not: null } },
        { doi: { not: null } },
      ],
    },
    select: { id: true, title: true, arxivId: true, doi: true, processingStatus: true },
    // Prioritize arXiv (guaranteed PDF), then by recency
    orderBy: [{ arxivId: "desc" }, { createdAt: "desc" }],
    take: limit,
  });

  if (dryRun) {
    // Count totals
    const total = await prisma.paper.count({
      where: {
        filePath: null,
        OR: [{ arxivId: { not: null } }, { doi: { not: null } }],
      },
    });
    return NextResponse.json({ dryRun: true, total, batch: candidates.length });
  }

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
        const needsReprocessing = reprocess && (
          paper.processingStatus === "PENDING" ||
          paper.processingStatus === "NO_PDF" ||
          paper.processingStatus === "FAILED"
        );

        await prisma.paper.update({
          where: { id: paper.id },
          data: {
            filePath: result.filePath,
            ...(needsReprocessing ? { processingStatus: "EXTRACTING_TEXT" } : {}),
          },
        });

        if (needsReprocessing) {
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

    // Now submit to batch API (50% cheaper than sequential LLM calls)
    try {
      const batch = await createBatchJob(toReprocess);
      batchInfo = `Batch submitted: ${batch.requestCount} requests, group=${batch.groupId}`;
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
  const repairable = { filePath: null as null, OR: [{ arxivId: { not: null } }, { doi: { not: null } }] as Record<string, unknown>[] };

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
