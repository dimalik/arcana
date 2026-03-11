import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requirePaperAccess } from "@/lib/paper-auth";

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; annotationId: string }> }
) {
  const { id, annotationId } = await params;
  const paper = await requirePaperAccess(id);
  if (!paper) {
    return NextResponse.json({ error: "Paper not found" }, { status: 404 });
  }

  const entry = await prisma.notebookEntry.findFirst({
    where: { id: annotationId, paperId: id, type: "selection" },
  });

  if (!entry) {
    return NextResponse.json(
      { error: "Annotation not found" },
      { status: 404 }
    );
  }

  const body = await request.json();
  const existingContent = entry.content ? JSON.parse(entry.content) : {};

  const updateData: Record<string, unknown> = {};

  if (body.note !== undefined) {
    updateData.annotation = body.note || null;
  }

  if (body.color !== undefined) {
    updateData.content = JSON.stringify({
      ...existingContent,
      color: body.color,
    });
  }

  const updated = await prisma.notebookEntry.update({
    where: { id: annotationId },
    data: updateData,
  });

  return NextResponse.json({
    id: updated.id,
    selectedText: updated.selectedText,
    annotation: updated.annotation,
    content: updated.content ? JSON.parse(updated.content) : null,
    createdAt: updated.createdAt,
  });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; annotationId: string }> }
) {
  const { id, annotationId } = await params;
  const paper = await requirePaperAccess(id);
  if (!paper) {
    return NextResponse.json({ error: "Paper not found" }, { status: 404 });
  }

  const entry = await prisma.notebookEntry.findFirst({
    where: { id: annotationId, paperId: id, type: "selection" },
  });

  if (!entry) {
    return NextResponse.json(
      { error: "Annotation not found" },
      { status: 404 }
    );
  }

  await prisma.notebookEntry.delete({ where: { id: annotationId } });

  return NextResponse.json({ success: true });
}
