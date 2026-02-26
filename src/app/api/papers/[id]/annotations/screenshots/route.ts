import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { writeFile, mkdir } from "fs/promises";
import path from "path";
import { v4 as uuidv4 } from "uuid";

const SCREENSHOTS_DIR = path.join(process.cwd(), "uploads", "screenshots");

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const paper = await prisma.paper.findUnique({ where: { id } });
  if (!paper) {
    return NextResponse.json({ error: "Paper not found" }, { status: 404 });
  }

  const formData = await request.formData();
  const image = formData.get("image") as File | null;
  const pageNumber = parseInt(formData.get("pageNumber") as string);
  const rectStr = formData.get("rect") as string;
  const note = (formData.get("note") as string) || "";

  if (!image || !pageNumber || !rectStr) {
    return NextResponse.json(
      { error: "image, pageNumber, and rect are required" },
      { status: 400 }
    );
  }

  let rect: { x: number; y: number; w: number; h: number };
  try {
    rect = JSON.parse(rectStr);
  } catch {
    return NextResponse.json({ error: "Invalid rect JSON" }, { status: 400 });
  }

  await mkdir(SCREENSHOTS_DIR, { recursive: true });

  const filename = `${uuidv4()}.png`;
  const filePath = path.join(SCREENSHOTS_DIR, filename);
  const buffer = Buffer.from(await image.arrayBuffer());
  await writeFile(filePath, buffer);

  const screenshotPath = `uploads/screenshots/${filename}`;

  const entry = await prisma.notebookEntry.create({
    data: {
      paperId: id,
      type: "screenshot",
      selectedText: null,
      annotation: note || null,
      content: JSON.stringify({ pageNumber, rect, screenshotPath }),
    },
  });

  return NextResponse.json(
    {
      id: entry.id,
      selectedText: entry.selectedText,
      annotation: entry.annotation,
      content: entry.content ? JSON.parse(entry.content) : null,
      createdAt: entry.createdAt,
    },
    { status: 201 }
  );
}
