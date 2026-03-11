import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";

export async function GET() {
  const userId = await requireUserId();

  // Top papers by engagement score (user's papers only)
  const topPapers = await prisma.paper.findMany({
    where: { userId, engagementScore: { gt: 0 } },
    orderBy: { engagementScore: "desc" },
    take: 20,
    select: {
      id: true,
      title: true,
      isLiked: true,
      engagementScore: true,
      authors: true,
      year: true,
    },
  });

  // Liked papers
  const likedPapers = await prisma.paper.findMany({
    where: { userId, isLiked: true },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      title: true,
      engagementScore: true,
      authors: true,
      year: true,
    },
  });

  // Recent engagement events (user's papers only)
  const recentEvents = await prisma.paperEngagement.findMany({
    where: { paper: { userId } },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      paper: {
        select: { id: true, title: true },
      },
    },
  });

  // Event counts by type (user's papers only)
  const eventCounts = await prisma.paperEngagement.groupBy({
    by: ["event"],
    where: { paper: { userId } },
    _count: { event: true },
  });

  return NextResponse.json({
    topPapers,
    likedPapers,
    recentEvents,
    eventCounts: eventCounts.map((e) => ({
      event: e.event,
      count: e._count.event,
    })),
  });
}
