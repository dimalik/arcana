import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";
import { readFile, writeFile, mkdir } from "fs/promises";
import path from "path";

type Params = { params: Promise<{ id: string }> };

function getWorkDir(project: { title: string; outputFolder: string | null }): string {
  const slug = project.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  return project.outputFolder || path.join(process.cwd(), "output", "research", slug);
}

/**
 * GET — Read the RESEARCH_LOG.md file for a project.
 */
export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;

    const project = await prisma.researchProject.findFirst({
      where: { id, userId },
      select: { title: true, outputFolder: true },
    });
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const workDir = getWorkDir(project);
    const logPath = path.join(workDir, "RESEARCH_LOG.md");

    try {
      const content = await readFile(logPath, "utf-8");
      return NextResponse.json({ content, path: logPath });
    } catch {
      return NextResponse.json({ content: "", path: logPath });
    }
  } catch (err) {
    console.error("[research/log-file] GET error:", err);
    return NextResponse.json({ error: "Failed to read log" }, { status: 500 });
  }
}

/**
 * PUT — Write/update the RESEARCH_LOG.md file.
 * Body: { content: string }
 */
export async function PUT(request: NextRequest, { params }: Params) {
  try {
    const userId = await requireUserId();
    const { id } = await params;

    const project = await prisma.researchProject.findFirst({
      where: { id, userId },
      select: { title: true, outputFolder: true },
    });
    if (!project) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }

    const body = await request.json();
    const { content } = body;
    if (typeof content !== "string") {
      return NextResponse.json({ error: "content is required" }, { status: 400 });
    }

    const workDir = getWorkDir(project);
    await mkdir(workDir, { recursive: true });
    const logPath = path.join(workDir, "RESEARCH_LOG.md");
    await writeFile(logPath, content, "utf-8");

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[research/log-file] PUT error:", err);
    return NextResponse.json({ error: "Failed to save log" }, { status: 500 });
  }
}
