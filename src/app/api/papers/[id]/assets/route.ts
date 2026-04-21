import { NextRequest, NextResponse } from "next/server";
import path from "path";

import { requirePaperAccess } from "@/lib/paper-auth";
import { isPathWithinRoot } from "@/lib/research/path-safety";
import { getDatabaseProjectRoot, resolveStorageCandidates } from "@/lib/storage-paths";

const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
};

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const access = await requirePaperAccess(params.id, {
    mode: "read",
    select: { id: true },
  });

  if (!access) {
    return NextResponse.json({ error: "Paper not found" }, { status: 404 });
  }

  const pathParam = request.nextUrl.searchParams.get("path");
  if (!pathParam) {
    return NextResponse.json({ error: "path parameter required" }, { status: 400 });
  }

  const normalizedRelativePath = pathParam.replace(/^\/+/, "");
  const candidatePaths = resolveStorageCandidates(normalizedRelativePath);
  if (candidatePaths.length === 0) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }
  const allowedRoots = [
    path.join(process.cwd(), "uploads"),
    ...(getDatabaseProjectRoot() ? [path.join(getDatabaseProjectRoot()!, "uploads")] : []),
  ];

  try {
    const fs = await import("fs/promises");
    let resolvedPath: string | null = null;
    let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;

    for (const candidatePath of candidatePaths) {
      if (!allowedRoots.some((root) => isPathWithinRoot(root, candidatePath))) {
        continue;
      }
      try {
        const candidateStat = await fs.stat(candidatePath);
        if (!candidateStat.isFile()) {
          continue;
        }
        resolvedPath = candidatePath;
        stat = candidateStat;
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          throw error;
        }
      }
    }

    if (!resolvedPath || !stat) {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }

    const buffer = await fs.readFile(resolvedPath);
    const extension = path.extname(resolvedPath).toLowerCase();
    const mimeType = MIME_TYPES[extension] || "application/octet-stream";
    const filename = path.basename(resolvedPath);
    const asAttachment = request.nextUrl.searchParams.get("download") === "true";

    return access.setDuplicateStateHeaders(new NextResponse(new Uint8Array(buffer), {
      headers: {
        "Content-Type": mimeType,
        "Content-Disposition": `${asAttachment ? "attachment" : "inline"}; filename="${filename}"`,
        "Content-Length": String(buffer.byteLength),
        "Cache-Control": "private, max-age=3600",
      },
    }));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return NextResponse.json({ error: "File not found" }, { status: 404 });
    }
    return NextResponse.json({ error: "Failed to read file" }, { status: 500 });
  }
}
