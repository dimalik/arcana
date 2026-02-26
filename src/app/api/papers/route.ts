import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { processingQueue } from "@/lib/processing/queue";
import { z } from "zod";

const createPaperSchema = z.object({
  title: z.string().min(1),
  abstract: z.string().optional(),
  authors: z.array(z.string()).optional(),
  year: z.number().int().optional(),
  venue: z.string().optional(),
  doi: z.string().optional(),
  sourceType: z.enum(["UPLOAD", "ARXIV", "URL"]).default("UPLOAD"),
  sourceUrl: z.string().optional(),
  arxivId: z.string().optional(),
  filePath: z.string().optional(),
  fullText: z.string().optional(),
});

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const search = searchParams.get("search") || "";
  const tagId = searchParams.get("tagId");
  const collectionId = searchParams.get("collectionId");
  const year = searchParams.get("year");
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "20");
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = {};

  if (search) {
    where.OR = [
      { title: { contains: search } },
      { abstract: { contains: search } },
      { authors: { contains: search } },
    ];
  }

  if (tagId) {
    where.tags = { some: { tagId } };
  }

  if (collectionId) {
    where.collections = { some: { collectionId } };
  }

  if (year) {
    where.year = parseInt(year);
  }

  const [papers, total] = await Promise.all([
    prisma.paper.findMany({
      where,
      include: {
        tags: { include: { tag: true } },
        collections: { include: { collection: true } },
      },
      orderBy: { createdAt: "desc" },
      skip,
      take: limit,
    }),
    prisma.paper.count({ where }),
  ]);

  return NextResponse.json({
    papers,
    total,
    page,
    totalPages: Math.ceil(total / limit),
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const data = createPaperSchema.parse(body);

    const paper = await prisma.paper.create({
      data: {
        ...data,
        authors: data.authors ? JSON.stringify(data.authors) : null,
        processingStatus: data.fullText ? "TEXT_EXTRACTED" : "PENDING",
      },
    });

    // Queue handles LLM pipeline if we have text
    if (data.fullText) {
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
    console.error("Create paper error:", error);
    return NextResponse.json(
      { error: "Failed to create paper" },
      { status: 500 }
    );
  }
}
