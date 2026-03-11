import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";
import path from "path";
import { readdir, stat } from "fs/promises";

type Params = { params: Promise<{ id: string }> };

function getWorkDir(project: { title: string; outputFolder: string | null }) {
  const slug = project.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40);
  return project.outputFolder || path.join(process.cwd(), "output", "research", slug);
}

interface FileEntry {
  name: string;
  path: string; // relative to workDir
  size: number;
  isDir: boolean;
  modified: string;
  children?: FileEntry[];
}

async function listDir(dirPath: string, basePath: string, depth = 0): Promise<FileEntry[]> {
  if (depth > 3) return []; // prevent deep traversal
  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const results: FileEntry[] = [];

    for (const entry of entries) {
      // Skip hidden files, __pycache__, .venv, node_modules
      if (entry.name.startsWith(".") || entry.name === "__pycache__" || entry.name === ".venv" || entry.name === "node_modules") continue;

      const fullPath = path.join(dirPath, entry.name);
      const relPath = path.relative(basePath, fullPath);

      if (entry.isDirectory()) {
        const children = await listDir(fullPath, basePath, depth + 1);
        if (children.length > 0) {
          results.push({
            name: entry.name,
            path: relPath,
            size: 0,
            isDir: true,
            modified: "",
            children,
          });
        }
      } else {
        try {
          const st = await stat(fullPath);
          results.push({
            name: entry.name,
            path: relPath,
            size: st.size,
            isDir: false,
            modified: st.mtime.toISOString(),
          });
        } catch {
          // Skip files we can't stat
        }
      }
    }

    // Sort: dirs first, then by name
    results.sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    return results;
  } catch {
    return [];
  }
}

/**
 * GET /api/research/[id]/files — List all files in the project output directory
 */
export async function GET(_request: NextRequest, { params }: Params) {
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
  const files = await listDir(workDir, workDir);

  return NextResponse.json({ workDir, files });
}
