import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const [paperCount, tagCount, collectionCount] = await Promise.all([
    prisma.paper.count(),
    prisma.tag.count(),
    prisma.collection.count(),
  ]);

  return NextResponse.json({ paperCount, tagCount, collectionCount });
}
