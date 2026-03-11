import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";

export async function PATCH(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const userId = await requireUserId();
    const paper = await prisma.paper.findFirst({
      where: { id: params.id, userId },
      select: { isLiked: true },
    });

    if (!paper) {
      return NextResponse.json({ error: "Paper not found" }, { status: 404 });
    }

    const updated = await prisma.paper.update({
      where: { id: params.id },
      data: { isLiked: !paper.isLiked },
      select: { id: true, isLiked: true },
    });

    return NextResponse.json(updated);
  } catch (error) {
    console.error("Like toggle error:", error);
    return NextResponse.json(
      { error: "Failed to toggle like" },
      { status: 500 }
    );
  }
}
