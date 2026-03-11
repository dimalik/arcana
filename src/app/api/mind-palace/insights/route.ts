import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";

// GET /api/mind-palace/insights?roomId=&paperId=&due=true
export async function GET(req: NextRequest) {
  const userId = await requireUserId();
  const { searchParams } = new URL(req.url);
  const roomId = searchParams.get("roomId");
  const paperId = searchParams.get("paperId");
  const due = searchParams.get("due");

  const where: Record<string, unknown> = { paper: { userId } };
  if (roomId) where.roomId = roomId;
  if (paperId) where.paperId = paperId;
  if (due === "true") where.nextReviewAt = { lte: new Date() };

  const insights = await prisma.insight.findMany({
    where,
    orderBy: { nextReviewAt: "asc" },
    include: {
      paper: { select: { id: true, title: true } },
      room: { select: { id: true, name: true, color: true, icon: true } },
    },
  });

  return NextResponse.json(insights);
}
