import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import {
  jsonWithDuplicateState,
  paperAccessErrorToResponse,
  requirePaperAccess,
} from "@/lib/paper-auth";
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
  const access = await requirePaperAccess(params.id, { mode: "read" });
  if (!access) {
    return NextResponse.json({ error: "Paper not found" }, { status: 404 });
  }
  try {
    const result = await listRelationsForPaper(params.id, access.userId);
    return jsonWithDuplicateState(access, result.rows.map(toRouteRelationRow));
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
  try {
    const paperId = params.id;
    const access = await requirePaperAccess(paperId, { mode: "mutate" });
    if (!access) {
      return NextResponse.json({ error: "Paper not found" }, { status: 404 });
    }
    const body = await request.json();
    const data = createRelationSchema.parse(body);
    const relation = await createManualRelation({
      paperId,
      targetPaperId: data.targetPaperId,
      userId: access.userId,
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
    const response = paperAccessErrorToResponse(error);
    if (response) return response;
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
  try {
    const paperId = params.id;
    const access = await requirePaperAccess(paperId, { mode: "mutate" });
    if (!access) {
      return NextResponse.json({ error: "Paper not found" }, { status: 404 });
    }
    const { searchParams } = new URL(request.url);
    const relationId = searchParams.get("relationId");

    if (!relationId) {
      return NextResponse.json(
        { error: "relationId query parameter is required" },
        { status: 400 }
      );
    }

    await deleteManualRelation({ paperId, userId: access.userId, relationId });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof GraphRelationError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    const response = paperAccessErrorToResponse(error);
    if (response) return response;
    throw error;
  }
}
