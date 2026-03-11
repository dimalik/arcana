import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

/**
 * POST /api/onboarding/import-seeds
 * Import selected papers from onboarding seed results into the user's library.
 */
export async function POST(req: NextRequest) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }

  const body = await req.json();
  const { papers } = body;

  if (!Array.isArray(papers) || papers.length === 0) {
    return NextResponse.json({ error: "papers array required" }, { status: 400 });
  }

  let imported = 0;

  for (const p of papers.slice(0, 20)) {
    if (!p.title) continue;

    // Check for duplicates by title (rough match)
    const existing = await prisma.paper.findFirst({
      where: {
        userId: user.id,
        title: { equals: p.title },
      },
    });
    if (existing) continue;

    await prisma.paper.create({
      data: {
        userId: user.id,
        title: p.title,
        abstract: p.abstract || null,
        authors: Array.isArray(p.authors) ? JSON.stringify(p.authors) : null,
        year: p.year ? parseInt(String(p.year)) : null,
        venue: p.venue || null,
        doi: p.doi || null,
        arxivId: p.arxivId || null,
        sourceType: p.arxivId ? "ARXIV" : "URL",
        sourceUrl: p.externalUrl || null,
        citationCount: p.citationCount ?? null,
        processingStatus: "PENDING",
      },
    });
    imported++;
  }

  return NextResponse.json({ imported });
}
