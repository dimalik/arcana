import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { z } from "zod";

const createCollectionSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  parentId: z.string().optional(),
});

export async function GET() {
  const collections = await prisma.collection.findMany({
    orderBy: { name: "asc" },
    include: {
      _count: { select: { papers: true, children: true } },
      children: {
        include: {
          _count: { select: { papers: true, children: true } },
        },
      },
    },
  });
  return NextResponse.json(collections);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const data = createCollectionSchema.parse(body);

    const collection = await prisma.collection.create({ data });
    return NextResponse.json(collection, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation error", details: error.issues },
        { status: 400 }
      );
    }
    console.error("Create collection error:", error);
    return NextResponse.json(
      { error: "Failed to create collection" },
      { status: 500 }
    );
  }
}
