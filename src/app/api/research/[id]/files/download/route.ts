import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";
import { isPathWithinRoot } from "@/lib/research/path-safety";
import path from "path";
import { stat, readFile } from "fs/promises";
import { createReadStream } from "fs";

type Params = { params: Promise<{ id: string }> };

function getWorkDir(project: { title: string; outputFolder: string | null }) {
  const slug = project.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  return project.outputFolder || path.join(process.cwd(), "output", "research", slug);
}

const MIME_TYPES: Record<string, string> = {
  ".py": "text/x-python",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".pdf": "application/pdf",
  ".html": "text/html",
  ".sh": "text/x-shellscript",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".toml": "text/plain",
};

const TEXT_EXTENSIONS = new Set([
  ".py", ".txt", ".log", ".md", ".json", ".csv", ".html", ".sh", ".yaml", ".yml", ".toml", ".cfg", ".ini", ".r", ".R",
]);

/**
 * GET /api/research/[id]/files/download?path=relative/path&preview=true
 *
 * - preview=true: returns file content as text (for text files, max 500KB)
 * - preview=false/absent: returns file as download attachment
 */
export async function GET(request: NextRequest, { params }: Params) {
  const userId = await requireUserId();
  const { id } = await params;
  const filePath = request.nextUrl.searchParams.get("path");
  const preview = request.nextUrl.searchParams.get("preview") === "true";

  if (!filePath) {
    return NextResponse.json({ error: "path parameter required" }, { status: 400 });
  }

  const project = await prisma.researchProject.findFirst({
    where: { id, userId },
    select: { title: true, outputFolder: true },
  });

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 });
  }

  const workDir = getWorkDir(project);
  const fullPath = path.normalize(path.join(workDir, filePath));
  if (!isPathWithinRoot(workDir, fullPath)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  try {
    const st = await stat(fullPath);
    if (!st.isFile()) {
      return NextResponse.json({ error: "Not a file" }, { status: 400 });
    }

    const ext = path.extname(fullPath).toLowerCase();
    const isText = TEXT_EXTENSIONS.has(ext);

    if (preview && isText) {
      // Return text content for preview (max 500KB)
      const maxPreview = 500 * 1024;
      if (st.size > maxPreview) {
        const buf = Buffer.alloc(maxPreview);
        const { open } = await import("fs/promises");
        const fh = await open(fullPath, "r");
        await fh.read(buf, 0, maxPreview, 0);
        await fh.close();
        return NextResponse.json({
          content: buf.toString("utf-8"),
          truncated: true,
          totalSize: st.size,
        });
      }

      const content = await readFile(fullPath, "utf-8");
      return NextResponse.json({
        content,
        truncated: false,
        totalSize: st.size,
      });
    }

    // Stream as download
    const mime = MIME_TYPES[ext] || "application/octet-stream";
    const filename = path.basename(fullPath);

    // For the streaming response, read the whole file
    // (Next.js doesn't support Node streams in route handlers easily)
    const data = await readFile(fullPath);

    return new NextResponse(data, {
      headers: {
        "Content-Type": mime,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(st.size),
      },
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }
    return NextResponse.json({ error: "Failed to read file" }, { status: 500 });
  }
}
