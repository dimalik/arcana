import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// PATCH /api/mind-palace/insights/[insightId] - Edit notes, move room
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ insightId: string }> },
) {
  const { insightId } = await params;
  const body = await req.json();
  const { userNotes, roomId } = body;

  const data: Record<string, unknown> = {};
  if (userNotes !== undefined) data.userNotes = userNotes;
  if (roomId !== undefined) data.roomId = roomId;

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
  const { insightId } = await params;
  await prisma.insight.delete({ where: { id: insightId } });
  return NextResponse.json({ success: true });
}
