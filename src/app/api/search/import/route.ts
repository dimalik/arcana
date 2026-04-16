import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { findAndDownloadPdf } from "@/lib/import/pdf-finder";
import { processingQueue } from "@/lib/processing/queue";
import { requireUserId } from "@/lib/paper-auth";
import { handleDuplicatePaperError, resolveEntityForImport } from "@/lib/canonical/import-dedup";

const importSchema = z.object({
  title: z.string().min(1),
  abstract: z.string().nullable().optional(),
  authors: z.array(z.string()).optional(),
  year: z.number().int().nullable().optional(),
  venue: z.string().nullable().optional(),
  doi: z.string().nullable().optional(),
  arxivId: z.string().nullable().optional(),
  externalUrl: z.string().optional(),
  citationCount: z.number().nullable().optional(),
  openAccessPdfUrl: z.string().nullable().optional(),
  semanticScholarId: z.string().optional(),
});

export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    const body = await request.json();
    const data = importSchema.parse(body);

    // Check for duplicate by DOI or arXiv ID (per user)
    if (data.doi || data.arxivId) {
      const existing = await prisma.paper.findFirst({
        where: {
          userId,
          OR: [
            ...(data.doi ? [{ doi: data.doi }] : []),
            ...(data.arxivId ? [{ arxivId: data.arxivId }] : []),
          ],
        },
      });
      if (existing) {
        return NextResponse.json(
          { error: "Paper already in library", paperId: existing.id },
          { status: 409 }
        );
      }
    }

    const resolved = await resolveEntityForImport({
      userId,
      title: data.title,
      doi: data.doi ?? undefined,
      arxivId: data.arxivId ?? undefined,
      semanticScholarId: data.semanticScholarId,
    });

    if (resolved.existingPaper) {
      return NextResponse.json(
        { error: "Paper already in library", paperId: resolved.existingPaper.id },
        { status: 409 }
      );
    }

    // Try to download the PDF before creating the paper record
    let filePath: string | undefined;
    try {
      const pdfResult = await findAndDownloadPdf({
        doi: data.doi,
        arxivId: data.arxivId,
        existingPdfUrl: data.openAccessPdfUrl,
      });
      if (pdfResult) filePath = pdfResult.filePath;
    } catch (e) {
      console.error("[search/import] PDF download failed:", e);
    }

    let paper;
    try {
      paper = await prisma.paper.create({
        data: {
          title: data.title,
          userId,
          abstract: data.abstract ?? null,
          authors: data.authors ? JSON.stringify(data.authors) : null,
          year: data.year ?? null,
          venue: data.venue ?? null,
          doi: data.doi ?? null,
          arxivId: data.arxivId ?? null,
          sourceType: data.arxivId ? "ARXIV" : data.externalUrl ? "URL" : "UPLOAD",
          sourceUrl: data.externalUrl ?? null,
          filePath,
          processingStatus: filePath ? "EXTRACTING_TEXT" : "PENDING",
          entityId: resolved.entityId,
        },
      });
    } catch (error) {
      const existing = await handleDuplicatePaperError(error, userId, resolved.entityId);
      if (existing) {
        return NextResponse.json(
          { error: "Paper already in library", paperId: existing.id },
          { status: 409 }
        );
      }
      throw error;
    }

    // If we got a PDF, queue for processing (text extraction → LLM pipeline)
    if (filePath) {
      processingQueue.enqueue(paper.id);
    }

    return NextResponse.json(paper, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation error", details: error.issues },
        { status: 400 }
      );
    }
    console.error("[search/import] Error:", error);
    return NextResponse.json(
      { error: "Failed to import paper" },
      { status: 500 }
    );
  }
}
