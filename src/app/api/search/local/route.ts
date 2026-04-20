import { NextRequest, NextResponse } from "next/server";

import { requireUserId } from "@/lib/paper-auth";
import searchModule from "@/lib/papers/search";
import { mergePaperVisibilityWhere } from "@/lib/papers/visibility";

export async function GET(request: NextRequest) {
  const userId = await requireUserId();
  const { searchParams } = new URL(request.url);
  const query = searchParams.get("q")?.trim() ?? "";

  if (query.length < 2) {
    return NextResponse.json({
      papers: [],
      authors: [],
      degraded: false,
    });
  }

  const result = await searchModule.searchLibraryEntities({
    userId,
    queryText: query,
    where: mergePaperVisibilityWhere(userId, {
      isResearchOnly: false,
    }),
    paperLimit: 5,
    authorLimit: 3,
  });

  return NextResponse.json({
    papers: result.papers.map((paper) => ({
      id: paper.id,
      title: paper.title,
      authors: paper.authors,
      year: paper.year,
    })),
    authors: result.authors.map((author) => ({
      id: author.id,
      name: author.name,
      paperCount: author.paperCount,
      topPaperTitles: author.topPaperTitles,
    })),
    degraded: result.degraded,
  });
}
