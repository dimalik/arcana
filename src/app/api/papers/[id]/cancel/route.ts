import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { processingQueue } from "@/lib/processing/queue";
import { requireUserId } from "@/lib/paper-auth";
import {
  finishProcessingRun,
  getLatestActiveRunForPaper,
  setProcessingProjection,
} from "@/lib/processing/runtime-ledger";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await requireUserId();
    const { id } = await params;

  const paper = await prisma.paper.findFirst({ where: { id, userId } });
  if (!paper) {
    return NextResponse.json({ error: "Paper not found" }, { status: 404 });
  }

  const cancelled = await processingQueue.cancel(id);

  if (!cancelled) {
    // Not in queue or processing — just force-set to FAILED if stuck
    if (paper.processingStatus !== "COMPLETED" && paper.processingStatus !== "FAILED") {
      const activeRun = await getLatestActiveRunForPaper(id);
      if (activeRun) {
        await finishProcessingRun({
          paperId: id,
          processingRunId: activeRun.id,
          processingStatus: "FAILED",
          runStatus: "CANCELLED",
          activeStepStatus: "CANCELLED",
          error: "cancelled_by_user",
        });
      } else {
        await setProcessingProjection(id, {
          processingStatus: "FAILED",
          processingStep: null,
          processingStartedAt: null,
        });
      }
    }
  }

  return NextResponse.json({ success: true, message: "Processing cancelled" });
}
