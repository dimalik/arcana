import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

/**
 * GET — List all resource rules for a project.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;

    const project = await prisma.researchProject.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const rules = await prisma.resourceRule.findMany({
      where: { projectId: id },
      orderBy: { priority: "desc" },
    });

    return NextResponse.json({ rules });
  } catch (err) {
    console.error("[resource-rules] GET error:", err);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}

/**
 * POST — Create or update a resource rule.
 * Body: { pattern, runtime, reason?, needs?, priority? }
 */
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;
    const body = await request.json();
    const { pattern, runtime, reason, needs, priority } = body as {
      pattern: string;
      runtime: string;
      reason?: string;
      needs?: string[];
      priority?: number;
    };

    if (!pattern || !runtime) {
      return NextResponse.json({ error: "pattern and runtime required" }, { status: 400 });
    }

    if (!["local", "remote"].includes(runtime) && !runtime.startsWith("remote:")) {
      return NextResponse.json({ error: "runtime must be 'local', 'remote', or 'remote:<alias>'" }, { status: 400 });
    }

    const project = await prisma.researchProject.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const { upsertResourceRule } = await import("@/lib/research/resource-router");
    const ruleId = await upsertResourceRule(id, pattern, runtime, reason, needs, priority);

    return NextResponse.json({ ruleId });
  } catch (err) {
    console.error("[resource-rules] POST error:", err);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}

/**
 * DELETE — Remove a resource rule.
 * Body: { ruleId }
 */
export async function DELETE(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;
    const body = await request.json();
    const { ruleId } = body as { ruleId: string };

    const project = await prisma.researchProject.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

    await prisma.resourceRule.delete({ where: { id: ruleId } });

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[resource-rules] DELETE error:", err);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
