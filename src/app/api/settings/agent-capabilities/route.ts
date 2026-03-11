import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";

/**
 * GET — List all agent capabilities for the current user.
 */
export async function GET() {
  try {
    const userId = await requireUserId();
    const capabilities = await prisma.agentCapability.findMany({
      where: { userId },
      orderBy: { createdAt: "asc" },
    });
    return NextResponse.json(capabilities);
  } catch (err) {
    console.error("[agent-capabilities] GET error:", err);
    return NextResponse.json({ error: "Failed to load capabilities" }, { status: 500 });
  }
}

/**
 * POST — Create a new agent capability.
 * Body: { name, description, instructions }
 */
export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    const body = await request.json();
    const { name, description, instructions } = body;

    if (!name || !instructions) {
      return NextResponse.json({ error: "Name and instructions are required" }, { status: 400 });
    }

    const capability = await prisma.agentCapability.create({
      data: {
        userId,
        name: name.slice(0, 100),
        description: (description || "").slice(0, 500),
        instructions: instructions.slice(0, 5000),
      },
    });

    return NextResponse.json(capability);
  } catch (err) {
    console.error("[agent-capabilities] POST error:", err);
    return NextResponse.json({ error: "Failed to create capability" }, { status: 500 });
  }
}

/**
 * PUT — Update an existing capability.
 * Body: { id, name?, description?, instructions?, enabled? }
 */
export async function PUT(request: NextRequest) {
  try {
    const userId = await requireUserId();
    const body = await request.json();
    const { id, ...updates } = body;

    if (!id) {
      return NextResponse.json({ error: "ID is required" }, { status: 400 });
    }

    // Verify ownership
    const existing = await prisma.agentCapability.findFirst({
      where: { id, userId },
    });
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const data: Record<string, unknown> = {};
    if (updates.name !== undefined) data.name = updates.name.slice(0, 100);
    if (updates.description !== undefined) data.description = updates.description.slice(0, 500);
    if (updates.instructions !== undefined) data.instructions = updates.instructions.slice(0, 5000);
    if (updates.enabled !== undefined) data.enabled = Boolean(updates.enabled);

    const updated = await prisma.agentCapability.update({
      where: { id },
      data,
    });

    return NextResponse.json(updated);
  } catch (err) {
    console.error("[agent-capabilities] PUT error:", err);
    return NextResponse.json({ error: "Failed to update" }, { status: 500 });
  }
}

/**
 * DELETE — Remove a capability.
 * Body: { id }
 */
export async function DELETE(request: NextRequest) {
  try {
    const userId = await requireUserId();
    const body = await request.json();
    const { id } = body;

    if (!id) {
      return NextResponse.json({ error: "ID is required" }, { status: 400 });
    }

    const existing = await prisma.agentCapability.findFirst({
      where: { id, userId },
    });
    if (!existing) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    await prisma.agentCapability.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[agent-capabilities] DELETE error:", err);
    return NextResponse.json({ error: "Failed to delete" }, { status: 500 });
  }
}
