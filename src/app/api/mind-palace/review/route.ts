import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";

// GET /api/mind-palace/review - Due insights (nextReviewAt <= now)
export async function GET() {
  const userId = await requireUserId();
  const insights = await prisma.insight.findMany({
    where: { nextReviewAt: { lte: new Date() }, paper: { userId } },
    orderBy: { nextReviewAt: "asc" },
    include: {
      paper: { select: { id: true, title: true } },
      room: { select: { id: true, name: true, color: true, icon: true } },
    },
  });

  return NextResponse.json(insights);
}
