import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requirePaperAccess } from "@/lib/paper-auth";

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const paper = await requirePaperAccess(params.id);
  if (!paper) {
    return NextResponse.json({ error: "Paper not found" }, { status: 404 });
  }
  const paperTags = await prisma.paperTag.findMany({
    where: { paperId: params.id },
    include: { tag: true },
  });
  return NextResponse.json(paperTags.map((pt) => pt.tag));
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const paper = await requirePaperAccess(params.id);
  if (!paper) {
    return NextResponse.json({ error: "Paper not found" }, { status: 404 });
  }
  const { tagId } = await request.json();
  if (!tagId) {
    return NextResponse.json({ error: "tagId required" }, { status: 400 });
  }

  try {
    await prisma.paperTag.create({
      data: { paperId: params.id, tagId },
    });
    return NextResponse.json({ success: true }, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: "Tag already assigned or not found" },
      { status: 400 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const paper = await requirePaperAccess(params.id);
  if (!paper) {
    return NextResponse.json({ error: "Paper not found" }, { status: 404 });
  }
  const { searchParams } = new URL(request.url);
  const tagId = searchParams.get("tagId");
  if (!tagId) {
    return NextResponse.json({ error: "tagId required" }, { status: 400 });
  }

  await prisma.paperTag.deleteMany({
    where: { paperId: params.id, tagId },
  });
  return NextResponse.json({ success: true });
}
