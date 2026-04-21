import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ensureTagClusters, generateTagClusters } from "@/lib/tags/clustering";
import { requireUserId } from "@/lib/paper-auth";
import { mergePaperVisibilityWhere } from "@/lib/papers/visibility";

export async function GET(request: NextRequest) {
  try {
    const userId = await requireUserId();
    const filterTagIds = request.nextUrl.searchParams.get("filterTagIds");

    await ensureTagClusters();

    const clusters = await prisma.tagCluster.findMany({
      orderBy: { sortOrder: "asc" },
      include: {
        tags: {
          orderBy: { score: "desc" },
          include: { _count: { select: { papers: true } } },
        },
      },
    });

    // When tags are selected, recompute counts to show intersection sizes
    if (filterTagIds) {
      const selectedIds = filterTagIds.split(",").filter(Boolean);
      if (selectedIds.length > 0) {
        // Find papers that have ALL selected tags (intersection)
        const matchingPapers = await prisma.paper.findMany({
          where: mergePaperVisibilityWhere(userId, {
            AND: selectedIds.map((id) => ({ tags: { some: { tagId: id } } })),
          }),
          select: {
            tags: { select: { tagId: true } },
          },
        });

        // Count how many matching papers have each tag
        const tagCounts: Record<string, number> = {};
        for (const paper of matchingPapers) {
          for (const pt of paper.tags) {
            tagCounts[pt.tagId] = (tagCounts[pt.tagId] || 0) + 1;
          }
        }

        // Override _count.papers with intersection counts
        for (const cluster of clusters) {
          for (const tag of cluster.tags) {
            if (selectedIds.includes(tag.id)) {
              // Keep the original count for already-selected tags
            } else {
              tag._count.papers = tagCounts[tag.id] || 0;
            }
          }
        }
      }
    }

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
