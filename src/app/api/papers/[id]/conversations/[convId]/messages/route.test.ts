import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const hoisted = vi.hoisted(() => ({
  requirePaperAccess: vi.fn(),
  chatMessageFindMany: vi.fn(),
  chatMessageCreate: vi.fn(),
  chatMessageFindFirst: vi.fn(),
  conversationFindUnique: vi.fn(),
  conversationUpdate: vi.fn(),
  conversationArtifactCreate: vi.fn(),
  streamLLMResponse: vi.fn(),
  withPaperLlmContext: vi.fn(),
  resolveModelConfig: vi.fn(),
  preparePaperAnswer: vi.fn(),
  buildChatMessageMetadata: vi.fn((value) => value),
  serializeChatMessageMetadata: vi.fn(() => "{\"intent\":\"timeline\",\"citations\":[{\"paperId\":\"paper-2\",\"paperTitle\":\"Paper 2\",\"snippet\":\"2024: Key advance\",\"sourceKind\":\"artifact\"}]}"),
  normalizeChatHistory: vi.fn((messages) => messages),
  extractChatMessageText: vi.fn(() => "Build a timeline"),
  trackEngagement: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    chatMessage: {
      findMany: hoisted.chatMessageFindMany,
      create: hoisted.chatMessageCreate,
      findFirst: hoisted.chatMessageFindFirst,
    },
    conversation: {
      findUnique: hoisted.conversationFindUnique,
      update: hoisted.conversationUpdate,
    },
    conversationArtifact: {
      create: hoisted.conversationArtifactCreate,
    },
  },
}));

vi.mock("@/lib/llm/provider", () => ({
  streamLLMResponse: hoisted.streamLLMResponse,
}));

vi.mock("@/lib/llm/paper-llm-context", () => ({
  PAPER_INTERACTIVE_LLM_OPERATIONS: {
    CONVERSATION_MESSAGE: "paper_conversation_message",
  },
  withPaperLlmContext: hoisted.withPaperLlmContext,
}));

vi.mock("@/lib/llm/auto-process", () => ({
  resolveModelConfig: hoisted.resolveModelConfig,
}));

vi.mock("@/lib/engagement/track", () => ({
  trackEngagement: hoisted.trackEngagement,
}));

vi.mock("@/lib/papers/answer-engine", () => ({
  preparePaperAnswer: hoisted.preparePaperAnswer,
  createConversationArtifact: vi.fn((_db, params) =>
    hoisted.conversationArtifactCreate({ data: params }),
  ),
  buildChatMessageMetadata: hoisted.buildChatMessageMetadata,
  serializeChatMessageMetadata: hoisted.serializeChatMessageMetadata,
  normalizeChatHistory: hoisted.normalizeChatHistory,
}));

vi.mock("@/lib/papers/answer-engine/chat-history", () => ({
  extractChatMessageText: hoisted.extractChatMessageText,
}));

vi.mock("@/lib/paper-auth", () => ({
  requirePaperAccess: hoisted.requirePaperAccess,
  paperAccessErrorToResponse: vi.fn(() => null),
  jsonWithDuplicateState: vi.fn((access, data, init) => {
    const response = Response.json(data, init);
    return access.setDuplicateStateHeaders(response);
  }),
}));

import { POST } from "./route";

describe("POST /api/papers/[id]/conversations/[convId]/messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("persists assistant metadata and typed artifacts from the shared answer engine", async () => {
    hoisted.requirePaperAccess.mockResolvedValue({
      userId: "user-1",
      paper: {
        id: "paper-1",
        title: "Seed paper",
        fullText: "Some full text",
        abstract: null,
      },
      setDuplicateStateHeaders(response: Response) {
        return response;
      },
    });
    hoisted.resolveModelConfig.mockResolvedValue({
      provider: "openai",
      modelId: "gpt-test",
      proxyConfig: null,
    });
    hoisted.preparePaperAnswer.mockResolvedValue({
      intent: "timeline",
      systemPrompt: "prepared-system",
      citations: [
        {
          paperId: "paper-2",
          paperTitle: "Paper 2",
          snippet: "2024: Key advance",
          sourceKind: "artifact",
        },
      ],
      artifacts: [
        {
          kind: "TIMELINE",
          title: "Idea timeline",
          payloadJson: "{\"timeline\":[{\"paperId\":\"paper-2\",\"year\":2024,\"keyAdvance\":\"Key advance\"}],\"narrative\":\"narrative\",\"openQuestions\":[]}",
        },
      ],
    });
    hoisted.withPaperLlmContext.mockImplementation(async (_context, callback) => callback());
    hoisted.streamLLMResponse.mockResolvedValue({
      text: Promise.resolve("assistant reply"),
      toTextStreamResponse: () => new Response("stream"),
    });
    hoisted.chatMessageCreate
      .mockResolvedValueOnce({ id: "user-msg" })
      .mockResolvedValueOnce({ id: "assistant-msg" });
    hoisted.conversationFindUnique.mockResolvedValue({ id: "conv-1", title: "Timeline chat" });

    await POST(
      new NextRequest("http://localhost/api/papers/paper-1/conversations/conv-1/messages", {
        method: "POST",
        body: JSON.stringify({
          messages: [{ role: "user", content: "Build a timeline" }],
        }),
      }),
      { params: Promise.resolve({ id: "paper-1", convId: "conv-1" }) },
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(hoisted.preparePaperAnswer).toHaveBeenCalledWith(
      expect.objectContaining({
        paperId: "paper-1",
        conversationId: "conv-1",
        question: "Build a timeline",
      }),
    );
    expect(hoisted.requirePaperAccess).toHaveBeenCalledWith("paper-1", {
      mode: "mutate",
      select: {
        id: true,
        title: true,
        abstract: true,
        summary: true,
        keyFindings: true,
        fullText: true,
      },
    });
    expect(hoisted.chatMessageCreate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          role: "assistant",
          metadataJson: expect.stringContaining("\"intent\":\"timeline\""),
        }),
      }),
    );
    expect(hoisted.conversationArtifactCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          conversationId: "conv-1",
          messageId: "assistant-msg",
          kind: "TIMELINE",
          title: "Idea timeline",
        }),
      }),
    );
  });

  it("prefers prepared code artifacts over split fenced blocks", async () => {
    hoisted.requirePaperAccess.mockResolvedValue({
      userId: "user-1",
      paper: {
        id: "paper-1",
        title: "Seed paper",
        fullText: "Some full text",
        abstract: null,
      },
      setDuplicateStateHeaders(response: Response) {
        return response;
      },
    });
    hoisted.resolveModelConfig.mockResolvedValue({
      provider: "openai",
      modelId: "gpt-test",
      proxyConfig: null,
    });
    hoisted.preparePaperAnswer.mockResolvedValue({
      intent: "generated_artifact",
      systemPrompt: "prepared-system",
      citations: [],
      artifacts: [
        {
          kind: "CODE_SNIPPET",
          title: "Table 4 as LaTeX",
          payloadJson: JSON.stringify({
            summary: "Standalone LaTeX table for Table 4.",
            code: "\\begin{table}\n...\\end{table}",
            filename: "table-4.tex",
            language: "latex",
            assumptions: [],
          }),
        },
      ],
    });
    hoisted.withPaperLlmContext.mockImplementation(async (_context, callback) => callback());
    hoisted.streamLLMResponse.mockResolvedValue({
      text: Promise.resolve(
        "Here is Table 4 written in LaTeX:\n\n```latex\n% header.tex\n\\\\usepackage{booktabs}\n```\n\nInclude the following packages in your preamble:\n\n```latex\n% body.tex\n\\\\begin{table}\nfoo\n\\\\end{table}\n```",
      ),
      toTextStreamResponse: () => new Response("stream"),
    });
    hoisted.chatMessageCreate
      .mockResolvedValueOnce({ id: "user-msg" })
      .mockResolvedValueOnce({ id: "assistant-msg" });
    hoisted.conversationFindUnique.mockResolvedValue({ id: "conv-1", title: "Artifact chat" });

    await POST(
      new NextRequest("http://localhost/api/papers/paper-1/conversations/conv-1/messages", {
        method: "POST",
        body: JSON.stringify({
          messages: [{ role: "user", content: "Write the table as tex" }],
        }),
      }),
      { params: Promise.resolve({ id: "paper-1", convId: "conv-1" }) },
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(hoisted.chatMessageCreate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          content: "",
        }),
      }),
    );
    expect(hoisted.conversationArtifactCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          kind: "CODE_SNIPPET",
          title: "Table 4 as LaTeX",
          payloadJson: expect.stringContaining("\"filename\":\"table-4.tex\""),
        }),
      }),
    );
    expect(hoisted.conversationArtifactCreate).toHaveBeenCalledTimes(1);
  });
});
