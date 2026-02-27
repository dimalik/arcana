import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/mind-palace/rooms - List rooms with insight counts
export async function GET() {
  const rooms = await prisma.mindPalaceRoom.findMany({
    orderBy: { name: "asc" },
    include: {
      _count: { select: { insights: true } },
    },
  });
  return NextResponse.json(rooms);
}

// POST /api/mind-palace/rooms - Create a room
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { name, description, color, icon } = body;

  if (!name || typeof name !== "string") {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  const existing = await prisma.mindPalaceRoom.findUnique({ where: { name } });
  if (existing) {
    return NextResponse.json({ error: "Room name already exists" }, { status: 409 });
  }

  const room = await prisma.mindPalaceRoom.create({
    data: {
      name,
      description: description || null,
      color: color || "#6366F1",
      icon: icon || "brain",
    },
  });

  return NextResponse.json(room, { status: 201 });
}
