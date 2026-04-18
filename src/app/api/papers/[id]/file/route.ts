import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readFile } from "fs/promises";
import path from "path";
import { saveUploadedFile } from "@/lib/upload";
import { processingQueue } from "@/lib/processing/queue";
import { trackEngagement } from "@/lib/engagement/track";
import { requireUserId } from "@/lib/paper-auth";
import { setProcessingProjection } from "@/lib/processing/runtime-ledger";

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const userId = await requireUserId();
    const paper = await prisma.paper.findFirst({
    where: { id: params.id, userId },
    select: { filePath: true, title: true },
  });

  if (!paper) {
    return NextResponse.json({ error: "Paper not found" }, { status: 404 });
  }

  if (!paper.filePath) {
    return NextResponse.json({ error: "No PDF file available" }, { status: 404 });
  }

  const absolutePath = path.isAbsolute(paper.filePath)
    ? paper.filePath
    : path.join(process.cwd(), paper.filePath);

  try {
    const buffer = await readFile(absolutePath);
    const filename = `${paper.title?.replace(/[^a-zA-Z0-9-_ ]/g, "").slice(0, 100) || "paper"}.pdf`;

    trackEngagement(params.id, "pdf_open").catch(() => {});

    return new NextResponse(buffer, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${filename}"`,
        "Content-Length": buffer.byteLength.toString(),
      },
    });
  } catch {
    return NextResponse.json({ error: "PDF file not found on disk" }, { status: 404 });
  }
}

/**
 * POST /api/papers/[id]/file — Attach a PDF to an existing paper.
 * Used by the chrome extension to upload PDFs fetched from the browser context.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const userId = await requireUserId();
  const paper = await prisma.paper.findFirst({
    where: { id: params.id, userId },
    select: { id: true, filePath: true, processingStatus: true },
  });

  if (!paper) {
    return NextResponse.json({ error: "Paper not found" }, { status: 404 });
  }

  if (paper.filePath) {
    return NextResponse.json(
      { error: "Paper already has a PDF" },
      { status: 409 }
    );
  }

  const formData = await request.formData();
  const file = formData.get("file") as File | null;

  if (!file) {
    return NextResponse.json({ error: "No file provided" }, { status: 400 });
  }

  const { filePath } = await saveUploadedFile(file);

  await prisma.$transaction(async (tx) => {
    await tx.paper.update({
      where: { id: paper.id },
      data: { filePath },
    });
    await setProcessingProjection(
      paper.id,
      {
        processingStatus: "EXTRACTING_TEXT",
        processingStep: null,
        processingStartedAt: null,
      },
      tx,
    );
  });

  processingQueue.enqueue(paper.id);

  return NextResponse.json({ success: true, filePath }, { status: 200 });
}
