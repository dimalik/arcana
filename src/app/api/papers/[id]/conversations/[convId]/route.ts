import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  jsonWithDuplicateState,
  paperAccessErrorToResponse,
  requirePaperAccess,
} from "@/lib/paper-auth";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; convId: string }> }
) {
  const { id, convId } = await params;
  const access = await requirePaperAccess(id, { mode: "read" });
  if (!access) {
    return NextResponse.json({ error: "Paper not found" }, { status: 404 });
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: convId },
    include: {
      additionalPapers: {
        include: { paper: { select: { id: true, title: true } } },
      },
    },
  });

  if (!conversation) {
    return NextResponse.json(
      { error: "Conversation not found" },
      { status: 404 }
    );
  }

  return jsonWithDuplicateState(access, conversation);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; convId: string }> }
) {
  try {
    const { id: paperId, convId } = await params;
    const access = await requirePaperAccess(paperId, { mode: "mutate" });
    if (!access) {
      return NextResponse.json({ error: "Paper not found" }, { status: 404 });
    }
    const body = await request.json();
    const { title, addPaperIds, removePaperIds } = body;

    if (title !== undefined) {
      await prisma.conversation.update({
        where: { id: convId },
        data: { title },
      });
    }

    if (addPaperIds?.length) {
      for (const relatedPaperId of addPaperIds) {
        await prisma.conversationPaper
          .create({ data: { conversationId: convId, paperId: relatedPaperId } })
          .catch(() => {});
      }
    }

    if (removePaperIds?.length) {
      await prisma.conversationPaper.deleteMany({
        where: {
          conversationId: convId,
          paperId: { in: removePaperIds },
        },
      });
    }

    const updated = await prisma.conversation.findUnique({
      where: { id: convId },
      include: {
        additionalPapers: {
          include: { paper: { select: { id: true, title: true } } },
        },
      },
    });

    return NextResponse.json(updated);
  } catch (error) {
    const response = paperAccessErrorToResponse(error);
    if (response) return response;
    throw error;
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; convId: string }> }
) {
  try {
    const { id: paperId, convId } = await params;
    const access = await requirePaperAccess(paperId, { mode: "mutate" });
    if (!access) {
      return NextResponse.json({ error: "Paper not found" }, { status: 404 });
    }

    await prisma.conversation.delete({ where: { id: convId } });

    return new Response(null, { status: 204 });
  } catch (error) {
    const response = paperAccessErrorToResponse(error);
    if (response) return response;
    throw error;
  }
}
