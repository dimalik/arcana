import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { findDuplicateGroups } from "@/lib/tags/normalize";

export async function GET() {
  const tags = await prisma.tag.findMany({
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  const groups = findDuplicateGroups(tags);

  // Enrich with paper counts
  const tagIds = groups.flat().map((t) => t.id);
  const counts = await prisma.paperTag.groupBy({
    by: ["tagId"],
    where: { tagId: { in: tagIds } },
    _count: { paperId: true },
  });
  const countMap = new Map(counts.map((c) => [c.tagId, c._count.paperId]));

  const enriched = groups.map((group) =>
    group.map((t) => ({
      ...t,
      paperCount: countMap.get(t.id) || 0,
    }))
  );

  return NextResponse.json(enriched);
}
