import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  parseOpenReviewId,
  fetchOpenReviewMetadata,
  downloadOpenReviewPdf,
} from "@/lib/import/openreview";
import { processingQueue } from "@/lib/processing/queue";
import { z } from "zod";

const importSchema = z.object({
  input: z.string().min(1),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { input } = importSchema.parse(body);

    const forumId = parseOpenReviewId(input);
    if (!forumId) {
      return NextResponse.json(
        { error: "Invalid OpenReview ID or URL" },
        { status: 400 }
      );
    }

    const sourceUrl = `https://openreview.net/forum?id=${forumId}`;

    // Check for duplicate
    const existing = await prisma.paper.findFirst({
      where: { sourceUrl },
    });
    if (existing) {
      return NextResponse.json(
        { error: "Paper already imported", paper: existing },
        { status: 409 }
      );
    }

    // Fetch metadata
    const metadata = await fetchOpenReviewMetadata(forumId);

    // Download PDF synchronously before creating paper
    let filePath: string | undefined;
    try {
      filePath = await downloadOpenReviewPdf(forumId);
    } catch (e) {
      console.error("OpenReview PDF download failed:", e);
    }

    // Create paper record
    const paper = await prisma.paper.create({
      data: {
        title: metadata.title,
        abstract: metadata.abstract || null,
        authors: metadata.authors.length > 0
          ? JSON.stringify(metadata.authors)
          : null,
        year: metadata.year,
        venue: metadata.venue,
        sourceType: "OPENREVIEW",
        sourceUrl,
        filePath,
        processingStatus: "EXTRACTING_TEXT",
      },
    });

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
    console.error("OpenReview import error:", error);
    return NextResponse.json(
      { error: "Failed to import from OpenReview" },
      { status: 500 }
    );
  }
}
