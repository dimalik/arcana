import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";
import {
  countCompletedPapersNeedingFullReprocess,
  findCompletedPapersNeedingFullReprocess,
} from "@/lib/processing/maintenance-state";
import {
  shouldUseBatch,
  createBatchJob,
  pollBatch,
  pollAllActiveBatches,
  getActiveBatches,
  getBatchGroup,
  submitNextPhase,
} from "@/lib/processing/batch";

/**
 * POST /api/papers/maintenance/batch
 *
 * Actions:
 * - action=estimate  — Check if batch is recommended for pending papers
 * - action=create    — Create and submit a batch job (optionally with paperIds)
 * - action=poll      — Poll a specific batch (batchId) or all active batches
 * - action=status    — Get all active batches
 * - action=group     — Get all batches in a group (groupId)
 */
export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  const body = await request.json();
  const action = body.action as string;

  if (action === "estimate") {
    // Count papers that need processing
    const needsFullReprocess = await prisma.paper.count({
      where: {
        userId,
        processingStatus: "TEXT_EXTRACTED",
        fullText: { not: null },
      },
    });

    const needsDeferred = await prisma.paper.count({
      where: {
        userId,
        processingStatus: "NEEDS_DEFERRED",
      },
    });

    const completedMissing = await countCompletedPapersNeedingFullReprocess(
      userId,
    );

    const totalPapers = needsFullReprocess + needsDeferred + completedMissing;
    const stepsPerPaper = needsFullReprocess > 0 ? 8 : 5; // Deferred-only needs fewer steps
    const { useBatch, estimatedSeqMins } = shouldUseBatch(totalPapers, stepsPerPaper);

    return NextResponse.json({
      totalPapers,
      needsFullReprocess,
      needsDeferred,
      completedMissing,
      useBatch,
      estimatedSeqMins,
      estimatedBatchHours: "1-4",
    });
  }

  if (action === "create") {
    // Gather paper IDs that need processing
    let paperIds: string[] = body.paperIds;

    if (!paperIds || paperIds.length === 0) {
      // Auto-detect papers needing processing
      const fullReprocess = await prisma.paper.findMany({
        where: { userId, processingStatus: "TEXT_EXTRACTED", fullText: { not: null } },
        select: { id: true },
      });

      const needsDeferred = await prisma.paper.findMany({
        where: { userId, processingStatus: "NEEDS_DEFERRED" },
        select: { id: true },
      });

      const completedMissing = await findCompletedPapersNeedingFullReprocess(
        userId,
      );

      // For completed papers missing analysis, reset to NEEDS_DEFERRED first
      for (const { id } of completedMissing) {
        await prisma.paper.update({
          where: { id },
          data: {
            processingStatus: "TEXT_EXTRACTED",
            processingStep: null,
            processingStartedAt: null,
          },
        });
      }

      paperIds = [
        ...fullReprocess.map(p => p.id),
        ...needsDeferred.map(p => p.id),
        ...completedMissing.map(p => p.id),
      ];

      // Deduplicate
      paperIds = Array.from(new Set(paperIds));
    }

    if (paperIds.length === 0) {
      return NextResponse.json({ error: "No papers need processing" }, { status: 400 });
    }

    try {
      const result = await createBatchJob(paperIds);
      return NextResponse.json({
        groupId: result.groupId,
        batchId: result.phase1BatchId,
        requestCount: result.requestCount,
        paperCount: paperIds.length,
        skippedForChunking: result.skippedForChunking.length,
        message: `Batch submitted with ${result.requestCount} requests for ${paperIds.length} papers. Phase 1 processing.`,
      });
    } catch (e) {
      console.error("[batch API] Create failed:", e);
      return NextResponse.json({ error: e instanceof Error ? e.message : "Failed to create batch" }, { status: 500 });
    }
  }

  if (action === "poll") {
    if (body.batchId) {
      try {
        const result = await pollBatch(body.batchId);
        return NextResponse.json(result);
      } catch (e) {
        return NextResponse.json({ error: e instanceof Error ? e.message : "Poll failed" }, { status: 500 });
      }
    }

    // Poll all active
    const result = await pollAllActiveBatches();
    return NextResponse.json(result);
  }

  if (action === "status") {
    const active = await getActiveBatches();
    const recent = await prisma.processingBatch.findMany({
      where: { status: { in: ["COMPLETED", "FAILED"] } },
      orderBy: { completedAt: "desc" },
      take: 10,
    });
    return NextResponse.json({ active, recent });
  }

  if (action === "group") {
    if (!body.groupId) {
      return NextResponse.json({ error: "groupId required" }, { status: 400 });
    }
    const batches = await getBatchGroup(body.groupId);
    return NextResponse.json(batches);
  }

  if (action === "retry_phase") {
    // Retry submitting a failed phase for a group
    if (!body.groupId || !body.phase) {
      return NextResponse.json({ error: "groupId and phase required" }, { status: 400 });
    }

    // Get the completed previous phase to extract paperIds and modelId
    const prevPhase = await prisma.processingBatch.findFirst({
      where: { groupId: body.groupId, status: "COMPLETED" },
      orderBy: { phase: "desc" },
    });

    if (!prevPhase) {
      return NextResponse.json({ error: "No completed phase found in this group" }, { status: 400 });
    }

    try {
      await submitNextPhase(
        body.groupId,
        body.phase,
        JSON.parse(prevPhase.paperIds),
        prevPhase.modelId,
      );
      return NextResponse.json({ ok: true, message: `Phase ${body.phase} submitted` });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "Failed" }, { status: 500 });
    }
  }

  return NextResponse.json({ error: "Unknown action" }, { status: 400 });
}
