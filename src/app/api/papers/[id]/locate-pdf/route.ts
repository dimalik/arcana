import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { findAndDownloadPdf } from "@/lib/import/pdf-finder";
import { processingQueue } from "@/lib/processing/queue";
import { paperAccessErrorToResponse, requirePaperAccess } from "@/lib/paper-auth";
import { setProcessingProjection } from "@/lib/processing/runtime-ledger";

/**
 * POST /api/papers/[id]/locate-pdf
 * Attempts to find and download an open-access PDF for a paper
 * using its DOI and/or arXiv ID.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const access = await requirePaperAccess(params.id, {
      mode: "mutate",
      select: { id: true, doi: true, arxivId: true, filePath: true, fullText: true },
    });
    if (!access) {
      return NextResponse.json({ error: "Paper not found" }, { status: 404 });
    }

    const { searchParams } = new URL(request.url);
    const skipProcessing = searchParams.get("skipProcessing") === "true";
    const paper = access.paper;

    if (paper.filePath) {
      return NextResponse.json(
        { error: "Paper already has a PDF" },
        { status: 409 }
      );
    }

    if (!paper.doi && !paper.arxivId) {
      return NextResponse.json(
        { error: "No DOI or arXiv ID available to search for PDF" },
        { status: 422 }
      );
    }

    const result = await findAndDownloadPdf({
      doi: paper.doi,
      arxivId: paper.arxivId,
    });

    if (!result) {
      return NextResponse.json(
        { error: "Could not find an open-access PDF" },
        { status: 404 }
      );
    }

    const shouldProcess = !skipProcessing && !paper.fullText;

    if (shouldProcess) {
      await prisma.$transaction(async (tx) => {
        await tx.paper.update({
          where: { id: paper.id },
          data: { filePath: result.filePath },
        });
        await setProcessingProjection(
          paper.id,
          {
            processingStatus: "EXTRACTING_TEXT",
            processingStep: null,
            processingStartedAt: null,
          },
          tx,
        );
      });
    } else {
      await prisma.paper.update({
        where: { id: paper.id },
        data: { filePath: result.filePath },
      });
    }

    if (shouldProcess) {
      processingQueue.enqueue(paper.id);
    }

    return NextResponse.json(
      { success: true, filePath: result.filePath, source: result.source },
      { status: 200 }
    );
  } catch (error) {
    const response = paperAccessErrorToResponse(error);
    if (response) return response;
    throw error;
  }
}
