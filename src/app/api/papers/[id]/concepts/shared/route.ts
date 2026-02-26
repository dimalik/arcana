import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    // Get this paper's root concepts (depth 0)
    const localConcepts = await prisma.concept.findMany({
      where: { paperId: id, depth: 0 },
      select: { id: true, name: true },
    });

    if (localConcepts.length === 0) {
      return NextResponse.json([]);
    }

    const localNames = localConcepts.map((c) => c.name.toLowerCase());

    // Get concepts from other papers
    const foreignConcepts = await prisma.concept.findMany({
      where: {
        paperId: { not: id },
        depth: 0,
      },
      select: {
        id: true,
        name: true,
        paperId: true,
        paper: { select: { title: true } },
      },
    });

    // Match by name (case-insensitive)
    const result = localConcepts
      .map((local) => {
        const matches = foreignConcepts
          .filter((f) => f.name.toLowerCase() === local.name.toLowerCase())
          .map((f) => ({
            paperId: f.paperId,
            paperTitle: f.paper.title,
            conceptId: f.id,
          }));

        return {
          conceptName: local.name,
          localConceptId: local.id,
          matches,
        };
      })
      .filter((r) => r.matches.length > 0);

    return NextResponse.json(result);
  } catch (error) {
    console.error("Shared concepts error:", error);
    return NextResponse.json(
      { error: "Failed to fetch shared concepts" },
      { status: 500 }
    );
  }
}
