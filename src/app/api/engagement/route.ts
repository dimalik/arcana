import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  // Top papers by engagement score
  const topPapers = await prisma.paper.findMany({
    where: { engagementScore: { gt: 0 } },
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
    where: { isLiked: true },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      title: true,
      engagementScore: true,
      authors: true,
      year: true,
    },
  });

  // Recent engagement events (last 50)
  const recentEvents = await prisma.paperEngagement.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      paper: {
        select: { id: true, title: true },
      },
    },
  });

  // Event counts by type
  const eventCounts = await prisma.paperEngagement.groupBy({
    by: ["event"],
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
