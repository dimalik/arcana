import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { streamLLMResponse, truncateText } from "@/lib/llm/provider";
import {
  PAPER_INTERACTIVE_LLM_OPERATIONS,
  withPaperLlmContext,
} from "@/lib/llm/paper-llm-context";
import { SYSTEM_PROMPTS } from "@/lib/llm/prompts";
import { resolveModelConfig } from "@/lib/llm/auto-process";
import { requireUserId } from "@/lib/paper-auth";
import { getUserContext, buildUserContextPreamble } from "@/lib/llm/user-context";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const userId = await requireUserId();
  const { id } = await params;
  const body = await request.json();
  const { messages } = body;
  const { provider, modelId, proxyConfig } = await resolveModelConfig(body);

  const paper = await prisma.paper.findFirst({
    where: { id, userId },
  });

  if (!paper) {
    return new Response(JSON.stringify({ error: "Paper not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const text = paper.fullText || paper.abstract || "";
  if (!text) {
    return new Response(
      JSON.stringify({ error: "No text available" }),
      {
        status: 400,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const truncated = truncateText(text, modelId, proxyConfig);
  const userCtx = await getUserContext(userId);
  const preamble = buildUserContextPreamble(userCtx);
  const systemPrompt = `${SYSTEM_PROMPTS.chat}${preamble}\n\nPaper: "${paper.title}"\n\nFull text:\n${truncated}`;

  // Save user message
  const lastUserMessage = messages[messages.length - 1];
  if (lastUserMessage?.role === "user") {
    const content =
      lastUserMessage.content ||
      (lastUserMessage.parts
        ?.filter((p: { type: string }) => p.type === "text")
        .map((p: { text: string }) => p.text)
        .join("")) ||
      "";
    await prisma.chatMessage.create({
      data: {
        paperId: id,
        role: "user",
        content,
        provider,
        model: modelId,
      },
    });
  }

  // Normalize messages: AI SDK v6 sends parts-based format, streamText needs content strings
  const normalizedMessages = messages.map(
    (m: { role: string; content?: string; parts?: { type: string; text: string }[] }) => ({
      role: m.role as "user" | "assistant",
      content:
        m.content ||
        (m.parts
          ?.filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("")) ||
        "",
    })
  );

  const result = await withPaperLlmContext(
    {
      operation: PAPER_INTERACTIVE_LLM_OPERATIONS.CHAT,
      paperId: id,
      userId,
      runtime: "interactive",
      source: "papers.llm.chat",
    },
    () =>
      streamLLMResponse({
        provider,
        modelId,
        system: systemPrompt,
        messages: normalizedMessages,
        proxyConfig,
      }),
  );

  // Save assistant message after streaming completes
  result.text.then(async (fullText) => {
    await prisma.chatMessage.create({
      data: {
        paperId: id,
        role: "assistant",
        content: fullText,
        provider,
        model: modelId,
      },
    });
  });

  return result.toTextStreamResponse();
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const messages = await prisma.chatMessage.findMany({
    where: { paperId: id },
    orderBy: { createdAt: "asc" },
  });
  return new Response(JSON.stringify(messages), {
    headers: { "Content-Type": "application/json" },
  });
}
