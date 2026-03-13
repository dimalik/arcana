import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";

// PATCH /api/mind-palace/insights/[insightId] - Edit notes, move room
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ insightId: string }> },
) {
  const userId = await requireUserId();
  const { insightId } = await params;
  const existing = await prisma.insight.findFirst({
    where: { id: insightId, paper: { userId } },
  });
  if (!existing) {
    return NextResponse.json({ error: "Insight not found" }, { status: 404 });
  }
  const body = await req.json();
  const { userNotes, roomId, learning, significance, applications } = body;

  const data: Record<string, unknown> = {};
  if (userNotes !== undefined) data.userNotes = userNotes;
  if (roomId !== undefined) data.roomId = roomId;
  if (learning !== undefined) data.learning = learning;
  if (significance !== undefined) data.significance = significance;
  if (applications !== undefined) data.applications = applications;

  const insight = await prisma.insight.update({
    where: { id: insightId },
    data,
  });

  return NextResponse.json(insight);
}

// DELETE /api/mind-palace/insights/[insightId]
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ insightId: string }> },
) {
  const userId = await requireUserId();
  const { insightId } = await params;
  const existing = await prisma.insight.findFirst({
    where: { id: insightId, paper: { userId } },
  });
  if (!existing) {
    return NextResponse.json({ error: "Insight not found" }, { status: 404 });
  }
  await prisma.insight.delete({ where: { id: insightId } });
  return NextResponse.json({ success: true });
}
