import { NextRequest } from "next/server";

import {
  createConversationArtifact,
  buildChatMessageMetadata,
  normalizeChatHistory,
  preparePaperAnswer,
  serializeChatMessageMetadata,
} from "@/lib/papers/answer-engine";
import { finalizePaperChatArtifacts } from "@/lib/papers/answer-engine/chat-artifacts";
import { extractChatMessageText } from "@/lib/papers/answer-engine/chat-history";
import { trackEngagement } from "@/lib/engagement/track";
import { resolveModelConfig } from "@/lib/llm/auto-process";
import {
  PAPER_INTERACTIVE_LLM_OPERATIONS,
  withPaperLlmContext,
} from "@/lib/llm/paper-llm-context";
import { streamLLMResponse } from "@/lib/llm/provider";
import {
  jsonWithDuplicateState,
  paperAccessErrorToResponse,
  requirePaperAccess,
} from "@/lib/paper-auth";
import { prisma } from "@/lib/prisma";

const CHAT_PAPER_ACCESS_SELECT = {
  id: true,
  title: true,
  abstract: true,
  summary: true,
  keyFindings: true,
  fullText: true,
} as const;

function hasAnswerablePaperText(paper: {
  fullText?: string | null;
  abstract?: string | null;
  summary?: string | null;
  keyFindings?: string | null;
}) {
  return Boolean(
    paper.fullText || paper.abstract || paper.summary || paper.keyFindings,
  );
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; convId: string }> },
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
    include: {
      artifacts: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          kind: true,
          title: true,
          payloadJson: true,
          createdAt: true,
        },
      },
    },
  });

  return jsonWithDuplicateState(access, messages);
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; convId: string }> },
) {
  try {
    const { id, convId } = await params;
    const access = await requirePaperAccess(id, {
      mode: "mutate",
      select: CHAT_PAPER_ACCESS_SELECT,
    });
    if (!access) {
      return new Response(JSON.stringify({ error: "Paper not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const body = await request.json().catch(() => ({}));
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const { provider, modelId, proxyConfig } = await resolveModelConfig(body);

    if (!hasAnswerablePaperText(access.paper)) {
      return new Response(JSON.stringify({ error: "No text available" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (messages.length === 0) {
      return new Response(JSON.stringify({ error: "No messages provided" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const lastUserMessage = messages[messages.length - 1];
    const question = extractChatMessageText(lastUserMessage);
    const prepared = await preparePaperAnswer({
      paperId: id,
      conversationId: convId,
      question:
        body.brief === true
          ? `${question}\n\nKeep the answer very concise: 2-4 sentences maximum.`
          : question,
      provider,
      modelId,
      proxyConfig,
      userId: access.userId,
    });

    if (lastUserMessage?.role === "user") {
      await prisma.chatMessage.create({
        data: {
          paperId: id,
          conversationId: convId,
          role: "user",
          content: question,
          provider,
          model: modelId,
        },
      });

      trackEngagement(id, "chat").catch(() => {});
    }

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
          system: prepared.systemPrompt,
          messages: normalizeChatHistory(messages),
          proxyConfig: proxyConfig ?? undefined,
        }),
    );

    const metadataJson = serializeChatMessageMetadata(
      buildChatMessageMetadata({
        intent: prepared.intent,
        citations: prepared.citations,
        agentActions: prepared.agentActions,
      }),
    );

    result.text.then(async (fullText) => {
      const finalized = finalizePaperChatArtifacts({
        content: fullText,
        intent: prepared.intent,
        preparedArtifacts: prepared.artifacts,
      });

      const assistantMessage = await prisma.chatMessage.create({
        data: {
          paperId: id,
          conversationId: convId,
          role: "assistant",
          content: finalized.content,
          metadataJson,
          provider,
          model: modelId,
        },
      });

      for (const artifact of finalized.artifacts) {
        await createConversationArtifact(prisma, {
          conversationId: convId,
          messageId: assistantMessage.id,
          kind: artifact.kind,
          title: artifact.title,
          payloadJson: artifact.payloadJson,
        });
      }

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
