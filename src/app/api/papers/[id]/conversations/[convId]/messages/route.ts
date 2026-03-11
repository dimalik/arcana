import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  streamLLMResponse,
  truncateTextMultiPaper,
} from "@/lib/llm/provider";
import { SYSTEM_PROMPTS } from "@/lib/llm/prompts";
import { resolveModelConfig } from "@/lib/llm/auto-process";
import { trackEngagement } from "@/lib/engagement/track";
import { requireUserId } from "@/lib/paper-auth";
import { getUserContext, buildUserContextPreamble } from "@/lib/llm/user-context";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; convId: string }> }
) {
  const { convId } = await params;

  const messages = await prisma.chatMessage.findMany({
    where: { conversationId: convId },
    orderBy: { createdAt: "asc" },
  });

  return new Response(JSON.stringify(messages), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; convId: string }> }
) {
  const { id, convId } = await params;
  const body = await request.json();
  const { messages } = body;
  const { provider, modelId, proxyConfig } = await resolveModelConfig(body);

  // Fetch primary paper
  const userId = await requireUserId();
    const paper = await prisma.paper.findFirst({ where: { id, userId } });
  if (!paper) {
    return new Response(JSON.stringify({ error: "Paper not found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  const primaryText = paper.fullText || paper.abstract || "";
  if (!primaryText) {
    return new Response(JSON.stringify({ error: "No text available" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Fetch additional papers for this conversation
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

  // Build system prompt with multi-paper context
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

  const userCtx = await getUserContext(userId);
  const userPreamble = buildUserContextPreamble(userCtx);
  let systemPrompt = `${SYSTEM_PROMPTS.chat}${userPreamble}${briefSuffix}\n\nPrimary Paper: "${paper.title}"\n\nFull text:\n${primary}`;

  if (additional.length > 0) {
    systemPrompt += "\n\n---\n\nAdditional referenced papers:\n";
    for (const p of additional) {
      systemPrompt += `\n### ${p.title}\n${p.text}\n`;
    }
  }

  // Save user message (text only for DB storage)
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

  // Normalize messages for streamText — preserve multi-part content (images)
  const normalizedMessages = messages.map(
    (m: {
      role: string;
      content?: string | Array<{ type: string; text?: string; image?: string; mediaType?: string }>;
      parts?: { type: string; text: string }[];
    }) => {
      // If content is an array with image parts, convert to AI SDK format
      if (Array.isArray(m.content)) {
        const parts = m.content.map((p) => {
          if (p.type === "image" && p.image) {
            // Strip data URL prefix if present, pass raw base64
            const dataUrlMatch = p.image.match(/^data:([^;]+);base64,(.+)$/);
            if (dataUrlMatch) {
              return { type: "image" as const, image: dataUrlMatch[2], mediaType: dataUrlMatch[1] };
            }
            return { type: "image" as const, image: p.image, mediaType: p.mediaType };
          }
          return { type: "text" as const, text: p.text || "" };
        });
        return { role: m.role as "user" | "assistant", content: parts };
      }

      // String content or legacy parts format
      return {
        role: m.role as "user" | "assistant",
        content:
          (typeof m.content === "string" ? m.content : null) ||
          m.parts
            ?.filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("") ||
          "",
      };
    }
  );

  const result = await streamLLMResponse({
    provider,
    modelId,
    system: systemPrompt,
    messages: normalizedMessages,
    proxyConfig,
  });

  // Save assistant message after streaming completes, auto-title conversation
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

    // Auto-title: set title from first user message if still untitled
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
            ? firstUserMsg.content.slice(0, 57) + "..."
            : firstUserMsg.content;
        await prisma.conversation.update({
          where: { id: convId },
          data: { title: autoTitle },
        });
      }
    }
  });

  return result.toTextStreamResponse();
}
