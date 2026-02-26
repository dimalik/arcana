import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const tagIds = searchParams.get("tagIds");

  const where: Record<string, unknown> = {
    year: { not: null },
  };

  if (tagIds) {
    const ids = tagIds.split(",").filter(Boolean);
    if (ids.length > 0) {
      where.tags = { some: { tagId: { in: ids } } };
    }
  }

  const results = await prisma.paper.groupBy({
    by: ["year"],
    where,
    _count: { id: true },
    orderBy: { year: "asc" },
  });

  const data = results.map((r) => ({
    year: r.year as number,
    count: r._count.id,
  }));

  return NextResponse.json(data);
}
