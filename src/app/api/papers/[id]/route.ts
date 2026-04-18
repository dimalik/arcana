import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";
import { z } from "zod";

const updatePaperSchema = z.object({
  title: z.string().min(1).optional(),
  abstract: z.string().optional(),
  authors: z.array(z.string()).optional(),
  year: z.number().int().optional(),
  venue: z.string().optional(),
  doi: z.string().optional(),
  summary: z.string().optional(),
  keyFindings: z.array(z.string()).optional(),
  categories: z.array(z.string()).optional(),
  citationCount: z.number().int().nullable().optional(),
});

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const userId = await requireUserId();
  const paper = await prisma.paper.findFirst({
    where: { id: params.id, userId },
    include: {
      tags: { include: { tag: true } },
      collections: { include: { collection: true } },
      promptResults: { orderBy: { createdAt: "desc" } },
      sourceRelations: {
        include: {
          targetPaper: {
            select: { id: true, title: true, year: true, authors: true },
          },
        },
      },
      targetRelations: {
        include: {
          sourcePaper: {
            select: { id: true, title: true, year: true, authors: true },
          },
        },
      },
    },
  });

  if (!paper) {
    return NextResponse.json({ error: "Paper not found" }, { status: 404 });
  }

  // If paper is batch-processing, trigger a non-blocking poll to check if batch is done
  if (paper.processingStatus === "BATCH_PROCESSING") {
    import("@/lib/processing/batch").then(({ pollAllActiveBatches }) => {
      pollAllActiveBatches().catch(() => {});
    }).catch(() => {});
  }

  return NextResponse.json(paper);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const userId = await requireUserId();

    // Verify ownership
    const existing = await prisma.paper.findFirst({
      where: { id: params.id, userId },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json({ error: "Paper not found" }, { status: 404 });
    }

    const body = await request.json();
    const data = updatePaperSchema.parse(body);

    const updateData: Record<string, unknown> = { ...data };
    if (data.authors) updateData.authors = JSON.stringify(data.authors);
    if (data.keyFindings)
      updateData.keyFindings = JSON.stringify(data.keyFindings);
    if (data.categories)
      updateData.categories = JSON.stringify(data.categories);

    const paper = await prisma.paper.update({
      where: { id: params.id },
      data: updateData,
      include: {
        tags: { include: { tag: true } },
        collections: { include: { collection: true } },
      },
    });

    return NextResponse.json(paper);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation error", details: error.issues },
        { status: 400 }
      );
    }
    console.error("Update paper error:", error);
    return NextResponse.json(
      { error: "Failed to update paper" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const userId = await requireUserId();

    const existing = await prisma.paper.findFirst({
      where: { id: params.id, userId },
      select: { id: true },
    });
    if (!existing) {
      return NextResponse.json({ error: "Paper not found" }, { status: 404 });
    }

    await prisma.paper.delete({ where: { id: params.id } });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json(
      { error: "Failed to delete paper" },
      { status: 500 }
    );
  }
}
