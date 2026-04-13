import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";
import { transitionClaimMemory } from "@/lib/research/claim-ledger";

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
 * PATCH /api/research/memories — Update a memory
 * Body: { id, lesson?, category?, context?, status? }
 */
export async function PATCH(request: NextRequest) {
  const userId = await requireUserId();
  const body = await request.json();
  const { id, lesson, category, context, status } = body;

  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const memory = await prisma.agentMemory.findFirst({
    where: { id, userId },
  });
  if (!memory) {
    return NextResponse.json({ error: "Memory not found" }, { status: 404 });
  }

  if (status !== undefined) {
    try {
      const updated = memory.sourceClaimId
        ? await transitionClaimMemory({
            memoryId: id,
            userId,
            status,
          })
        : await prisma.agentMemory.update({
            where: { id },
            data: { status },
          });
      return NextResponse.json(updated);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to update memory status";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  }

  const data: Record<string, unknown> = {};
  if (lesson !== undefined) data.lesson = lesson.slice(0, 1000);
  if (category !== undefined) data.category = category;
  if (context !== undefined) data.context = context?.slice(0, 500) || null;

  const updated = await prisma.agentMemory.update({
    where: { id },
    data,
  });

  return NextResponse.json(updated);
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
