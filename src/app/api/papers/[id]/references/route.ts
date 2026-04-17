import { NextRequest, NextResponse } from "next/server";
import { requirePaperAccess } from "@/lib/paper-auth";
import { deleteReferenceEntryWithLegacyProjection } from "@/lib/citations/reference-entry-service";
import { listPaperReferenceViews } from "@/lib/references/read-model";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const paper = await requirePaperAccess(id);
  if (!paper) {
    return NextResponse.json({ error: "Paper not found" }, { status: 404 });
  }

  const references = await listPaperReferenceViews(id, paper.userId);

  return NextResponse.json(references);
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const paper = await requirePaperAccess(id);
  if (!paper) {
    return NextResponse.json({ error: "Paper not found" }, { status: 404 });
  }
  const referenceId = req.nextUrl.searchParams.get("referenceId");

  if (!referenceId) {
    return NextResponse.json(
      { error: "referenceId query parameter is required" },
      { status: 400 }
    );
  }

  const deleted = await deleteReferenceEntryWithLegacyProjection(id, referenceId);
  if (!deleted) {
    return NextResponse.json(
      { error: "Reference not found" },
      { status: 404 }
    );
  }

  return NextResponse.json({ success: true });
}
