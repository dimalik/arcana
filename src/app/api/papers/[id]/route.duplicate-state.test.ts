import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const hoisted = vi.hoisted(() => ({
  requirePaperAccess: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    paper: {
      update: vi.fn(),
      delete: vi.fn(),
    },
  },
}));

vi.mock("@/lib/paper-auth", () => ({
  requirePaperAccess: hoisted.requirePaperAccess,
  paperAccessErrorToResponse: vi.fn(() => null),
  jsonWithDuplicateState: vi.fn((access, data, init, options) => {
    const body = options?.includeBodyState
      ? {
          ...data,
          duplicateState: access.duplicateState,
          collapsedIntoPaperId: access.collapsedIntoPaperId,
        }
      : data;
    const response = Response.json(body, init);
    return access.setDuplicateStateHeaders(response);
  }),
}));

import { GET } from "./route";

describe("GET /api/papers/[id] duplicate-state contract", () => {
  it("returns additive duplicate-state body fields plus headers", async () => {
    hoisted.requirePaperAccess.mockResolvedValue({
      userId: "user-1",
      duplicateState: "collapsed",
      collapsedIntoPaperId: "winner-1",
      paper: {
        id: "paper-1",
        title: "Duplicate loser",
        processingStatus: "COMPLETED",
      },
      setDuplicateStateHeaders(response: Response) {
        response.headers.set("X-Paper-Duplicate-State", "collapsed");
        response.headers.set("X-Paper-Collapsed-Into-Paper-Id", "winner-1");
        return response;
      },
    });

    const response = await GET(
      new NextRequest("http://localhost/api/papers/paper-1"),
      { params: { id: "paper-1" } },
    );

    expect(response.headers.get("X-Paper-Duplicate-State")).toBe("collapsed");
    expect(response.headers.get("X-Paper-Collapsed-Into-Paper-Id")).toBe("winner-1");
    expect(await response.json()).toEqual({
      id: "paper-1",
      title: "Duplicate loser",
      processingStatus: "COMPLETED",
      duplicateState: "collapsed",
      collapsedIntoPaperId: "winner-1",
    });
  });
});
