import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  streamLLMResponse,
  truncateTextMultiPaper,
} from "@/lib/llm/provider";
import {
  PAPER_INTERACTIVE_LLM_OPERATIONS,
  withPaperLlmContext,
} from "@/lib/llm/paper-llm-context";
import { SYSTEM_PROMPTS } from "@/lib/llm/prompts";
import { resolveModelConfig } from "@/lib/llm/auto-process";
import { trackEngagement } from "@/lib/engagement/track";
import {
  jsonWithDuplicateState,
  paperAccessErrorToResponse,
  requirePaperAccess,
} from "@/lib/paper-auth";
import { getUserContext, buildUserContextPreamble } from "@/lib/llm/user-context";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; convId: string }> }
) {
  const { id, convId } = await params;
  const access = await requirePaperAccess(id, { mode: "read" });
  if (!access) {
    return new Response(JSON.stringify({ error: "Paper not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const messages = await prisma.chatMessage.findMany({
    where: { conversationId: convId },
    orderBy: { createdAt: "asc" },
  });

  return jsonWithDuplicateState(access, messages);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; convId: string }> }
) {
  try {
    const { id, convId } = await params;
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

    const primaryText = paper.fullText || paper.abstract || "";
    if (!primaryText) {
      return new Response(JSON.stringify({ error: "No text available" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const conversationPapers = await prisma.conversationPaper.findMany({
      where: { conversationId: convId },
      include: { paper: { select: { id: true, title: true, fullText: true, abstract: true } } },
    });

    const additionalTexts = conversationPapers
      .map((cp) => ({
        title: cp.paper.title,
        text: cp.paper.fullText || cp.paper.abstract || "",
      }))
      .filter((p) => p.text);

    const { primary, additional } = truncateTextMultiPaper(
      primaryText,
      additionalTexts,
      modelId,
      proxyConfig
    );

    const brief = body.brief === true;
    const briefSuffix = brief
      ? "\n\nIMPORTANT: Be very concise and brief. Use 2-4 sentences maximum. Get straight to the point — no preamble, no filler."
      : "";

    const userCtx = await getUserContext(access.userId);
    const userPreamble = buildUserContextPreamble(userCtx);
    let systemPrompt = `${SYSTEM_PROMPTS.chat}${userPreamble}${briefSuffix}\n\nPrimary Paper: "${paper.title}"\n\nFull text:\n${primary}`;

    if (additional.length > 0) {
      systemPrompt += "\n\n---\n\nAdditional referenced papers:\n";
      for (const additionalPaper of additional) {
        systemPrompt += `\n### ${additionalPaper.title}\n${additionalPaper.text}\n`;
      }
    }

    const lastUserMessage = messages[messages.length - 1];
    if (lastUserMessage?.role === "user") {
      let textContent: string;
      if (typeof lastUserMessage.content === "string") {
        textContent = lastUserMessage.content;
      } else if (Array.isArray(lastUserMessage.content)) {
        textContent = lastUserMessage.content
          .filter((p: { type: string }) => p.type === "text")
          .map((p: { text: string }) => p.text)
          .join("");
      } else {
        textContent = lastUserMessage.parts
          ?.filter((p: { type: string }) => p.type === "text")
          .map((p: { text: string }) => p.text)
          .join("") || "";
      }
      await prisma.chatMessage.create({
        data: {
          paperId: id,
          conversationId: convId,
          role: "user",
          content: textContent,
          provider,
          model: modelId,
        },
      });

      trackEngagement(id, "chat").catch(() => {});
    }

    const normalizedMessages = messages.map(
      (message: {
        role: string;
        content?: string | Array<{ type: string; text?: string; image?: string; mediaType?: string }>;
        parts?: { type: string; text: string }[];
      }) => {
        if (Array.isArray(message.content)) {
          const parts = message.content.map((part) => {
            if (part.type === "image" && part.image) {
              const dataUrlMatch = part.image.match(/^data:([^;]+);base64,(.+)$/);
              if (dataUrlMatch) {
                return { type: "image" as const, image: dataUrlMatch[2], mediaType: dataUrlMatch[1] };
              }
              return { type: "image" as const, image: part.image, mediaType: part.mediaType };
            }
            return { type: "text" as const, text: part.text || "" };
          });
          return { role: message.role as "user" | "assistant", content: parts };
        }

        return {
          role: message.role as "user" | "assistant",
          content:
            (typeof message.content === "string" ? message.content : null) ||
            message.parts
              ?.filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("") ||
            "",
        };
      }
    );

    const result = await withPaperLlmContext(
      {
        operation: PAPER_INTERACTIVE_LLM_OPERATIONS.CONVERSATION_MESSAGE,
        paperId: id,
        userId: access.userId,
        runtime: "interactive",
        source: "papers.conversations.message",
        metadata: { conversationId: convId },
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
          conversationId: convId,
          role: "assistant",
          content: fullText,
          provider,
          model: modelId,
        },
      });

      const conversation = await prisma.conversation.findUnique({
        where: { id: convId },
      });
      if (conversation && !conversation.title) {
        const firstUserMsg = await prisma.chatMessage.findFirst({
          where: { conversationId: convId, role: "user" },
          orderBy: { createdAt: "asc" },
        });
        if (firstUserMsg) {
          const autoTitle =
            firstUserMsg.content.length > 60
              ? `${firstUserMsg.content.slice(0, 57)}...`
              : firstUserMsg.content;
          await prisma.conversation.update({
            where: { id: convId },
            data: { title: autoTitle },
          });
        }
      }
    });

    return access.setDuplicateStateHeaders(result.toTextStreamResponse());
  } catch (error) {
    const response = paperAccessErrorToResponse(error);
    if (response) return response;
    throw error;
  }
}
