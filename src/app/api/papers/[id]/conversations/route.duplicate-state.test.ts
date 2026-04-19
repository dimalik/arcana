import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const hoisted = vi.hoisted(() => ({
  requirePaperAccess: vi.fn(),
  findMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    conversation: {
      findMany: hoisted.findMany,
      create: vi.fn(),
    },
  },
}));

vi.mock("@/lib/paper-auth", () => ({
  requirePaperAccess: hoisted.requirePaperAccess,
  paperAccessErrorToResponse: vi.fn(() => null),
  jsonWithDuplicateState: vi.fn((access, data, init) => {
    const response = Response.json(data, init);
    return access.setDuplicateStateHeaders(response);
  }),
}));

import { GET } from "./route";

describe("GET /api/papers/[id]/conversations duplicate-state contract", () => {
  it("keeps the bare-array response shape and adds only headers", async () => {
    hoisted.requirePaperAccess.mockResolvedValue({
      duplicateState: "hidden",
      collapsedIntoPaperId: null,
      setDuplicateStateHeaders(response: Response) {
        response.headers.set("X-Paper-Duplicate-State", "hidden");
        return response;
      },
    });
    hoisted.findMany.mockResolvedValue([
      { id: "conv-1", title: "Conversation" },
    ]);

    const response = await GET(
      new NextRequest("http://localhost/api/papers/paper-1/conversations"),
      { params: Promise.resolve({ id: "paper-1" }) },
    );

    expect(response.headers.get("X-Paper-Duplicate-State")).toBe("hidden");
    expect(await response.json()).toEqual([
      { id: "conv-1", title: "Conversation" },
    ]);
  });
});
