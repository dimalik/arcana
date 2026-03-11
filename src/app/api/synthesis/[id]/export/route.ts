import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { buildLatexDocument, compileLatexToPdf } from "@/lib/synthesis/latex-export";
import { requireUserId } from "@/lib/paper-auth";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await requireUserId();
    const { id } = await params;
    const format = request.nextUrl.searchParams.get("format") || "pdf";

    const session = await prisma.synthesisSession.findFirst({
      where: { id, papers: { some: { paper: { userId } } } },
      include: {
        sections: { orderBy: { sortOrder: "asc" } },
        papers: {
          include: {
            paper: {
              select: { id: true, title: true, year: true, authors: true },
            },
          },
        },
      },
    });

    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    if (session.status !== "COMPLETED") {
      return NextResponse.json(
        { error: "Synthesis not complete" },
        { status: 400 }
      );
    }

    const texContent = buildLatexDocument({
      title: session.title,
      paperCount: session.paperCount,
      createdAt: session.createdAt.toISOString(),
      sections: session.sections.map((s) => ({
        sectionType: s.sectionType,
        title: s.title,
        content: s.content,
      })),
      papers: session.papers.map((sp) => sp.paper),
    });

    const safeTitle = session.title
      .replace(/[^a-zA-Z0-9-_ ]/g, "")
      .slice(0, 80)
      .trim()
      .replace(/\s+/g, "_");

    // If .tex requested, return immediately
    if (format === "tex") {
      return new NextResponse(texContent, {
        headers: {
          "Content-Type": "application/x-tex",
          "Content-Disposition": `attachment; filename="${safeTitle}.tex"`,
        },
      });
    }

    // Try PDF compilation
    const path = await import("path");
    const os = await import("os");
    const outputDir = path.join(os.tmpdir(), `arcana-export-${id}`);

    const { pdfPath, texPath, error } = await compileLatexToPdf(
      texContent,
      outputDir
    );

    if (pdfPath) {
      const fs = await import("fs/promises");
      const pdfBuffer = await fs.readFile(pdfPath);

      // Clean up temp directory in background
      fs.rm(outputDir, { recursive: true }).catch(() => {});

      return new NextResponse(pdfBuffer, {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${safeTitle}.pdf"`,
          "Content-Length": pdfBuffer.byteLength.toString(),
        },
      });
    }

    // PDF compilation failed — log detail, return .tex as fallback
    console.warn("[api/synthesis/export] PDF failed, returning .tex. Reason:", error);
    return new NextResponse(texContent, {
      headers: {
        "Content-Type": "application/x-tex",
        "Content-Disposition": `attachment; filename="${safeTitle}.tex"`,
        "X-Arcana-Export-Note": "pdf-fallback",
      },
    });
  } catch (err) {
    console.error("[api/synthesis/[id]/export] GET error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Export failed" },
      { status: 500 }
    );
  }
}
