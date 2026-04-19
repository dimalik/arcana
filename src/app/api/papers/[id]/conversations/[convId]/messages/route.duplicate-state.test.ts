import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const hoisted = vi.hoisted(() => ({
  requirePaperAccess: vi.fn(),
  chatMessageFindMany: vi.fn(),
  chatMessageCreate: vi.fn(),
  conversationPaperFindMany: vi.fn(),
  conversationFindUnique: vi.fn(),
  conversationUpdate: vi.fn(),
  streamLLMResponse: vi.fn(),
  withPaperLlmContext: vi.fn(),
  resolveModelConfig: vi.fn(),
  getUserContext: vi.fn(),
  buildUserContextPreamble: vi.fn(() => ""),
  trackEngagement: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    chatMessage: {
      findMany: hoisted.chatMessageFindMany,
      create: hoisted.chatMessageCreate,
      findFirst: vi.fn(),
    },
    conversationPaper: {
      findMany: hoisted.conversationPaperFindMany,
    },
    conversation: {
      findUnique: hoisted.conversationFindUnique,
      update: hoisted.conversationUpdate,
    },
  },
}));

vi.mock("@/lib/llm/provider", () => ({
  streamLLMResponse: hoisted.streamLLMResponse,
  truncateTextMultiPaper: vi.fn((primary: string) => ({ primary, additional: [] })),
}));

vi.mock("@/lib/llm/paper-llm-context", () => ({
  PAPER_INTERACTIVE_LLM_OPERATIONS: { CONVERSATION_MESSAGE: "conversation_message" },
  withPaperLlmContext: hoisted.withPaperLlmContext,
}));

vi.mock("@/lib/llm/auto-process", () => ({
  resolveModelConfig: hoisted.resolveModelConfig,
}));

vi.mock("@/lib/engagement/track", () => ({
  trackEngagement: hoisted.trackEngagement,
}));

vi.mock("@/lib/llm/prompts", () => ({
  SYSTEM_PROMPTS: { chat: "system-prompt" },
}));

vi.mock("@/lib/llm/user-context", () => ({
  getUserContext: hoisted.getUserContext,
  buildUserContextPreamble: hoisted.buildUserContextPreamble,
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

describe("POST /api/papers/[id]/conversations/[convId]/messages duplicate-state contract", () => {
  it("adds duplicate-state headers to the message stream response", async () => {
    hoisted.requirePaperAccess.mockResolvedValue({
      userId: "user-1",
      paper: {
        id: "paper-1",
        title: "Conversation paper",
        fullText: "Full text",
        abstract: null,
      },
      setDuplicateStateHeaders(response: Response) {
        response.headers.set("X-Paper-Duplicate-State", "active");
        return response;
      },
    });
    hoisted.resolveModelConfig.mockResolvedValue({
      provider: "openai",
      modelId: "gpt-test",
      proxyConfig: null,
    });
    hoisted.getUserContext.mockResolvedValue(null);
    hoisted.chatMessageFindMany.mockResolvedValue([]);
    hoisted.chatMessageCreate.mockResolvedValue({});
    hoisted.conversationPaperFindMany.mockResolvedValue([]);
    hoisted.conversationFindUnique.mockResolvedValue(null);
    hoisted.withPaperLlmContext.mockImplementation(async (_context, callback) => callback());
    hoisted.streamLLMResponse.mockResolvedValue({
      text: Promise.resolve("assistant reply"),
      toTextStreamResponse: () => new Response("message-stream"),
    });

    const response = await POST(
      new NextRequest("http://localhost/api/papers/paper-1/conversations/conv-1/messages", {
        method: "POST",
        body: JSON.stringify({
          messages: [{ role: "user", content: "Explain the method" }],
        }),
      }),
      { params: Promise.resolve({ id: "paper-1", convId: "conv-1" }) },
    );

    expect(response.headers.get("X-Paper-Duplicate-State")).toBe("active");
    expect(await response.text()).toBe("message-stream");
  });
});
