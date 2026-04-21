import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { streamLLMResponse } from "@/lib/llm/provider";
import { extractFencedArtifacts } from "@/lib/chat/fenced-artifacts";
import {
  PAPER_INTERACTIVE_LLM_OPERATIONS,
  withPaperLlmContext,
} from "@/lib/llm/paper-llm-context";
import { resolveModelConfig } from "@/lib/llm/auto-process";
import {
  jsonWithDuplicateState,
  paperAccessErrorToResponse,
  requirePaperAccess,
} from "@/lib/paper-auth";
import {
  buildChatMessageMetadata,
  normalizeChatHistory,
  preparePaperAnswer,
  serializeChatMessageMetadata,
  type ChatMessageMetadata,
} from "@/lib/papers/answer-engine";
import { extractChatMessageText } from "@/lib/papers/answer-engine/chat-history";

const CHAT_PAPER_ACCESS_SELECT = {
  id: true,
  title: true,
  abstract: true,
  summary: true,
  keyFindings: true,
  fullText: true,
} as const;

function buildArtifactDraftsFromFences(
  content: string,
): Array<{ kind: "CODE_SNIPPET"; title: string; payloadJson: string }> {
  const { artifacts } = extractFencedArtifacts(content, 1);
  return artifacts.map((artifact, index) => ({
    kind: "CODE_SNIPPET",
    title: artifact.filename || `Artifact ${index + 1}`,
    payloadJson: JSON.stringify({
      summary: null,
      code: artifact.code,
      filename: artifact.filename || `artifact-${index + 1}${artifact.language ? `.${artifact.language}` : ".txt"}`,
      language: artifact.language || "text",
      assumptions: [],
    }),
  }));
}

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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
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
    const paper = access.paper;
    if (!hasAnswerablePaperText(paper)) {
      return new Response(
        JSON.stringify({ error: "No text available" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }
      );
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
      question,
      provider,
      modelId,
      proxyConfig,
      userId: access.userId,
    });

    if (lastUserMessage?.role === "user") {
      await prisma.chatMessage.create({
        data: {
          paperId: id,
          role: "user",
          content: question,
          provider,
          model: modelId,
        },
      });
    }

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
          system: prepared.systemPrompt,
          messages: normalizeChatHistory(messages),
          proxyConfig: proxyConfig ?? undefined,
        }),
    );

    result.text.then(async (fullText) => {
      const parsed = extractFencedArtifacts(fullText, 1);
      const generatedArtifacts = buildArtifactDraftsFromFences(fullText);
      const persistedArtifacts =
        generatedArtifacts.length > 0
          ? [
              ...prepared.artifacts.filter((artifact) => artifact.kind !== "CODE_SNIPPET"),
              ...generatedArtifacts,
            ]
          : prepared.artifacts;
      const metadataJson = serializeChatMessageMetadata(
        buildChatMessageMetadata({
          intent: prepared.intent,
          citations: prepared.citations,
          agentActions: prepared.agentActions,
          artifacts: persistedArtifacts,
        }),
      );

      await prisma.chatMessage.create({
        data: {
          paperId: id,
          role: "assistant",
          content: parsed.prose || fullText,
          metadataJson,
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
    select: {
      id: true,
      paperId: true,
      role: true,
      content: true,
      metadataJson: true,
      provider: true,
      model: true,
      conversationId: true,
      createdAt: true,
    },
  });
  return jsonWithDuplicateState(access, messages);
}
