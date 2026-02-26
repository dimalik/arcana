import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

type MatchType = "exact" | "superset" | "subset";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const text = request.nextUrl.searchParams.get("text");

  if (!text) {
    return NextResponse.json({ error: "text parameter required" }, { status: 400 });
  }

  const queryNorm = normalize(text);

  const conversations = await prisma.conversation.findMany({
    where: {
      paperId: id,
      selectedText: { not: null },
    },
    include: {
      _count: { select: { messages: true } },
      messages: {
        where: { role: "assistant" },
        orderBy: { createdAt: "asc" },
        take: 1,
        select: { content: true },
      },
    },
    orderBy: { updatedAt: "desc" },
  });

  const matches: {
    id: string;
    matchType: MatchType;
    selectedText: string;
    mode: string | null;
    title: string | null;
    previewText: string | null;
    messageCount: number;
    createdAt: string;
  }[] = [];

  for (const conv of conversations) {
    const storedNorm = normalize(conv.selectedText!);
    let matchType: MatchType | null = null;

    if (storedNorm === queryNorm) {
      matchType = "exact";
    } else if (storedNorm.includes(queryNorm)) {
      matchType = "superset";
    } else if (queryNorm.includes(storedNorm)) {
      matchType = "subset";
    }

    if (matchType) {
      const preview = conv.messages[0]?.content ?? null;
      matches.push({
        id: conv.id,
        matchType,
        selectedText: conv.selectedText!,
        mode: conv.mode,
        title: conv.title,
        previewText: preview ? preview.slice(0, 200) : null,
        messageCount: conv._count.messages,
        createdAt: conv.createdAt.toISOString(),
      });
    }
  }

  // Sort: exact first, then superset, then subset
  const order: Record<MatchType, number> = { exact: 0, superset: 1, subset: 2 };
  matches.sort((a, b) => order[a.matchType] - order[b.matchType]);

  return NextResponse.json(matches);
}
