import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { findAndDownloadPdf } from "@/lib/import/pdf-finder";
import { processingQueue } from "@/lib/processing/queue";
import { requireUserId } from "@/lib/paper-auth";

/**
 * POST /api/papers/[id]/locate-pdf
 * Attempts to find and download an open-access PDF for a paper
 * using its DOI and/or arXiv ID.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const userId = await requireUserId();
  const { searchParams } = new URL(request.url);
  const skipProcessing = searchParams.get("skipProcessing") === "true";

  const paper = await prisma.paper.findFirst({
    where: { id: params.id, userId },
    select: { id: true, doi: true, arxivId: true, filePath: true, fullText: true },
  });

  if (!paper) {
    return NextResponse.json({ error: "Paper not found" }, { status: 404 });
  }

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

  // If paper already has fullText (e.g., extracted from HTML source), skip reprocessing
  // — the existing text is likely more reliable than PDF extraction
  const shouldProcess = !skipProcessing && !paper.fullText;

  await prisma.paper.update({
    where: { id: paper.id },
    data: {
      filePath: result.filePath,
      ...(shouldProcess ? { processingStatus: "EXTRACTING_TEXT" } : {}),
    },
  });

  if (shouldProcess) {
    processingQueue.enqueue(paper.id);
  }

  return NextResponse.json(
    { success: true, filePath: result.filePath, source: result.source },
    { status: 200 }
  );
}
