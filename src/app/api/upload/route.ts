import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { saveUploadedFile } from "@/lib/upload";
import { processingQueue } from "@/lib/processing/queue";

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No file provided" }, { status: 400 });
    }

    if (file.type !== "application/pdf") {
      return NextResponse.json(
        { error: "Only PDF files are supported" },
        { status: 400 }
      );
    }

    const { filePath, originalName } = await saveUploadedFile(file);
    const sourceUrl = (formData.get("sourceUrl") as string) || null;
    const titleFromFile = originalName.replace(/\.pdf$/i, "");

    // Check for duplicate by filename-derived title or sourceUrl
    const existing = await prisma.paper.findFirst({
      where: sourceUrl
        ? { sourceUrl }
        : { title: titleFromFile, sourceType: "UPLOAD" },
    });
    if (existing) {
      return NextResponse.json(
        { error: "Paper already exists", paper: existing },
        { status: 409 }
      );
    }

    const paper = await prisma.paper.create({
      data: {
        title: originalName.replace(/\.pdf$/i, ""),
        sourceType: "UPLOAD",
        sourceUrl,
        filePath,
        processingStatus: "EXTRACTING_TEXT",
      },
    });

    // Queue handles: PDF text extraction → LLM pipeline
    processingQueue.enqueue(paper.id);

    return NextResponse.json(paper, { status: 201 });
  } catch (error) {
    console.error("Upload error:", error);
    return NextResponse.json(
      { error: "Failed to upload file" },
      { status: 500 }
    );
  }
}
