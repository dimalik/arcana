import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { processingQueue } from "@/lib/processing/queue";
import { paperAccessErrorToResponse, requirePaperAccess } from "@/lib/paper-auth";
import { setProcessingProjection } from "@/lib/processing/runtime-ledger";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const access = await requirePaperAccess(id, { mode: "mutate" });
    if (!access) {
      return NextResponse.json({ error: "Paper not found" }, { status: 404 });
    }
    const paper = access.paper;

    await setProcessingProjection(id, {
      processingStatus:
        paper.processingStatus === "FAILED"
          ? paper.fullText
            ? "TEXT_EXTRACTED"
            : "EXTRACTING_TEXT"
          : paper.processingStatus,
      processingStep: null,
      processingStartedAt: null,
    });

    processingQueue.enqueue(id);

    return NextResponse.json({ success: true, message: "Paper re-enqueued" });
  } catch (error) {
    const response = paperAccessErrorToResponse(error);
    if (response) return response;
    throw error;
  }
}
