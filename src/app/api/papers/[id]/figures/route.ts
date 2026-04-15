import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";
import { extractAllFigures } from "@/lib/figures/extract-all-figures";

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
  await requireUserId();
  const { id } = params;
  const showAll = request.nextUrl.searchParams.get("all") === "true";

  const figures = await prisma.paperFigure.findMany({
    where: {
      paperId: id,
      ...(showAll ? {} : { isPrimaryExtraction: true }),
    },
    orderBy: [{ pdfPage: "asc" }, { figureIndex: "asc" }],
  });

  return NextResponse.json(figures);
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
  await requireUserId();
  const { id } = params;

  const paper = await prisma.paper.findUnique({
    where: { id },
    select: { id: true, filePath: true, title: true },
  });

  if (!paper) {
    return NextResponse.json({ error: "Paper not found" }, { status: 404 });
  }

  const body = await request.json().catch(() => ({}));
  const maxPages = body.maxPages || 30;

  try {
    const report = await extractAllFigures(id, { maxPages });

    return NextResponse.json(
      { ok: report.persistErrors === 0, ...report },
      { status: report.persistErrors > 0 ? 207 : 200 },
    );
  } catch (err) {
    console.error("[figures] Extraction error:", err);
    return NextResponse.json(
      { error: `Extraction failed: ${err instanceof Error ? err.message : "unknown"}` },
      { status: 500 },
    );
  }
}
