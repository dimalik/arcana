import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { searchByTitle, isFigureOrSupplementDoi } from "@/lib/import/semantic-scholar";
import { titleSimilarity } from "@/lib/references/match";
import { logger } from "@/lib/logger";
import {
  jsonWithDuplicateState,
  paperAccessErrorToResponse,
  requirePaperAccess,
} from "@/lib/paper-auth";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const access = await requirePaperAccess(id, {
      mode: "mutate",
      select: { id: true, title: true, year: true },
    });
    const paper = access?.paper;

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

    // Guard: reject figure/supplement DOIs that slipped through search
    if (isFigureOrSupplementDoi({ doi: result.doi, title: result.title })) {
      logger.warn(`Rejected figure/supplement DOI for "${paper.title}": ${result.doi}`, {
        category: "import",
        metadata: { paperId: id, rejectedDoi: result.doi },
      });
      return NextResponse.json(
        { error: "Search returned a figure/supplement DOI, not the paper itself" },
        { status: 404 }
      );
    }

    // Guard: reject results with significantly different titles (wrong paper)
    const similarity = titleSimilarity(paper.title, result.title);
    if (similarity < 0.6) {
      logger.warn(`Rejected low-similarity match for "${paper.title}": "${result.title}" (score=${similarity.toFixed(2)})`, {
        category: "import",
        metadata: { paperId: id, matchedTitle: result.title, similarity },
      });
      return NextResponse.json(
        { error: `Best match title too different (similarity=${similarity.toFixed(2)})` },
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
      metadata: { paperId: id, source: result.source, fieldsUpdated: Object.keys(updateData), similarity },
    });

    return jsonWithDuplicateState(access, {
      updated: Object.keys(updateData),
      source: result.source ?? "unknown",
      similarity,
    });
  } catch (error) {
    const response = paperAccessErrorToResponse(error);
    if (response) return response;
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
