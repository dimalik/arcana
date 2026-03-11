import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { synthesisQueue } from "@/lib/synthesis/queue";
import { generateLLMResponse } from "@/lib/llm/provider";
import { getDefaultModel } from "@/lib/llm/auto-process";
import { requireUserId } from "@/lib/paper-auth";

// GET — Session detail
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await requireUserId();
    const { id } = await params;

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

    return NextResponse.json({
      ...session,
      plan: session.plan ? JSON.parse(session.plan) : null,
      vizData: session.vizData ? JSON.parse(session.vizData) : null,
      guidanceMessages: session.guidanceMessages ? JSON.parse(session.guidanceMessages) : null,
      guidance: session.guidance ? JSON.parse(session.guidance) : null,
    });
  } catch (err) {
    console.error("[api/synthesis/[id]] GET error:", err);
    return NextResponse.json(
      { error: "Failed to fetch session" },
      { status: 500 }
    );
  }
}

// PATCH — Regenerate title
export async function PATCH(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await requireUserId();
    const { id } = await params;

    const session = await prisma.synthesisSession.findFirst({
      where: { id, papers: { some: { paper: { userId } } } },
      select: {
        papers: {
          include: { paper: { select: { title: true } } },
        },
      },
    });

    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const papers = session.papers.map((sp) => sp.paper);
    const paperTitles = papers.map((p) => p.title).join("; ");

    const { provider, modelId, proxyConfig } = await getDefaultModel();
    const raw = await generateLLMResponse({
      provider,
      modelId,
      system: "You generate concise, descriptive titles and one-line descriptions for academic literature reviews.",
      prompt: `Given these paper titles, generate a short academic title (max 10 words) and a one-sentence description (max 25 words) for a synthesis of these papers.\n\nPapers: ${paperTitles.slice(0, 2000)}\n\nRespond in JSON: {"title": "...", "description": "..."}`,
      maxTokens: 200,
      proxyConfig,
    });

    let newTitle: string;
    let newDescription: string | null = null;
    try {
      const match = raw.match(/\{[\s\S]*\}/);
      const parsed = JSON.parse(match?.[0] || raw);
      newTitle = parsed.title || `${papers[0].title.slice(0, 60)} + ${papers.length - 1} more`;
      newDescription = parsed.description || null;
    } catch {
      newTitle = `${papers[0].title.slice(0, 60)} + ${papers.length - 1} more`;
    }

    await prisma.synthesisSession.update({
      where: { id },
      data: { title: newTitle, description: newDescription },
    });

    return NextResponse.json({ title: newTitle, description: newDescription });
  } catch (err) {
    console.error("[api/synthesis/[id]] PATCH error:", err);
    return NextResponse.json(
      { error: "Failed to regenerate title" },
      { status: 500 }
    );
  }
}

// DELETE — Cancel running synthesis or delete completed/failed session
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await requireUserId();
    const { id } = await params;

    const session = await prisma.synthesisSession.findFirst({
      where: { id, papers: { some: { paper: { userId } } } },
      select: { status: true },
    });

    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const isRunning = ["PENDING", "PLANNING", "MAPPING", "GRAPHING", "EXPANDING", "REDUCING", "COMPOSING", "GUIDING"].includes(session.status);

    if (isRunning) {
      // Cancel running session
      const cancelled = await synthesisQueue.cancel(id);
      await prisma.synthesisSession.update({
        where: { id },
        data: { status: "CANCELLED", completedAt: new Date() },
      });
      return NextResponse.json({ cancelled });
    }

    // Delete completed/failed/cancelled session (cascade deletes papers + sections)
    await prisma.synthesisSession.delete({ where: { id } });
    return NextResponse.json({ deleted: true });
  } catch (err) {
    console.error("[api/synthesis/[id]] DELETE error:", err);
    return NextResponse.json(
      { error: "Failed to delete session" },
      { status: 500 }
    );
  }
}
