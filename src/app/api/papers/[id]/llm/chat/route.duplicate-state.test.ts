import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const hoisted = vi.hoisted(() => ({
  requirePaperAccess: vi.fn(),
  chatMessageCreate: vi.fn(),
  chatMessageFindMany: vi.fn(),
  streamLLMResponse: vi.fn(),
  withPaperLlmContext: vi.fn(),
  resolveModelConfig: vi.fn(),
  preparePaperAnswer: vi.fn(),
  buildChatMessageMetadata: vi.fn((value) => value),
  serializeChatMessageMetadata: vi.fn(() => "{\"intent\":\"direct_qa\",\"citations\":[]}"),
  normalizeChatHistory: vi.fn((messages) => messages),
  extractChatMessageText: vi.fn(() => "Summarize this paper"),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    chatMessage: {
      create: hoisted.chatMessageCreate,
      findMany: hoisted.chatMessageFindMany,
    },
  },
}));

vi.mock("@/lib/llm/provider", () => ({
  streamLLMResponse: hoisted.streamLLMResponse,
  truncateText: vi.fn((text: string) => text),
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
  jsonWithDuplicateState: vi.fn((access, data, init) => {
    const response = Response.json(data, init);
    return access.setDuplicateStateHeaders(response);
  }),
}));

import { POST } from "./route";

describe("POST /api/papers/[id]/llm/chat duplicate-state contract", () => {
  it("adds duplicate-state headers to the text stream response", async () => {
    hoisted.requirePaperAccess.mockResolvedValue({
      userId: "user-1",
      paper: {
        id: "paper-1",
        title: "Paper chat",
        fullText: "Full text",
        abstract: null,
      },
      setDuplicateStateHeaders(response: Response) {
        response.headers.set("X-Paper-Duplicate-State", "collapsed");
        response.headers.set("X-Paper-Collapsed-Into-Paper-Id", "winner-1");
        return response;
      },
    });
    hoisted.resolveModelConfig.mockResolvedValue({
      provider: "openai",
      modelId: "gpt-test",
      proxyConfig: null,
    });
    hoisted.preparePaperAnswer.mockResolvedValue({
      intent: "direct_qa",
      systemPrompt: "prepared-system",
      citations: [],
      artifacts: [],
    });
    hoisted.withPaperLlmContext.mockImplementation(async (_context, callback) => callback());
    hoisted.streamLLMResponse.mockResolvedValue({
      text: Promise.resolve("assistant reply"),
      toTextStreamResponse: () => new Response("stream-payload"),
    });
    hoisted.chatMessageCreate.mockResolvedValue({});

    const response = await POST(
      new NextRequest("http://localhost/api/papers/paper-1/llm/chat", {
        method: "POST",
        body: JSON.stringify({
          messages: [{ role: "user", content: "Summarize this paper" }],
        }),
      }),
      { params: Promise.resolve({ id: "paper-1" }) },
    );

    expect(response.headers.get("X-Paper-Duplicate-State")).toBe("collapsed");
    expect(response.headers.get("X-Paper-Collapsed-Into-Paper-Id")).toBe("winner-1");
    expect(await response.text()).toBe("stream-payload");
  });
});
