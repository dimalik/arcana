import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireUserId } from "@/lib/paper-auth";
import {
  createManualRelation,
  deleteManualRelation,
} from "@/lib/assertions/graph-relations";
import {
  GraphRelationError,
  listRelationsForPaper,
  toRouteRelationRow,
} from "@/lib/assertions/relation-reader";

const createRelationSchema = z.object({
  targetPaperId: z.string().uuid(),
  relationType: z.string().min(1),
  description: z.string().optional(),
});

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const userId = await requireUserId();
  try {
    const result = await listRelationsForPaper(params.id, userId);
    return NextResponse.json(result.rows.map(toRouteRelationRow));
  } catch (error) {
    if (error instanceof GraphRelationError) {
      const status = typeof error.status === "number" ? error.status : 500;
      return NextResponse.json({ error: error.message }, { status });
    }
    throw error;
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const paperId = params.id;
  const userId = await requireUserId();

  try {
    const body = await request.json();
    const data = createRelationSchema.parse(body);
    const relation = await createManualRelation({
      paperId,
      targetPaperId: data.targetPaperId,
      userId,
      relationType: data.relationType,
      description: data.description ?? null,
    });

    return NextResponse.json(relation, { status: 201 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { error: "Validation error", details: error.issues },
        { status: 400 }
      );
    }
    if (error instanceof GraphRelationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    console.error("Create relation error:", error);
    return NextResponse.json(
      { error: "Failed to create relation" },
      { status: 500 }
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const paperId = params.id;
  const userId = await requireUserId();
  const { searchParams } = new URL(request.url);
  const relationId = searchParams.get("relationId");

  if (!relationId) {
    return NextResponse.json(
      { error: "relationId query parameter is required" },
      { status: 400 }
    );
  }

  try {
    await deleteManualRelation({ paperId, userId, relationId });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof GraphRelationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
}
