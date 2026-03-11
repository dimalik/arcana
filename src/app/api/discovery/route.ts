import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { runDiscovery } from "@/lib/discovery/engine";
import { trackEngagement } from "@/lib/engagement/track";
import { requireUserId } from "@/lib/paper-auth";

/**
 * POST /api/discovery — Start a new discovery session
 * Body: { paperIds: string[], depth?: number }
 * Returns streamed NDJSON with progress events.
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { paperIds, depth = 1 } = body;

  if (!Array.isArray(paperIds) || paperIds.length === 0) {
    return Response.json(
      { error: "paperIds must be a non-empty array" },
      { status: 400 }
    );
  }

  const userId = await requireUserId();

  // Verify all papers exist and belong to user
  const papers = await prisma.paper.findMany({
    where: { id: { in: paperIds }, userId },
    select: { id: true, title: true },
  });

  if (papers.length !== paperIds.length) {
    return Response.json(
      { error: "One or more paper IDs not found" },
      { status: 404 }
    );
  }

  // Create session + seeds
  const title = papers.map((p) => p.title).join(", ");
  const session = await prisma.discoverySession.create({
    data: {
      userId,
      title: title.length > 200 ? title.slice(0, 197) + "..." : title,
      depth,
      seedPapers: {
        create: paperIds.map((paperId: string) => ({ paperId })),
      },
    },
  });

  // Track engagement for each seed paper
  for (const paperId of paperIds) {
    trackEngagement(paperId, "discovery_seed").catch(() => {});
  }

  // Stream discovery progress
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // Send session ID first
      controller.enqueue(
        encoder.encode(
          JSON.stringify({ type: "session", sessionId: session.id }) + "\n"
        )
      );

      for await (const event of runDiscovery(session.id, paperIds, depth, userId)) {
        controller.enqueue(
          encoder.encode(JSON.stringify(event) + "\n")
        );
      }

      controller.close();
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Transfer-Encoding": "chunked",
    },
  });
}

/**
 * GET /api/discovery — List user's sessions
 */
export async function GET() {
  const userId = await requireUserId();

  const sessions = await prisma.discoverySession.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    include: {
      seedPapers: {
        include: {
          paper: { select: { id: true, title: true } },
        },
      },
      _count: {
        select: { proposals: true },
      },
    },
  });

  // Also get imported counts per session
  const sessionsWithCounts = await Promise.all(
    sessions.map(async (s) => {
      const importedCount = await prisma.discoveryProposal.count({
        where: { sessionId: s.id, status: "IMPORTED" },
      });
      const pendingCount = await prisma.discoveryProposal.count({
        where: { sessionId: s.id, status: "PENDING" },
      });
      return {
        id: s.id,
        title: s.title,
        status: s.status,
        depth: s.depth,
        totalFound: s.totalFound,
        createdAt: s.createdAt,
        seedPapers: s.seedPapers.map((sp) => ({
          id: sp.paper.id,
          title: sp.paper.title,
        })),
        proposalCount: s._count.proposals,
        importedCount,
        pendingCount,
      };
    })
  );

  return Response.json(sessionsWithCounts);
}
