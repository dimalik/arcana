import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { processingQueue } from "@/lib/processing/queue";
import { requireUserId } from "@/lib/paper-auth";
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
  const userId = await requireUserId();
  const { searchParams } = new URL(request.url);
  const search = searchParams.get("search") || "";
  const tagId = searchParams.get("tagId");
  const tagIds = searchParams.get("tagIds"); // comma-separated, OR filter
  const clusterId = searchParams.get("clusterId");
  const collectionId = searchParams.get("collectionId");
  const year = searchParams.get("year");
  const sort = searchParams.get("sort") || "newest";
  const page = parseInt(searchParams.get("page") || "1");
  const limit = parseInt(searchParams.get("limit") || "20");
  const skip = (page - 1) * limit;

  const where: Record<string, unknown> = { userId };

  if (search) {
    where.AND = [
      { userId },
      {
        OR: [
          { title: { contains: search } },
          { abstract: { contains: search } },
          { authors: { contains: search } },
          { summary: { contains: search } },
          { tags: { some: { tag: { name: { contains: search } } } } },
        ],
      },
    ];
    delete where.userId;
  }

  if (tagIds) {
    const ids = tagIds.split(",").filter(Boolean);
    if (ids.length > 0) {
      // Intersection: paper must have ALL selected tags
      where.AND = ids.map((id: string) => ({ tags: { some: { tagId: id } } }));
    }
  } else if (clusterId) {
    where.tags = { some: { tag: { clusterId } } };
  } else if (tagId) {
    where.tags = { some: { tagId } };
  }

  if (collectionId) {
    where.collections = { some: { collectionId } };
  } else {
    // Hide research-only papers from main library (they live in project collections)
    where.isResearchOnly = false;
  }

  if (year) {
    where.year = parseInt(year);
  }

  const pdfFilter = searchParams.get("pdf"); // "has" | "missing"
  if (pdfFilter === "has") {
    where.filePath = { not: null };
  } else if (pdfFilter === "missing") {
    where.filePath = null;
  }

  const [papers, total] = await Promise.all([
    prisma.paper.findMany({
      where,
      include: {
        tags: { include: { tag: true } },
        collections: { include: { collection: true } },
      },
      orderBy:
        sort === "oldest" ? { createdAt: "asc" as const }
        : sort === "title" ? { title: "asc" as const }
        : sort === "year" ? { year: "desc" as const }
        : sort === "engagement" ? { engagementScore: "desc" as const }
        : { createdAt: "desc" as const },
      skip,
      take: limit,
    }),
    prisma.paper.count({ where }),
  ]);

  // When searching, annotate each result with where the match was found and rank
  let rankedPapers = papers;
  if (search) {
    const lower = search.toLowerCase();
    rankedPapers = papers
      .map((p) => {
        const matchFields: string[] = [];
        if (p.title?.toLowerCase().includes(lower)) matchFields.push("title");
        if (p.abstract?.toLowerCase().includes(lower)) matchFields.push("abstract");
        if (p.summary?.toLowerCase().includes(lower)) matchFields.push("summary");
        if (p.authors?.toLowerCase().includes(lower)) matchFields.push("authors");
        // Rank: title=0, abstract=1, summary=2, authors=3
        const rank = matchFields.includes("title") ? 0
          : matchFields.includes("abstract") ? 1
          : matchFields.includes("summary") ? 2
          : 3;
        return { ...p, matchFields, _rank: rank };
      })
      .sort((a, b) => a._rank - b._rank)
      .map(({ _rank, ...rest }) => rest);
  }

  return NextResponse.json({
    papers: rankedPapers,
    total,
    page,
    totalPages: Math.ceil(total / limit),
  });
}

export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    const body = await request.json();
    const data = createPaperSchema.parse(body);

    const paper = await prisma.paper.create({
      data: {
        ...data,
        userId,
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
