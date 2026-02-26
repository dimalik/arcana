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

  const cancelled = await processingQueue.cancel(id);

  if (!cancelled) {
    // Not in queue or processing — just force-set to FAILED if stuck
    if (paper.processingStatus !== "COMPLETED" && paper.processingStatus !== "FAILED") {
      await prisma.paper.update({
        where: { id },
        data: {
          processingStatus: "FAILED",
          processingStep: null,
          processingStartedAt: null,
        },
      });
    }
  }

  return NextResponse.json({ success: true, message: "Processing cancelled" });
}
