import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  parseArxivId,
  fetchArxivMetadata,
  downloadArxivPdf,
} from "@/lib/import/arxiv";
import { processingQueue } from "@/lib/processing/queue";
import { requireUserId } from "@/lib/paper-auth";
import {
  createPaperWithAuthorIndex,
  serializePaperAuthors,
} from "@/lib/papers/authors";
import { z } from "zod";
import { handleDuplicatePaperError, resolveEntityForImport } from "@/lib/canonical/import-dedup";

const importSchema = z.object({
  input: z.string().min(1),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { input } = importSchema.parse(body);

    const userId = await requireUserId();
    const arxivId = parseArxivId(input);
    if (!arxivId) {
      return NextResponse.json(
        { error: "Invalid arxiv ID or URL" },
        { status: 400 }
      );
    }

    // Fetch metadata
    const metadata = await fetchArxivMetadata(arxivId);

    const resolved = await resolveEntityForImport({
      userId,
      title: metadata.title,
      arxivId,
    });

    if (resolved.existingPaper) {
      return NextResponse.json(
        { error: "Paper already imported", paper: resolved.existingPaper },
        { status: 409 }
      );
    }

    // Download PDF synchronously before creating paper (fast — just a file download)
    let filePath: string | undefined;
    try {
      filePath = await downloadArxivPdf(arxivId);
    } catch (e) {
      console.error("ArXiv PDF download failed:", e);
    }

    // Create paper record
    let paper;
    try {
      paper = await createPaperWithAuthorIndex({
        data: {
          title: metadata.title,
          userId,
          abstract: metadata.abstract,
          authors: serializePaperAuthors(metadata.authors),
          year: metadata.year,
          sourceType: "ARXIV",
          sourceUrl: `https://arxiv.org/abs/${arxivId}`,
          arxivId,
          filePath,
          categories: JSON.stringify(metadata.categories),
          processingStatus: "EXTRACTING_TEXT",
          entityId: resolved.entityId,
        },
      });
    } catch (error) {
      const existing = await handleDuplicatePaperError(error, userId, resolved.entityId);
      if (existing) {
        return NextResponse.json(
          { error: "Paper already imported", paper: existing },
          { status: 409 }
        );
      }
      throw error;
    }

    // Queue handles: PDF text extraction → LLM pipeline
    processingQueue.enqueue(paper.id);

    return NextResponse.json(paper, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation error", details: error.issues },
        { status: 400 }
      );
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("Arxiv import error:", message, error);
    return NextResponse.json(
      { error: `Failed to import from arxiv: ${message}` },
      { status: 500 }
    );
  }
}
