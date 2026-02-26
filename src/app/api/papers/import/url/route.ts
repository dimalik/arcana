import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { extractUrlContent } from "@/lib/import/url";
import { processingQueue } from "@/lib/processing/queue";
import { z } from "zod";

const importSchema = z.object({
  url: z.string().url(),
});

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { url } = importSchema.parse(body);

    // Check for duplicate
    const existing = await prisma.paper.findFirst({
      where: { sourceUrl: url },
    });
    if (existing) {
      return NextResponse.json(
        { error: "URL already imported", paper: existing },
        { status: 409 }
      );
    }

    const content = await extractUrlContent(url);

    const paper = await prisma.paper.create({
      data: {
        title: content.title,
        abstract: content.excerpt,
        sourceType: "URL",
        sourceUrl: url,
        fullText: content.content,
        processingStatus: "TEXT_EXTRACTED",
      },
    });

    // Queue handles LLM pipeline
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
