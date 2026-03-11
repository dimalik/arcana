import { NextRequest, NextResponse } from "next/server";
import { streamText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getModel } from "@/lib/llm/provider";
import { getDefaultModel } from "@/lib/llm/auto-process";
import { buildGuideSystemPrompt } from "@/lib/synthesis/guide-prompt";
import { searchAllSources } from "@/lib/import/semantic-scholar";
import { requireUserId } from "@/lib/paper-auth";
import type { SynthesisPlan, SynthesisDepth } from "@/lib/synthesis/types";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const userId = await requireUserId();
    const { id } = await params;

    const session = await prisma.synthesisSession.findFirst({
      where: { id, papers: { some: { paper: { userId } } } },
      include: {
        papers: {
          include: {
            paper: { select: { title: true, year: true } },
          },
        },
      },
    });

    if (!session) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    if (session.status !== "GUIDING") {
      return NextResponse.json(
        { error: `Session is in ${session.status} state, not GUIDING` },
        { status: 400 }
      );
    }

    if (!session.plan) {
      return NextResponse.json({ error: "No plan available" }, { status: 400 });
    }

    const plan: SynthesisPlan = JSON.parse(session.plan);
    const body = await request.json();
    const rawMessages = body.messages as {
      role: string;
      content?: string;
      parts?: { type: string; text?: string }[];
    }[];

    // Normalize UIMessage format (parts) → ModelMessage format (content)
    const messages = rawMessages.map((m) => {
      const content =
        (typeof m.content === "string" ? m.content : null) ||
        m.parts
          ?.filter((p) => p.type === "text")
          .map((p) => p.text || "")
          .join("") ||
        "";
      return { role: m.role as "user" | "assistant", content };
    });

    const systemPrompt = buildGuideSystemPrompt({
      title: session.title,
      query: session.query,
      paperTitles: session.papers.map((sp) => ({
        title: sp.paper.title,
        year: sp.paper.year,
      })),
      plan,
      depth: (session.depth || "balanced") as SynthesisDepth,
    });

    const { provider, modelId, proxyConfig } = await getDefaultModel();
    const model = await getModel(provider, modelId, proxyConfig);

    const searchPapersTool = tool({
      description: "Search academic databases for papers relevant to the synthesis",
      inputSchema: z.object({
        query: z.string().describe("Search query for finding papers"),
        year: z.number().optional().describe("Filter by publication year"),
      }),
      execute: async ({ query, year }: { query: string; year?: number }) => {
        const results = await searchAllSources(query, year || undefined);
        return results.slice(0, 8).map((r) => ({
          title: r.title,
          authors: r.authors.slice(0, 3).join(", "),
          year: r.year,
          citationCount: r.citationCount,
          doi: r.doi,
          arxivId: r.arxivId,
          externalUrl: r.externalUrl,
        }));
      },
    });

    const result = streamText({
      model,
      system: systemPrompt,
      messages,
      tools: { searchPapers: searchPapersTool },
      stopWhen: stepCountIs(5),
    });

    // Persist messages after streaming completes
    result.text.then(async (assistantText) => {
      try {
        const existingMessages = session.guidanceMessages
          ? JSON.parse(session.guidanceMessages)
          : [];

        // Add the latest user message
        const lastUserMsg = messages[messages.length - 1];
        if (lastUserMsg?.role === "user") {
          existingMessages.push({
            role: "user",
            content: lastUserMsg.content,
            timestamp: new Date().toISOString(),
          });
        }

        existingMessages.push({
          role: "assistant",
          content: assistantText,
          timestamp: new Date().toISOString(),
        });

        await prisma.synthesisSession.update({
          where: { id },
          data: { guidanceMessages: JSON.stringify(existingMessages) },
        });
      } catch (err) {
        console.error("[guide] Failed to persist messages:", err);
      }
    });

    return result.toTextStreamResponse();
  } catch (err) {
    console.error("[api/synthesis/[id]/guide] POST error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Guide chat failed" },
      { status: 500 }
    );
  }
}
