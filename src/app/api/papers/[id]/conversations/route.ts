import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requirePaperAccess } from "@/lib/paper-auth";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const paper = await requirePaperAccess(id);
  if (!paper) {
    return NextResponse.json({ error: "Paper not found" }, { status: 404 });
  }

  const conversations = await prisma.conversation.findMany({
    where: { paperId: id },
    orderBy: { updatedAt: "desc" },
    include: {
      _count: {
        select: { messages: { where: { role: "assistant" } } },
      },
      messages: {
        where: { role: "assistant" },
        orderBy: { createdAt: "asc" },
        take: 1,
        select: { content: true },
      },
    },
  });

  return NextResponse.json(conversations);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const paper = await requirePaperAccess(id);
  if (!paper) {
    return NextResponse.json({ error: "Paper not found" }, { status: 404 });
  }
  const body = await request.json().catch(() => ({}));
  const title = body.title || null;
  const selectedText = body.selectedText || null;
  const mode = body.mode || null;

  const conversation = await prisma.conversation.create({
    data: {
      paperId: id,
      title,
      selectedText,
      mode,
    },
  });

  return NextResponse.json(
    { id: conversation.id, title: conversation.title },
    { status: 201 }
  );
}
