import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { searchByTitle } from "@/lib/import/semantic-scholar";
import { logger } from "@/lib/logger";
import { requireUserId } from "@/lib/paper-auth";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await requireUserId();
    const { id } = await params;

    const paper = await prisma.paper.findFirst({
      where: { id, userId },
      select: { id: true, title: true, year: true },
    });

    if (!paper) {
      return NextResponse.json({ error: "Paper not found" }, { status: 404 });
    }

    const result = await searchByTitle(paper.title, paper.year);

    if (!result) {
      return NextResponse.json(
        { error: "No metadata found from external sources" },
        { status: 404 }
      );
    }

    const updateData: Record<string, unknown> = {};
    if (result.abstract) updateData.abstract = result.abstract;
    if (result.authors?.length) updateData.authors = JSON.stringify(result.authors);
    if (result.year) updateData.year = result.year;
    if (result.venue) updateData.venue = result.venue;
    if (result.doi) updateData.doi = result.doi;
    if (result.arxivId) updateData.arxivId = result.arxivId;
    if (result.citationCount != null) updateData.citationCount = result.citationCount;
    if (result.externalUrl) updateData.sourceUrl = result.externalUrl;
    if (Object.keys(updateData).length > 0) {
      await prisma.paper.update({ where: { id }, data: updateData });
    }

    logger.info(`Re-fetched metadata for "${paper.title}"`, {
      category: "import",
      metadata: { paperId: id, source: result.source, fieldsUpdated: Object.keys(updateData) },
    });

    return NextResponse.json({
      updated: Object.keys(updateData),
      source: result.source ?? "unknown",
    });
  } catch (error) {
    logger.error("Failed to re-fetch metadata", {
      category: "api",
      error,
    });
    return NextResponse.json(
      { error: "Failed to re-fetch metadata" },
      { status: 500 }
    );
  }
}
