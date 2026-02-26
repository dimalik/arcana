import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(request: NextRequest) {
  const sourceUrl = request.nextUrl.searchParams.get("sourceUrl");

  if (!sourceUrl) {
    return NextResponse.json(
      { error: "sourceUrl parameter is required" },
      { status: 400 }
    );
  }

  const paper = await prisma.paper.findFirst({
    where: { sourceUrl },
    select: { id: true, title: true },
  });

  if (!paper) {
    return NextResponse.json(
      { error: "Paper not found" },
      { status: 404 }
    );
  }

  return NextResponse.json(paper);
}
