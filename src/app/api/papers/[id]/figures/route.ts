import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";
import { extractFigures, saveFiguresToMindPalace } from "@/lib/pdf/figure-extractor";

/**
 * GET — List extracted figures for a paper.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
) {
  await requireUserId();
  const { id } = params;

  const figures = await prisma.paperFigure.findMany({
    where: { paperId: id },
    orderBy: [{ pdfPage: "asc" }, { figureIndex: "asc" }],
  });

  return NextResponse.json(figures);
}

/**
 * POST — Extract figures from this paper's PDF.
 * Triggers the extraction pipeline (renders pages, analyzes with vision LLM).
 * Can be called multiple times — existing figures are upserted.
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
  if (!paper.filePath) {
    return NextResponse.json(
      { error: "No PDF file available for this paper" },
      { status: 400 },
    );
  }

  const body = await request.json().catch(() => ({}));
  const maxPages = body.maxPages || 30;
  const saveMindPalace = body.saveMindPalace !== false; // default true

  try {
    const figures = await extractFigures(id, { maxPages });

    let insightsCreated = 0;
    if (saveMindPalace && figures.length > 0) {
      insightsCreated = await saveFiguresToMindPalace(id, figures);
    }

    return NextResponse.json({
      ok: true,
      figuresExtracted: figures.length,
      insightsCreated,
      figures,
    });
  } catch (err) {
    console.error("[figures] Extraction error:", err);
    return NextResponse.json(
      { error: `Extraction failed: ${err instanceof Error ? err.message : "unknown"}` },
      { status: 500 },
    );
  }
}
