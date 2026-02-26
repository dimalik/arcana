import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; convId: string }> }
) {
  const { convId } = await params;

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

  return NextResponse.json(conversation);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; convId: string }> }
) {
  const { convId } = await params;
  const body = await request.json();
  const { title, addPaperIds, removePaperIds } = body;

  if (title !== undefined) {
    await prisma.conversation.update({
      where: { id: convId },
      data: { title },
    });
  }

  if (addPaperIds?.length) {
    for (const paperId of addPaperIds) {
      await prisma.conversationPaper
        .create({ data: { conversationId: convId, paperId } })
        .catch(() => {}); // skip duplicates
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
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; convId: string }> }
) {
  const { convId } = await params;

  await prisma.conversation.delete({ where: { id: convId } });

  return new Response(null, { status: 204 });
}
