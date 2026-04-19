import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  jsonWithDuplicateState,
  paperAccessErrorToResponse,
  requirePaperAccess,
} from "@/lib/paper-auth";
import { extractAllFigures } from "@/lib/figures/extract-all-figures";
import {
  FIGURE_VIEW_SELECT,
  mapPaperFiguresToView,
} from "@/lib/figures/read-model";

/**
 * GET — List extracted figures for a paper.
 *
 * By default returns only canonical (isPrimaryExtraction=true) figures.
 * Pass ?all=true to include alternate extraction attempts.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const { id } = params;
  const access = await requirePaperAccess(id, { mode: "read" });
  if (!access) {
    return NextResponse.json({ error: "Paper not found" }, { status: 404 });
  }
  const showAll = request.nextUrl.searchParams.get("all") === "true";

  const figures = await prisma.paperFigure.findMany({
    select: FIGURE_VIEW_SELECT,
    where: {
      paperId: id,
      ...(showAll ? {} : { isPrimaryExtraction: true }),
    },
    orderBy: [{ pdfPage: "asc" }, { figureIndex: "asc" }],
  });

  return jsonWithDuplicateState(access, mapPaperFiguresToView(figures));
}

/**
 * POST — Extract figures from all available sources for this paper.
 *
 * Runs the unified extraction pipeline:
 *   PMC/JATS → arXiv HTML → Publisher HTML → PDF fallback
 * Results are merged by figure identity and written to PaperFigure.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  try {
    const { id } = params;
    const access = await requirePaperAccess(id, { mode: "mutate" });
    if (!access) {
      return NextResponse.json({ error: "Paper not found" }, { status: 404 });
    }

    const body = await request.json().catch(() => ({} as Record<string, unknown>));
    const maxPages = typeof body.maxPages === "number" ? body.maxPages : undefined;

    const report = await extractAllFigures(id, { context: "route", maxPages });
    const status =
      report.status === "conflict"
        ? 409
        : report.status === "partial"
          ? 207
          : 200;

    return NextResponse.json(
      { ok: report.status === "success", ...report },
      { status },
    );
  } catch (err) {
    const response = paperAccessErrorToResponse(err);
    if (response) return response;
    console.error("[figures] Extraction error:", err);
    return NextResponse.json(
      { error: `Extraction failed: ${err instanceof Error ? err.message : "unknown"}` },
      { status: 500 },
    );
  }
}
