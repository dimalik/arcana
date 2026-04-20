import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  extractUrlContent,
  extractDoiFromUrl,
  fetchDoiMetadata,
} from "@/lib/import/url";
import { processingQueue } from "@/lib/processing/queue";
import { findAndDownloadPdf } from "@/lib/import/pdf-finder";
import { requireUserId } from "@/lib/paper-auth";
import {
  createPaperWithAuthorIndex,
  serializePaperAuthors,
} from "@/lib/papers/authors";
import { z } from "zod";
import { buildInitialReferenceState } from "@/lib/references/reference-state";

const importSchema = z.object({
  url: z.string().url(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const userId = await requireUserId();
    const { url } = importSchema.parse(body);

    // Check for duplicate by URL (per user)
    const existingByUrl = await prisma.paper.findFirst({
      where: { sourceUrl: url, userId },
    });
    if (existingByUrl) {
      return NextResponse.json(
        { error: "URL already imported", paper: existingByUrl },
        { status: 409 }
      );
    }

    // ── DOI-first path ───────────────────────────────────────────────
    const doi = extractDoiFromUrl(url);

    if (doi) {
      // Check for duplicate by DOI
      const existingByDoi = await prisma.paper.findFirst({
        where: { doi, userId },
      });
      if (existingByDoi) {
        return NextResponse.json(
          { error: "Paper with this DOI already imported", paper: existingByDoi },
          { status: 409 }
        );
      }

      const metadata = await fetchDoiMetadata(doi);

      if (metadata) {
        // Aggressively search for PDF from multiple sources
        const pdfResult = await findAndDownloadPdf({
          doi: metadata.doi,
          existingPdfUrl: metadata.openAccessPdfUrl,
        });

        const paper = await createPaperWithAuthorIndex({
          data: {
            title: metadata.title,
            userId,
            abstract: metadata.abstract,
            authors: serializePaperAuthors(metadata.authors),
            year: metadata.year,
            venue: metadata.venue,
            doi: metadata.doi,
            sourceType: "URL",
            sourceUrl: url,
            filePath: pdfResult?.filePath,
            processingStatus: pdfResult?.filePath ? "EXTRACTING_TEXT" : "TEXT_EXTRACTED",
            referenceState: buildInitialReferenceState({
              filePath: pdfResult?.filePath,
              processingStatus: pdfResult?.filePath ? "EXTRACTING_TEXT" : "TEXT_EXTRACTED",
            }),
          },
        });

        processingQueue.enqueue(paper.id);
        return NextResponse.json(paper, { status: 201 });
      }
      // metadata fetch failed — fall through to Readability
    }

    // ── HTML scrape fallback (meta tags + Readability) ────────────────
    const content = await extractUrlContent(url);

    // If meta tags found a DOI we didn't catch from the URL, dedup by it
    if (content.doi) {
      const existingByDoi = await prisma.paper.findFirst({
        where: { doi: content.doi },
      });
      if (existingByDoi) {
        return NextResponse.json(
          { error: "Paper with this DOI already imported", paper: existingByDoi },
          { status: 409 }
        );
      }
    }

    // Try to find and download PDF from multiple sources
    const pdfResult = await findAndDownloadPdf({
      doi: content.doi,
      existingPdfUrl: content.pdfUrl,
    });

    const paper = await createPaperWithAuthorIndex({
      data: {
        title: content.title,
        userId,
        abstract: content.excerpt || undefined,
        authors: serializePaperAuthors(content.authors),
        year: content.year ?? undefined,
        venue: content.siteName || undefined,
        doi: content.doi || undefined,
        sourceType: "URL",
        sourceUrl: url,
        fullText: content.content || undefined,
        filePath: pdfResult?.filePath,
        processingStatus: pdfResult?.filePath ? "EXTRACTING_TEXT" : "TEXT_EXTRACTED",
        referenceState: buildInitialReferenceState({
          filePath: pdfResult?.filePath,
          fullText: content.content || null,
          processingStatus: pdfResult?.filePath ? "EXTRACTING_TEXT" : "TEXT_EXTRACTED",
        }),
      },
    });

    processingQueue.enqueue(paper.id);

    return NextResponse.json(paper, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation error", details: error.issues },
        { status: 400 }
      );
    }
    console.error("URL import error:", error);
    return NextResponse.json(
      { error: "Failed to import from URL" },
      { status: 500 }
    );
  }
}
