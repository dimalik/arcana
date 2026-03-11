import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";
import { requireUserId } from "@/lib/paper-auth";

const createEntrySchema = z.object({
  paperId: z.string().min(1),
  type: z.enum(["selection", "explanation", "chat", "note"]),
  selectedText: z.string().optional(),
  content: z.string().optional(),
  annotation: z.string().optional(),
  conversationId: z.string().optional(),
  messageId: z.string().optional(),
});

export async function GET(request: NextRequest) {
  const userId = await requireUserId();
  const { searchParams } = new URL(request.url);
  const paperId = searchParams.get("paperId");
  const type = searchParams.get("type");

  const where: Record<string, unknown> = { paper: { userId } };
  if (paperId) where.paperId = paperId;
  if (type) where.type = type;

  const entries = await prisma.notebookEntry.findMany({
    where,
    include: {
      paper: { select: { id: true, title: true, authors: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(entries);
}

export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    const body = await request.json();
    const data = createEntrySchema.parse(body);

    // Verify the paper belongs to the user
    const paper = await prisma.paper.findFirst({
      where: { id: data.paperId, userId },
    });
    if (!paper) {
      return NextResponse.json({ error: "Paper not found" }, { status: 404 });
    }

    const entry = await prisma.notebookEntry.create({
      data,
      include: {
        paper: { select: { id: true, title: true, authors: true } },
      },
    });

    return NextResponse.json(entry, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation error", details: error.issues },
        { status: 400 }
      );
    }
    console.error("Create notebook entry error:", error);
    return NextResponse.json(
      { error: "Failed to create notebook entry" },
      { status: 500 }
    );
  }
}
