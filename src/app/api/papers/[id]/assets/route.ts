import { NextRequest, NextResponse } from "next/server";
import path from "path";

import { requirePaperAccess } from "@/lib/paper-auth";
import { isPathWithinRoot } from "@/lib/research/path-safety";

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
  const absolutePath = path.isAbsolute(normalizedRelativePath)
    ? path.normalize(normalizedRelativePath)
    : path.normalize(path.join(process.cwd(), normalizedRelativePath));
  const uploadsRoot = path.join(process.cwd(), "uploads");

  if (!isPathWithinRoot(uploadsRoot, absolutePath)) {
    return NextResponse.json({ error: "Invalid path" }, { status: 400 });
  }

  try {
    const fs = await import("fs/promises");
    const stat = await fs.stat(absolutePath);
    if (!stat.isFile()) {
      return NextResponse.json({ error: "Not a file" }, { status: 400 });
    }

    const buffer = await fs.readFile(absolutePath);
    const extension = path.extname(absolutePath).toLowerCase();
    const mimeType = MIME_TYPES[extension] || "application/octet-stream";
    const filename = path.basename(absolutePath);
    const asAttachment = request.nextUrl.searchParams.get("download") === "true";

    return access.setDuplicateStateHeaders(new NextResponse(buffer, {
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
