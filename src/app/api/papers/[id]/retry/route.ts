import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { processingQueue } from "@/lib/processing/queue";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const paper = await prisma.paper.findUnique({ where: { id } });
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
