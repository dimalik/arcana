import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/mind-palace/stats
export async function GET() {
  const [totalInsights, totalRooms, dueCount, recentReviews] = await Promise.all([
    prisma.insight.count(),
    prisma.mindPalaceRoom.count(),
    prisma.insight.count({ where: { nextReviewAt: { lte: new Date() } } }),
    // Streak: count distinct days with reviews in the last 30 days
    prisma.insight.findMany({
      where: {
        lastReviewedAt: {
          not: null,
          gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        },
      },
      select: { lastReviewedAt: true },
      orderBy: { lastReviewedAt: "desc" },
    }),
  ]);

  // Calculate streak: consecutive days with at least one review ending today/yesterday
  const reviewDays = new Set(
    recentReviews
      .filter((r) => r.lastReviewedAt)
      .map((r) => r.lastReviewedAt!.toISOString().slice(0, 10)),
  );

  let streak = 0;
  const today = new Date();
  for (let i = 0; i < 30; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    if (reviewDays.has(key)) {
      streak++;
    } else if (i === 0) {
      // Today hasn't been reviewed yet, that's OK — check from yesterday
      continue;
    } else {
      break;
    }
  }

  return NextResponse.json({
    totalInsights,
    totalRooms,
    dueCount,
    streak,
  });
}
