import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";

export async function GET() {
  const userId = await requireUserId();
  const [paperCount, tagCount, collectionCount] = await Promise.all([
    prisma.paper.count({ where: { userId } }),
    prisma.tag.count(),
    prisma.collection.count(),
  ]);

  return NextResponse.json({ paperCount, tagCount, collectionCount });
}
