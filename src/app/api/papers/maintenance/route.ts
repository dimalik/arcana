import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";
import { processingQueue } from "@/lib/processing/queue";
import { downloadArxivPdf } from "@/lib/import/arxiv";
import { fetchDoiMetadata } from "@/lib/import/url";
import { shouldUseBatch } from "@/lib/processing/batch";

/**
 * POST /api/papers/maintenance
 *
 * Operations:
 * - action=status        — Get counts of papers needing maintenance + batch recommendation
 * - action=fetch_missing — Attempt to fetch PDFs for PENDING papers via ArXiv/DOI
 * - action=run_deferred  — Queue COMPLETED papers missing analysis steps for reprocessing (sequential)
 *
 * For batch processing, use /api/papers/maintenance/batch instead.
 */
export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  const body = await request.json();
  const action = body.action as string;

  if (action === "status") {
    return NextResponse.json(await getMaintenanceStatus(userId));
  }

  if (action === "run_deferred") {
    return NextResponse.json(await queueDeferredProcessing(userId));
  }

  if (action === "fetch_missing") {
    return NextResponse.json(await fetchMissingPdfs(userId));
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}

async function getMaintenanceStatus(userId: string) {
  // Papers without any content (PENDING, no fullText)
  const pendingNoContent = await prisma.paper.count({
    where: {
      userId,
      processingStatus: "PENDING",
      fullText: null,
    },
  });

  // COMPLETED papers missing deferred steps (no keyFindings as proxy)
  const completedMissingAnalysis = await prisma.$queryRaw<{ count: number }[]>`
    SELECT COUNT(*) as count FROM Paper p
    WHERE p.userId = ${userId}
    AND p.processingStatus = 'COMPLETED'
    AND p.fullText IS NOT NULL
    AND (
      p.id NOT IN (SELECT paperId FROM PromptResult WHERE promptType = 'distillInsights')
      OR p.id NOT IN (SELECT paperId FROM PromptResult WHERE promptType = 'extractCitationContexts')
    )
  `;

  // FAILED papers
  const failedCount = await prisma.paper.count({
    where: { userId, processingStatus: "FAILED" },
  });

  const totalNeedingProcessing = Number(completedMissingAnalysis[0]?.count ?? 0);
  const batchRecommendation = shouldUseBatch(totalNeedingProcessing);

  // Check for active batch jobs
  const activeBatches = await prisma.processingBatch.count({
    where: { status: { in: ["SUBMITTED", "PROCESSING"] } },
  });

  return {
    pendingNoContent,
    completedMissingAnalysis: totalNeedingProcessing,
    failedCount,
    batchRecommended: batchRecommendation.useBatch,
    estimatedSeqMins: batchRecommendation.estimatedSeqMins,
    activeBatches,
  };
}

async function queueDeferredProcessing(userId: string) {
  // Find COMPLETED papers that are missing deferred analysis steps
  // Use distillInsights as the proxy — if that's missing, the deferred pipeline hasn't run
  const papersNeedingDeferred = await prisma.$queryRaw<{ id: string }[]>`
    SELECT p.id FROM Paper p
    WHERE p.userId = ${userId}
    AND p.processingStatus = 'COMPLETED'
    AND p.fullText IS NOT NULL
    AND (
      p.id NOT IN (SELECT paperId FROM PromptResult WHERE promptType = 'distillInsights')
      OR p.id NOT IN (SELECT paperId FROM PromptResult WHERE promptType = 'extractCitationContexts')
    )
  `;

  if (papersNeedingDeferred.length === 0) {
    return { queued: 0, message: "All papers already have full analysis" };
  }

  // Also find COMPLETED papers missing keyFindings (need extract step)
  const missingKeyFindings = await prisma.paper.findMany({
    where: {
      userId,
      processingStatus: "COMPLETED",
      fullText: { not: null },
      keyFindings: null,
    },
    select: { id: true },
  });
  const missingKfIds = new Set(missingKeyFindings.map((p) => p.id));

  // Set papers to NEEDS_DEFERRED so the pipeline picks them up
  // For papers also missing keyFindings, set to TEXT_EXTRACTED so they get the full pipeline
  let deferredCount = 0;
  let fullReprocessCount = 0;

  for (const { id } of papersNeedingDeferred) {
    if (missingKfIds.has(id)) {
      // Needs full reprocess (including extract for keyFindings)
      await prisma.paper.update({
        where: { id },
        data: {
          processingStatus: "TEXT_EXTRACTED",
          processingStep: null,
          processingStartedAt: null,
        },
      });
      processingQueue.enqueue(id);
      fullReprocessCount++;
    } else {
      // Just needs deferred steps
      await prisma.paper.update({
        where: { id },
        data: {
          processingStatus: "NEEDS_DEFERRED",
          processingStep: null,
          processingStartedAt: null,
        },
      });
      deferredCount++;
    }
  }

  // Trigger deferred processing — the queue auto-runs deferred steps when it drains.
  // If we only have deferred papers (no full reprocess), kick the queue to trigger it.
  if (deferredCount > 0 && fullReprocessCount === 0) {
    // Import and call runDeferredSteps directly since the queue won't auto-trigger
    // without any papers flowing through the main pipeline
    const { runDeferredSteps } = await import("@/lib/llm/auto-process");
    // Run async — don't block the response
    runDeferredSteps().catch((e) => console.error("[maintenance] Deferred processing error:", e));
  }

  return {
    queued: papersNeedingDeferred.length,
    fullReprocess: fullReprocessCount,
    deferredOnly: deferredCount,
    message: `Queued ${fullReprocessCount} for full reprocessing (missing keyFindings) and ${deferredCount} for deferred analysis (linking, contradictions, citations, insights)`,
  };
}

async function fetchMissingPdfs(userId: string) {
  const pendingPapers = await prisma.paper.findMany({
    where: {
      userId,
      processingStatus: "PENDING",
      fullText: null,
      filePath: null,
    },
    select: { id: true, title: true, sourceType: true, arxivId: true, doi: true, sourceUrl: true },
  });

  if (pendingPapers.length === 0) {
    return { attempted: 0, fetched: 0, unfetchable: 0, message: "No pending papers need PDFs" };
  }

  let fetched = 0;
  let failed = 0;
  let unfetchable = 0;
  const errors: string[] = [];

  for (const paper of pendingPapers) {
    // Try ArXiv first
    if (paper.arxivId) {
      try {
        const filePath = await downloadArxivPdf(paper.arxivId);
        await prisma.paper.update({
          where: { id: paper.id },
          data: { filePath, processingStatus: "EXTRACTING_TEXT" },
        });
        processingQueue.enqueue(paper.id);
        fetched++;
        continue;
      } catch (e) {
        errors.push(`ArXiv ${paper.arxivId}: ${e instanceof Error ? e.message : "failed"}`);
      }
    }

    // Try DOI for OA PDF
    if (paper.doi) {
      try {
        const meta = await fetchDoiMetadata(paper.doi);
        if (meta?.openAccessPdfUrl) {
          const res = await fetch(meta.openAccessPdfUrl, {
            signal: AbortSignal.timeout(30_000),
            headers: { "User-Agent": "PaperFinder/1.0 (academic research tool)" },
          });
          if (res.ok) {
            const { writeFile, mkdir } = await import("fs/promises");
            const path = await import("path");
            const uploadDir = path.join(process.cwd(), "uploads");
            await mkdir(uploadDir, { recursive: true });
            const buf = Buffer.from(await res.arrayBuffer());
            const filename = `doi-${paper.doi.replace(/[/.]/g, "-").slice(0, 40)}-${paper.id.slice(0, 8)}.pdf`;
            const filePath = path.join(uploadDir, filename);
            await writeFile(filePath, buf);
            await prisma.paper.update({
              where: { id: paper.id },
              data: {
                filePath: `uploads/${filename}`,
                processingStatus: "EXTRACTING_TEXT",
                abstract: meta.abstract || paper.sourceUrl ? undefined : meta.abstract,
              },
            });
            processingQueue.enqueue(paper.id);
            fetched++;
            continue;
          }
        }
        // No OA PDF available — mark as unfetchable
        await prisma.paper.update({
          where: { id: paper.id },
          data: { processingStatus: "NO_PDF" },
        });
        unfetchable++;
      } catch (e) {
        errors.push(`DOI ${paper.doi}: ${e instanceof Error ? e.message : "failed"}`);
        failed++;
      }
      continue;
    }

    // No ArXiv ID and no DOI — can't fetch
    await prisma.paper.update({
      where: { id: paper.id },
      data: { processingStatus: "NO_PDF" },
    });
    unfetchable++;
  }

  return {
    attempted: pendingPapers.length,
    fetched,
    failed,
    unfetchable,
    errors: errors.slice(0, 10),
    message: `Fetched ${fetched} PDFs, ${unfetchable} marked as no PDF available, ${failed} failed`,
  };
}
