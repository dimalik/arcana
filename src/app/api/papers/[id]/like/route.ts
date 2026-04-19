import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { paperAccessErrorToResponse, requirePaperAccess } from "@/lib/paper-auth";

export async function PATCH(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const access = await requirePaperAccess(params.id, {
      mode: "mutate",
      select: { isLiked: true },
    });

    if (!access) {
      return NextResponse.json({ error: "Paper not found" }, { status: 404 });
    }
    const paper = access.paper;

    const updated = await prisma.paper.update({
      where: { id: params.id },
      data: { isLiked: !paper.isLiked },
      select: { id: true, isLiked: true },
    });

    return NextResponse.json(updated);
  } catch (error) {
    const response = paperAccessErrorToResponse(error);
    if (response) return response;
    console.error("Like toggle error:", error);
    return NextResponse.json(
      { error: "Failed to toggle like" },
      { status: 500 }
    );
  }
}
