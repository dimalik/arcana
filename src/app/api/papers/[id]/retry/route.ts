import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { processingQueue } from "@/lib/processing/queue";
import { requireUserId } from "@/lib/paper-auth";

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

  // Clear stale step tracking and re-enqueue from current state
  await prisma.paper.update({
    where: { id },
    data: {
      processingStep: null,
      processingStartedAt: null,
      // If FAILED, reset to allow reprocessing; otherwise keep current status
      ...(paper.processingStatus === "FAILED"
        ? { processingStatus: paper.fullText ? "TEXT_EXTRACTED" : "EXTRACTING_TEXT" }
        : {}),
    },
  });

  processingQueue.enqueue(id);

  return NextResponse.json({ success: true, message: "Paper re-enqueued" });
}
