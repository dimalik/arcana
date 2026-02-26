import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const references = await prisma.reference.findMany({
    where: { paperId: id },
    orderBy: { referenceIndex: "asc" },
    include: {
      matchedPaper: {
        select: { id: true, title: true, year: true, authors: true },
      },
    },
  });

  return NextResponse.json(references);
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const referenceId = req.nextUrl.searchParams.get("referenceId");

  if (!referenceId) {
    return NextResponse.json(
      { error: "referenceId query parameter is required" },
      { status: 400 }
    );
  }

  // Validate reference belongs to this paper
  const reference = await prisma.reference.findFirst({
    where: { id: referenceId, paperId: id },
  });

  if (!reference) {
    return NextResponse.json(
      { error: "Reference not found" },
      { status: 404 }
    );
  }

  await prisma.reference.delete({ where: { id: referenceId } });

  return NextResponse.json({ success: true });
}
