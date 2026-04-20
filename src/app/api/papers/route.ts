import { NextRequest, NextResponse } from "next/server";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { processingQueue } from "@/lib/processing/queue";
import { requireUserId } from "@/lib/paper-auth";
import { z } from "zod";
import { handleDuplicatePaperError, resolveEntityForImport } from "@/lib/canonical/import-dedup";
import { buildInitialReferenceState } from "@/lib/references/reference-state";
import {
  createPaperWithAuthorIndex,
  serializePaperAuthors,
} from "@/lib/papers/authors";
import { searchLibraryPapers } from "@/lib/papers/search";
import { mergePaperVisibilityWhere } from "@/lib/papers/visibility";

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

  const where: Prisma.PaperWhereInput = mergePaperVisibilityWhere(userId);

  if (tagIds) {
    const ids = tagIds.split(",").filter(Boolean);
    if (ids.length > 0) {
      // Intersection: paper must have ALL selected tags
      const existingAnd = Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : [];
      where.AND = [
        ...existingAnd,
        ...ids.map((id: string) => ({ tags: { some: { tagId: id } } })),
      ];
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

  const result = await searchLibraryPapers({
    userId,
    queryText: search,
    where,
    sort:
      sort === "oldest" || sort === "title" || sort === "year" || sort === "engagement"
        ? sort
        : "newest",
    page,
    limit,
  });

  return NextResponse.json({
    papers: result.papers,
    total: result.total,
    page: result.page,
    totalPages: result.totalPages,
    degraded: result.degraded,
  });
}

export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    const body = await request.json();
    const data = createPaperSchema.parse(body);

    const resolved = await resolveEntityForImport({
      userId,
      title: data.title,
      doi: data.doi,
      arxivId: data.arxivId,
    });

    if (resolved.existingPaper) {
      return NextResponse.json(
        { error: "Paper already in library", existingPaperId: resolved.existingPaper.id },
        { status: 409 }
      );
    }

    let paper;
    try {
      paper = await createPaperWithAuthorIndex({
        data: {
          ...data,
          userId,
          authors: serializePaperAuthors(data.authors),
          processingStatus: data.fullText ? "TEXT_EXTRACTED" : "PENDING",
          referenceState: buildInitialReferenceState({
            filePath: data.filePath,
            fullText: data.fullText,
            processingStatus: data.fullText ? "TEXT_EXTRACTED" : "PENDING",
          }),
          entityId: resolved.entityId,
        },
      });
    } catch (error) {
      const existing = await handleDuplicatePaperError(error, userId, resolved.entityId);
      if (existing) {
        return NextResponse.json(
          { error: "Paper already in library", existingPaperId: existing.id },
          { status: 409 }
        );
      }
      throw error;
    }

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
