import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { synthesisQueue } from "@/lib/synthesis/queue";
import { requireUserId } from "@/lib/paper-auth";

// POST — Create + enqueue synthesis
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { paperIds, title, query, mode, depth } = body as {
      paperIds: string[];
      title?: string;
      query?: string;
      mode?: "auto" | "guided";
      depth?: "quick" | "balanced" | "deep";
    };

    if (!Array.isArray(paperIds) || paperIds.length < 2) {
      return NextResponse.json(
        { error: "At least 2 paper IDs are required" },
        { status: 400 }
      );
    }

    const userId = await requireUserId();

    // Verify all papers exist and belong to user
    const papers = await prisma.paper.findMany({
      where: { id: { in: paperIds }, userId },
      select: { id: true, title: true },
    });

    if (papers.length !== paperIds.length) {
      return NextResponse.json(
        { error: `Only ${papers.length} of ${paperIds.length} papers found` },
        { status: 400 }
      );
    }

    const validDepth = depth && ["quick", "balanced", "deep"].includes(depth) ? depth : "balanced";

    // Auto-generate a meaningful title from paper titles
    let autoTitle = title;
    if (!autoTitle) {
      // Extract common words across paper titles (skip stopwords) for a descriptive name
      const stopwords = new Set(["a", "an", "the", "of", "in", "on", "for", "and", "or", "to", "with", "by", "is", "are", "from", "as", "at", "its", "via", "using", "based", "towards"]);
      const wordCounts = new Map<string, number>();
      for (const p of papers) {
        const words = p.title.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => w.length > 2 && !stopwords.has(w));
        const unique = Array.from(new Set(words));
        for (const w of unique) wordCounts.set(w, (wordCounts.get(w) || 0) + 1);
      }
      const topWords = Array.from(wordCounts.entries())
        .filter(([, c]) => c >= Math.max(2, Math.ceil(papers.length * 0.3)))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([w]) => w.charAt(0).toUpperCase() + w.slice(1));

      autoTitle = topWords.length >= 2
        ? topWords.join(", ") + ` (${papers.length} papers)`
        : `${papers[0].title.slice(0, 60)} + ${papers.length - 1} more`;
    }

    const session = await prisma.synthesisSession.create({
      data: {
        title: autoTitle,
        query: query || null,
        mode: mode || "auto",
        depth: validDepth,
        paperCount: papers.length,
        papers: {
          create: paperIds.map((paperId) => ({ paperId })),
        },
      },
    });

    synthesisQueue.enqueue(session.id);

    return NextResponse.json({ id: session.id }, { status: 202 });
  } catch (err) {
    console.error("[api/synthesis] POST error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create synthesis" },
      { status: 500 }
    );
  }
}

// GET — List sessions
export async function GET() {
  try {
    const userId = await requireUserId();
    const sessions = await prisma.synthesisSession.findMany({
      where: { papers: { some: { paper: { userId } } } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        phase: true,
        progress: true,
        paperCount: true,
        depth: true,
        createdAt: true,
        completedAt: true,
        error: true,
        papers: {
          select: {
            paper: { select: { title: true } },
          },
          take: 3,
        },
      },
    });

    return NextResponse.json(sessions);
  } catch (err) {
    console.error("[api/synthesis] GET error:", err);
    return NextResponse.json(
      { error: "Failed to fetch sessions" },
      { status: 500 }
    );
  }
}
