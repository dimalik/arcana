import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const hoisted = vi.hoisted(() => ({
  requirePaperAccess: vi.fn(),
  chatMessageCreate: vi.fn(),
  streamLLMResponse: vi.fn(),
  withPaperLlmContext: vi.fn(),
  resolveModelConfig: vi.fn(),
  preparePaperAnswer: vi.fn(),
  buildChatMessageMetadata: vi.fn((value) => value),
  serializeChatMessageMetadata: vi.fn(() => "{\"intent\":\"claims\",\"citations\":[{\"paperId\":\"paper-1\",\"paperTitle\":\"Seed\",\"snippet\":\"Claim text\",\"sourceKind\":\"claim\"}]}"),
  normalizeChatHistory: vi.fn((messages) => messages),
  extractChatMessageText: vi.fn(() => "What are the key claims?"),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    chatMessage: {
      create: hoisted.chatMessageCreate,
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/llm/provider", () => ({
  streamLLMResponse: hoisted.streamLLMResponse,
}));

vi.mock("@/lib/llm/paper-llm-context", () => ({
  PAPER_INTERACTIVE_LLM_OPERATIONS: { CHAT: "paper_chat" },
  withPaperLlmContext: hoisted.withPaperLlmContext,
}));

vi.mock("@/lib/llm/auto-process", () => ({
  resolveModelConfig: hoisted.resolveModelConfig,
}));

vi.mock("@/lib/papers/answer-engine", () => ({
  preparePaperAnswer: hoisted.preparePaperAnswer,
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
  jsonWithDuplicateState: vi.fn(),
}));

import { POST } from "./route";

describe("POST /api/papers/[id]/llm/chat", () => {
  it("persists assistant metadata from the shared answer engine", async () => {
    hoisted.requirePaperAccess.mockResolvedValue({
      userId: "user-1",
      paper: {
        id: "paper-1",
        title: "Seed",
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
      intent: "claims",
      systemPrompt: "prepared-system",
      citations: [
        {
          paperId: "paper-1",
          paperTitle: "Seed",
          snippet: "Claim text",
          sourceKind: "claim",
        },
      ],
      artifacts: [],
    });
    hoisted.withPaperLlmContext.mockImplementation(async (_context, callback) => callback());
    hoisted.streamLLMResponse.mockResolvedValue({
      text: Promise.resolve("assistant reply"),
      toTextStreamResponse: () => new Response("stream"),
    });
    hoisted.chatMessageCreate
      .mockResolvedValueOnce({ id: "user-msg" })
      .mockResolvedValueOnce({ id: "assistant-msg" });

    await POST(
      new NextRequest("http://localhost/api/papers/paper-1/llm/chat", {
        method: "POST",
        body: JSON.stringify({
          messages: [{ role: "user", content: "What are the key claims?" }],
        }),
      }),
      { params: Promise.resolve({ id: "paper-1" }) },
    );

    await Promise.resolve();
    await Promise.resolve();

    expect(hoisted.preparePaperAnswer).toHaveBeenCalledWith(
      expect.objectContaining({
        paperId: "paper-1",
        question: "What are the key claims?",
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
          metadataJson: expect.stringContaining("\"intent\":\"claims\""),
        }),
      }),
    );
  });
});
