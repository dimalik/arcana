import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { streamLLMResponse, truncateText } from "@/lib/llm/provider";
import {
  PAPER_INTERACTIVE_LLM_OPERATIONS,
  withPaperLlmContext,
} from "@/lib/llm/paper-llm-context";
import { SYSTEM_PROMPTS } from "@/lib/llm/prompts";
import { resolveModelConfig } from "@/lib/llm/auto-process";
import {
  jsonWithDuplicateState,
  paperAccessErrorToResponse,
  requirePaperAccess,
} from "@/lib/paper-auth";
import { getUserContext, buildUserContextPreamble } from "@/lib/llm/user-context";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const access = await requirePaperAccess(id, { mode: "mutate" });
    if (!access) {
      return new Response(JSON.stringify({ error: "Paper not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await request.json();
    const { messages } = body;
    const { provider, modelId, proxyConfig } = await resolveModelConfig(body);
    const paper = access.paper;

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
    const userCtx = await getUserContext(access.userId);
    const preamble = buildUserContextPreamble(userCtx);
    const systemPrompt = `${SYSTEM_PROMPTS.chat}${preamble}\n\nPaper: "${paper.title}"\n\nFull text:\n${truncated}`;

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
        userId: access.userId,
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

    return access.setDuplicateStateHeaders(result.toTextStreamResponse());
  } catch (error) {
    const response = paperAccessErrorToResponse(error);
    if (response) return response;
    throw error;
  }
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const access = await requirePaperAccess(id, { mode: "read" });
  if (!access) {
    return new Response(JSON.stringify({ error: "Paper not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }
  const messages = await prisma.chatMessage.findMany({
    where: { paperId: id },
    orderBy: { createdAt: "asc" },
  });
  return jsonWithDuplicateState(access, messages);
}
