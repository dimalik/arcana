import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";

/**
 * GET /api/research/memories — List all process memories for the current user
 */
export async function GET() {
  const userId = await requireUserId();

  const memories = await prisma.agentMemory.findMany({
    where: { userId },
    orderBy: [{ usageCount: "desc" }, { createdAt: "desc" }],
  });

  return NextResponse.json(memories);
}

/**
 * POST /api/research/memories — Add a manual lesson
 * Body: { category, lesson, context? }
 */
export async function POST(request: NextRequest) {
  const userId = await requireUserId();
  const body = await request.json();
  const { category, lesson, context } = body;

  if (!category || !lesson) {
    return NextResponse.json({ error: "category and lesson are required" }, { status: 400 });
  }

  const memory = await prisma.agentMemory.create({
    data: {
      userId,
      category,
      lesson: lesson.slice(0, 1000),
      context: context?.slice(0, 500) || null,
    },
  });

  return NextResponse.json(memory, { status: 201 });
}

/**
 * DELETE /api/research/memories — Delete a memory by ID
 * Body: { id }
 */
export async function DELETE(request: NextRequest) {
  const userId = await requireUserId();
  const { id } = await request.json();

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const memory = await prisma.agentMemory.findFirst({
    where: { id, userId },
  });
  if (!memory) {
    return NextResponse.json({ error: "Memory not found" }, { status: 404 });
  }

  await prisma.agentMemory.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
