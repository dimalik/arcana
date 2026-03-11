import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";

/**
 * GET /api/discovery/[sessionId] — Get session details + proposals
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const userId = await requireUserId();
  const { sessionId } = await params;

  const session = await prisma.discoverySession.findFirst({
    where: { id: sessionId, userId },
    include: {
      seedPapers: {
        include: {
          paper: { select: { id: true, title: true } },
        },
      },
      proposals: {
        orderBy: { citationCount: { sort: "desc", nulls: "last" } },
      },
    },
  });

  if (!session) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  return Response.json({
    id: session.id,
    title: session.title,
    status: session.status,
    depth: session.depth,
    totalFound: session.totalFound,
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
      importedPaperId: p.importedPaperId,
      createdAt: p.createdAt,
    })),
  });
}

/**
 * DELETE /api/discovery/[sessionId] — Delete a session and its proposals
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const userId = await requireUserId();
  const { sessionId } = await params;

  const session = await prisma.discoverySession.findFirst({
    where: { id: sessionId, userId },
  });

  if (!session) {
    return Response.json({ error: "Session not found" }, { status: 404 });
  }

  await prisma.discoverySession.delete({ where: { id: sessionId } });

  return Response.json({ success: true });
}
