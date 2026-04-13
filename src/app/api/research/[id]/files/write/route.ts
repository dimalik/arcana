import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import path from "path";
import { writeFile, mkdir } from "fs/promises";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await requireUser();
  const userId = user.id;
  const { id } = await params;

  const project = await prisma.researchProject.findUnique({
    where: { id },
    select: { userId: true, outputFolder: true },
  });
  if (!project || project.userId !== userId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await request.json();
  const { filename, content } = body;

  if (!filename || typeof filename !== "string") {
    return NextResponse.json({ error: "filename required" }, { status: 400 });
  }
  if (typeof content !== "string") {
    return NextResponse.json({ error: "content required" }, { status: 400 });
  }

  // Prevent path traversal
  const safeName = path.basename(filename);
  if (safeName !== filename || filename.includes("..")) {
    return NextResponse.json({ error: "Invalid filename" }, { status: 400 });
  }

  const workDir = project.outputFolder;
  if (!workDir) {
    return NextResponse.json({ error: "Project has no workspace" }, { status: 400 });
  }

  const filePath = path.join(workDir, safeName);

  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf-8");
    return NextResponse.json({ ok: true, path: safeName });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Write failed";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
