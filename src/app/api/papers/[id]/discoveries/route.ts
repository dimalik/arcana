import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { jsonWithDuplicateState, requirePaperAccess } from "@/lib/paper-auth";

/**
 * GET /api/papers/[id]/discoveries
 *
 * Returns all discovery proposals from sessions where this paper was a seed,
 * grouped by session. Includes proposal metadata and import status.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const access = await requirePaperAccess(id, { mode: "read" });
  if (!access) {
    return NextResponse.json({ error: "Paper not found" }, { status: 404 });
  }

  // Find all sessions where this paper was used as a seed
  const seeds = await prisma.discoverySeed.findMany({
    where: { paperId: id },
    select: { sessionId: true },
  });

  if (seeds.length === 0) {
    return jsonWithDuplicateState(access, []);
  }

  const sessionIds = seeds.map((s) => s.sessionId);

  // Fetch sessions with their proposals
  const sessions = await prisma.discoverySession.findMany({
    where: { id: { in: sessionIds } },
    include: {
      proposals: {
        orderBy: { citationCount: "desc" },
        include: {
          importedPaper: {
            select: { id: true, title: true },
          },
        },
      },
      seedPapers: {
        include: {
          paper: {
            select: { id: true, title: true },
          },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  // Flatten: return proposals with session context
  const result = sessions.map((session) => ({
    sessionId: session.id,
    title: session.title,
    status: session.status,
    createdAt: session.createdAt,
    seedPapers: session.seedPapers.map((sp) => ({
      id: sp.paper.id,
      title: sp.paper.title,
    })),
    proposals: session.proposals.map((p) => ({
      id: p.id,
      title: p.title,
      authors: p.authors,
      year: p.year,
      venue: p.venue,
      doi: p.doi,
      arxivId: p.arxivId,
      externalUrl: p.externalUrl,
      citationCount: p.citationCount,
      openAccessPdfUrl: p.openAccessPdfUrl,
      semanticScholarId: p.semanticScholarId,
      reason: p.reason,
      status: p.status,
      importedPaper: p.importedPaper,
    })),
  }));

  return jsonWithDuplicateState(access, result);
}
