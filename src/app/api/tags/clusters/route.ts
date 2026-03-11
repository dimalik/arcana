import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { generateTagClusters } from "@/lib/tags/clustering";

export async function GET() {
  try {
    const clusters = await prisma.tagCluster.findMany({
      orderBy: { sortOrder: "asc" },
      include: {
        tags: {
          orderBy: { score: "desc" },
          include: { _count: { select: { papers: true } } },
        },
      },
    });
    return NextResponse.json(clusters);
  } catch (error) {
    console.error("Get clusters error:", error);
    return NextResponse.json(
      { error: "Failed to get clusters" },
      { status: 500 },
    );
  }
}

export async function POST() {
  try {
    const result = await generateTagClusters();
    return NextResponse.json(result);
  } catch (error) {
    console.error("Generate clusters error:", error);
    return NextResponse.json(
      { error: "Failed to generate clusters" },
      { status: 500 },
    );
  }
}
