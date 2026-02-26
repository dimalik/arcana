import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const { paperId } = await request.json();
  if (!paperId) {
    return NextResponse.json({ error: "paperId required" }, { status: 400 });
  }

  try {
    await prisma.collectionPaper.create({
      data: { collectionId: params.id, paperId },
    });
    return NextResponse.json({ success: true }, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: "Paper already in collection or not found" },
      { status: 400 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const { searchParams } = new URL(request.url);
  const paperId = searchParams.get("paperId");
  if (!paperId) {
    return NextResponse.json({ error: "paperId required" }, { status: 400 });
  }

  await prisma.collectionPaper.deleteMany({
    where: { collectionId: params.id, paperId },
  });
  return NextResponse.json({ success: true });
}
