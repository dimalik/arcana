import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  parseAnthologyId,
  fetchAnthologyMetadata,
  downloadAnthologyPdf,
} from "@/lib/import/anthology";
import { processingQueue } from "@/lib/processing/queue";
import { requireUserId } from "@/lib/paper-auth";
import { z } from "zod";

const importSchema = z.object({
  input: z.string().min(1),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { input } = importSchema.parse(body);

    const userId = await requireUserId();
    const anthologyId = parseAnthologyId(input);
    if (!anthologyId) {
      return NextResponse.json(
        { error: "Invalid ACL Anthology ID or URL" },
        { status: 400 }
      );
    }

    const doi = `10.18653/v1/${anthologyId}`;

    // Check for duplicate by DOI or source URL (per user)
    const existing = await prisma.paper.findFirst({
      where: {
        userId,
        OR: [
          { doi },
          { sourceUrl: `https://aclanthology.org/${anthologyId}/` },
        ],
      },
    });
    if (existing) {
      return NextResponse.json(
        { error: "Paper already imported", paper: existing },
        { status: 409 }
      );
    }

    // Fetch metadata
    const metadata = await fetchAnthologyMetadata(anthologyId);

    // Download PDF
    let filePath: string | undefined;
    try {
      filePath = await downloadAnthologyPdf(anthologyId);
    } catch (e) {
      console.error("ACL Anthology PDF download failed:", e);
    }

    // Create paper record
    const paper = await prisma.paper.create({
      data: {
        title: metadata.title,
        userId,
        abstract: metadata.abstract,
        authors: JSON.stringify(metadata.authors),
        year: metadata.year,
        venue: metadata.venue,
        doi: metadata.doi,
        sourceType: "URL",
        sourceUrl: `https://aclanthology.org/${anthologyId}/`,
        filePath,
        processingStatus: filePath ? "EXTRACTING_TEXT" : "PENDING",
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
    console.error("ACL Anthology import error:", error);
    return NextResponse.json(
      { error: "Failed to import from ACL Anthology" },
      { status: 500 }
    );
  }
}
