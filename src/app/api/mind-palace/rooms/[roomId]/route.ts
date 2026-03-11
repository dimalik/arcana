import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";

// GET /api/mind-palace/rooms/[roomId] - Room with its insights
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const userId = await requireUserId();
  const { roomId } = await params;
  const room = await prisma.mindPalaceRoom.findUnique({
    where: { id: roomId },
    include: {
      insights: {
        where: { paper: { userId } },
        orderBy: { createdAt: "desc" },
        include: { paper: { select: { id: true, title: true } } },
      },
    },
  });

  if (!room) {
    return NextResponse.json({ error: "Room not found" }, { status: 404 });
  }

  return NextResponse.json(room);
}

// PATCH /api/mind-palace/rooms/[roomId] - Update room
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await params;
  const body = await req.json();
  const { name, description, color, icon } = body;

  const data: Record<string, unknown> = {};
  if (name !== undefined) data.name = name;
  if (description !== undefined) data.description = description;
  if (color !== undefined) data.color = color;
  if (icon !== undefined) data.icon = icon;

  const room = await prisma.mindPalaceRoom.update({
    where: { id: roomId },
    data,
  });

  return NextResponse.json(room);
}

// DELETE /api/mind-palace/rooms/[roomId] - Delete room + cascade
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ roomId: string }> },
) {
  const { roomId } = await params;
  await prisma.mindPalaceRoom.delete({ where: { id: roomId } });
  return NextResponse.json({ success: true });
}
