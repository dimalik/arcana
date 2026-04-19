import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { trackEngagement } from "@/lib/engagement/track";
import {
  jsonWithDuplicateState,
  paperAccessErrorToResponse,
  requirePaperAccess,
} from "@/lib/paper-auth";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const access = await requirePaperAccess(id, { mode: "read" });
  if (!access) {
    return NextResponse.json({ error: "Paper not found" }, { status: 404 });
  }

  const entries = await prisma.notebookEntry.findMany({
    where: { paperId: id, type: { in: ["selection", "screenshot"] } },
    orderBy: { createdAt: "asc" },
  });

  const annotations = entries.map((e) => ({
    id: e.id,
    selectedText: e.selectedText,
    annotation: e.annotation,
    content: e.content ? JSON.parse(e.content) : null,
    createdAt: e.createdAt,
  }));

  return jsonWithDuplicateState(access, annotations);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const access = await requirePaperAccess(id, { mode: "mutate" });
    if (!access) {
      return NextResponse.json({ error: "Paper not found" }, { status: 404 });
    }

    const body = await request.json();
    const { selectedText, note, pageNumber, rects, color } = body;

    if (!selectedText) {
      return NextResponse.json(
        { error: "selectedText is required" },
        { status: 400 }
      );
    }

    const entry = await prisma.notebookEntry.create({
      data: {
        paperId: id,
        type: "selection",
        selectedText,
        annotation: note || null,
        content: JSON.stringify({ pageNumber, rects, color: color || "yellow" }),
      },
    });

    trackEngagement(id, "annotate").catch(() => {});

    return NextResponse.json(
      {
        id: entry.id,
        selectedText: entry.selectedText,
        annotation: entry.annotation,
        content: entry.content ? JSON.parse(entry.content) : null,
        createdAt: entry.createdAt,
      },
      { status: 201 }
    );
  } catch (error) {
    const response = paperAccessErrorToResponse(error);
    if (response) return response;
    throw error;
  }
}
