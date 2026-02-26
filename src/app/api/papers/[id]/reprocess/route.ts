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

  if (!paper.fullText && !paper.abstract) {
    return NextResponse.json(
      { error: "No text available to process" },
      { status: 400 }
    );
  }

  // Reset status and enqueue
  await prisma.paper.update({
    where: { id },
    data: {
      processingStatus: "TEXT_EXTRACTED",
      processingStep: null,
      processingStartedAt: null,
    },
  });

  processingQueue.enqueue(id);

  return NextResponse.json({ success: true, message: "Reprocessing started" });
}
