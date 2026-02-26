import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const mergeSchema = z.object({
  targetId: z.string().min(1),
  sourceIds: z.array(z.string().min(1)).min(1),
});

/**
 * Merge multiple source tags into a single target tag.
 * - Moves all paper associations from source tags to target
 * - Deletes source tags
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { targetId, sourceIds } = mergeSchema.parse(body);

    // Verify target exists
    const target = await prisma.tag.findUnique({ where: { id: targetId } });
    if (!target) {
      return NextResponse.json(
        { error: "Target tag not found" },
        { status: 404 }
      );
    }

    // Get all paper associations for source tags
    const sourcePaperTags = await prisma.paperTag.findMany({
      where: { tagId: { in: sourceIds } },
    });

    // Get existing associations for target to avoid duplicates
    const existingPaperIds = new Set(
      (
        await prisma.paperTag.findMany({
          where: { tagId: targetId },
          select: { paperId: true },
        })
      ).map((pt) => pt.paperId)
    );

    // Move associations: create new ones for papers not already on target
    for (const pt of sourcePaperTags) {
      if (!existingPaperIds.has(pt.paperId)) {
        await prisma.paperTag
          .create({ data: { paperId: pt.paperId, tagId: targetId } })
          .catch(() => {}); // Skip if somehow duplicate
        existingPaperIds.add(pt.paperId);
      }
    }

    // Delete source paper-tag associations and source tags
    await prisma.paperTag.deleteMany({
      where: { tagId: { in: sourceIds } },
    });
    await prisma.tag.deleteMany({
      where: { id: { in: sourceIds } },
    });

    return NextResponse.json({
      success: true,
      mergedCount: sourceIds.length,
      targetTag: target.name,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation error", details: error.issues },
        { status: 400 }
      );
    }
    console.error("Merge tags error:", error);
    return NextResponse.json(
      { error: "Failed to merge tags" },
      { status: 500 }
    );
  }
}
