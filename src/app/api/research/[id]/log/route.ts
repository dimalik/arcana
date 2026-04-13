import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";
import { parseHelpRequestMetadata, refreshProjectHelpRequests } from "@/lib/research/help-requests";
import { cleanupStaleJobs } from "@/lib/research/remote-executor";

type Params = { params: Promise<{ id: string }> };

// POST — Add a log entry
export async function POST(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;
    const body = await request.json();

    const project = await prisma.researchProject.findFirst({
      where: { id, userId },
    });
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const entry = await prisma.researchLogEntry.create({
      data: {
        projectId: id,
        type: body.type || "user_note",
        content: body.content,
        metadata: body.metadata ? JSON.stringify(body.metadata) : null,
      },
    });

    return NextResponse.json(entry, { status: 201 });
  } catch (err) {
    console.error("[api/research/log] POST error:", err);
    return NextResponse.json({ error: "Failed to add log entry" }, { status: 500 });
  }
}

// PATCH — Update a log entry's metadata (e.g. mark as resolved)
export async function PATCH(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;
    const body = await request.json();
    const { entryId, metadata } = body;

    if (!entryId || !metadata) {
      return NextResponse.json({ error: "entryId and metadata required" }, { status: 400 });
    }

    const project = await prisma.researchProject.findFirst({
      where: { id, userId },
    });
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    // Fetch existing entry to merge metadata
    const existing = await prisma.researchLogEntry.findFirst({
      where: { id: entryId, projectId: id },
    });
    if (!existing) {
      return NextResponse.json({ error: "Log entry not found" }, { status: 404 });
    }

    let existingMeta: Record<string, unknown> = {};
    try { existingMeta = JSON.parse(existing.metadata || "{}"); } catch { /* */ }

    if (existing.type === "help_request" && metadata.resolved === true) {
      const helpMeta = parseHelpRequestMetadata(existing.metadata);
      if (helpMeta.resolutionPolicy === "system" || helpMeta.resolutionPolicy === "executor" || helpMeta.requiresUserAction === false) {
        return NextResponse.json(
          { error: "This issue is resolved by the system, not by manual acknowledgement." },
          { status: 409 },
        );
      }
    }

    const merged = { ...existingMeta, ...metadata };

    const updated = await prisma.researchLogEntry.update({
      where: { id: entryId },
      data: { metadata: JSON.stringify(merged) },
    });

    return NextResponse.json(updated);
  } catch (err) {
    console.error("[api/research/log] PATCH error:", err);
    return NextResponse.json({ error: "Failed to update log entry" }, { status: 500 });
  }
}

// GET — List log entries (paginated, filterable by type)
export async function GET(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;
    const { searchParams } = new URL(request.url);
    const type = searchParams.get("type");
    const limit = parseInt(searchParams.get("limit") || "50");
    const offset = parseInt(searchParams.get("offset") || "0");

    const project = await prisma.researchProject.findFirst({
      where: { id, userId },
    });
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    if (type === "help_request") {
      try {
        await cleanupStaleJobs(id);
      } catch (err) {
        console.warn("[api/research/log] stale cleanup error:", err);
      }
      try {
        await refreshProjectHelpRequests(id);
      } catch (err) {
        console.warn("[api/research/log] help request refresh error:", err);
      }
    }

    const where: Record<string, unknown> = { projectId: id };
    if (type) where.type = type;

    const [entries, total] = await Promise.all([
      prisma.researchLogEntry.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      prisma.researchLogEntry.count({ where }),
    ]);

    return NextResponse.json({ entries, total });
  } catch (err) {
    console.error("[api/research/log] GET error:", err);
    return NextResponse.json({ error: "Failed to fetch log" }, { status: 500 });
  }
}
