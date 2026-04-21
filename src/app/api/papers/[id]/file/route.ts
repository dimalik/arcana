import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { saveUploadedFile } from "@/lib/upload";
import { processingQueue } from "@/lib/processing/queue";
import { trackEngagement } from "@/lib/engagement/track";
import { paperAccessErrorToResponse, requirePaperAccess } from "@/lib/paper-auth";
import { setProcessingProjection } from "@/lib/processing/runtime-ledger";
import { resolveStorageCandidates } from "@/lib/storage-paths";

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const access = await requirePaperAccess(params.id, {
    mode: "read",
    select: { filePath: true, title: true },
  });

  if (!access) {
    return NextResponse.json({ error: "Paper not found" }, { status: 404 });
  }
  const paper = access.paper;

  if (!paper.filePath) {
    return NextResponse.json({ error: "No PDF file available" }, { status: 404 });
  }

  try {
    // Dynamic imports avoid Turbopack TP1004 path-analysis warnings for fs access.
    const fs = await import("fs/promises");
    let buffer: Buffer | null = null;
    for (const candidatePath of resolveStorageCandidates(paper.filePath)) {
      try {
        buffer = await fs.readFile(candidatePath);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          throw error;
        }
      }
    }

    if (!buffer) {
      throw Object.assign(new Error("PDF file not found on disk"), { code: "ENOENT" });
    }
    const filename = `${paper.title?.replace(/[^a-zA-Z0-9-_ ]/g, "").slice(0, 100) || "paper"}.pdf`;

    trackEngagement(params.id, "pdf_open").catch(() => {});

    return access.setDuplicateStateHeaders(new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${filename}"`,
        "Content-Length": buffer.byteLength.toString(),
      },
    }));
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
  try {
    const access = await requirePaperAccess(params.id, {
      mode: "mutate",
      select: { id: true, filePath: true, processingStatus: true },
    });

    if (!access) {
      return NextResponse.json({ error: "Paper not found" }, { status: 404 });
    }
    const paper = access.paper;

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
  } catch (error) {
    const response = paperAccessErrorToResponse(error);
    if (response) return response;
    throw error;
  }
}
