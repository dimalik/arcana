import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { calculateSM2 } from "@/lib/mind-palace/spaced-repetition";
import { requireUserId } from "@/lib/paper-auth";

// POST /api/mind-palace/review/[insightId] - Submit rating
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ insightId: string }> },
) {
  const userId = await requireUserId();
  const { insightId } = await params;
  const body = await req.json();
  const { rating } = body;

  if (typeof rating !== "number" || rating < 1 || rating > 5) {
    return NextResponse.json({ error: "Rating must be 1-5" }, { status: 400 });
  }

  const insight = await prisma.insight.findFirst({
    where: { id: insightId, paper: { userId } },
  });

  if (!insight) {
    return NextResponse.json({ error: "Insight not found" }, { status: 404 });
  }

  const result = calculateSM2(rating, {
    easeFactor: insight.easeFactor,
    interval: insight.interval,
    repetitions: insight.repetitions,
    nextReviewAt: insight.nextReviewAt,
  });

  const updated = await prisma.insight.update({
    where: { id: insightId },
    data: {
      easeFactor: result.easeFactor,
      interval: result.interval,
      repetitions: result.repetitions,
      nextReviewAt: result.nextReviewAt,
      lastReviewedAt: result.lastReviewedAt,
    },
  });

  return NextResponse.json(updated);
}
