import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { readFile } from "fs/promises";
import path from "path";

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const paper = await prisma.paper.findUnique({
    where: { id: params.id },
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
