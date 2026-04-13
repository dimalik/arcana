import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/paper-auth";

// POST — Create a new research project
export async function POST(request: NextRequest) {
  try {
    const userId = await requireUserId();
    const body = await request.json();
    const { title, question, subQuestions, domains, keywords, methodology, seedPaperIds, constraints, resources, kind } = body as {
      title: string;
      question: string;
      subQuestions?: string[];
      domains?: string[];
      keywords?: string[];
      methodology?: string;
      seedPaperIds?: string[];
      constraints?: string;
      resources?: "all" | "local" | string[]; // "all" = auto, "local" = no remote, string[] = specific host IDs
      kind?: string;
    };

    if (!title?.trim() || !question?.trim()) {
      return NextResponse.json({ error: "Title and question are required" }, { status: 400 });
    }
    if (kind !== undefined && kind !== "RESEARCH" && kind !== "SYSTEM" && kind !== "SANDBOX") {
      return NextResponse.json({ error: "Invalid project kind" }, { status: 400 });
    }

    const brief = JSON.stringify({
      question: question.trim(),
      subQuestions: subQuestions || [],
      domains: domains || [],
      keywords: keywords || [],
      ...(constraints?.trim() ? { constraints: constraints.trim() } : {}),
      ...(resources && resources !== "all" ? { resources } : {}),
    });

    // Create a collection for this project's papers
    const collection = await prisma.collection.create({
      data: { name: `Research: ${title.trim()}` },
    });

    // If seed papers provided, verify ownership and add to collection
    if (seedPaperIds && seedPaperIds.length > 0) {
      const papers = await prisma.paper.findMany({
        where: { id: { in: seedPaperIds }, userId },
        select: { id: true },
      });
      if (papers.length > 0) {
        for (const p of papers) {
          await prisma.collectionPaper.create({
            data: { paperId: p.id, collectionId: collection.id },
          }).catch(() => {}); // ignore duplicates
        }
      }
    }

    const project = await prisma.researchProject.create({
      data: {
        userId,
        kind: kind === "SYSTEM" ? "SYSTEM" : kind === "SANDBOX" ? "SANDBOX" : "RESEARCH",
        title: title.trim(),
        brief,
        methodology: methodology || null,
        collectionId: collection.id,
        status: "ACTIVE",
        iterations: {
          create: {
            number: 1,
            goal: "Initial literature review and hypothesis formation",
          },
        },
        log: {
          create: {
            type: "decision",
            content: `Project created: "${title.trim()}"`,
          },
        },
      },
      include: {
        iterations: true,
      },
    });

    return NextResponse.json(project, { status: 201 });
  } catch (err) {
    console.error("[api/research] POST error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to create project" },
      { status: 500 }
    );
  }
}

// GET — List user's projects
export async function GET(request: NextRequest) {
  try {
    const userId = await requireUserId();
    const { searchParams } = new URL(request.url);
    const status = searchParams.get("status"); // "ACTIVE" | "COMPLETED" | null (all)
    const kind = searchParams.get("kind");
    const includeSystem = searchParams.get("includeSystem") === "true";
    const includeSandbox = searchParams.get("includeSandbox") === "true";

    const where: Record<string, unknown> = { userId };
    if (status) where.status = status;
    if (kind === "SYSTEM" || kind === "RESEARCH" || kind === "SANDBOX") {
      where.kind = kind;
    } else if (!includeSystem) {
      where.kind = includeSandbox
        ? { in: ["RESEARCH", "SANDBOX"] }
        : { in: ["RESEARCH", "SANDBOX"] };
    }

    const projects = await prisma.researchProject.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      select: {
        id: true,
        kind: true,
        title: true,
        status: true,
        methodology: true,
        currentPhase: true,
        createdAt: true,
        updatedAt: true,
        brief: true,
        iterations: {
          orderBy: { number: "desc" },
          take: 1,
          select: { number: true, status: true },
        },
        collection: {
          select: {
            _count: { select: { papers: true } },
          },
        },
        _count: {
          select: { hypotheses: true },
        },
        log: {
          orderBy: { createdAt: "desc" },
          take: 1,
          select: { type: true, content: true, createdAt: true },
        },
      },
    });

    return NextResponse.json(projects);
  } catch (err) {
    console.error("[api/research] GET error:", err);
    return NextResponse.json({ error: "Failed to fetch projects" }, { status: 500 });
  }
}
