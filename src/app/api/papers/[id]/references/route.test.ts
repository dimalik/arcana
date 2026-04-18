import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const hoisted = vi.hoisted(() => ({
  requirePaperAccess: vi.fn(),
  listPaperReferenceViews: vi.fn(),
  deleteReferenceEntryWithLegacyProjection: vi.fn(),
}));

vi.mock("@/lib/paper-auth", () => ({
  requirePaperAccess: hoisted.requirePaperAccess,
}));

vi.mock("@/lib/references/read-model", () => ({
  listPaperReferenceViews: hoisted.listPaperReferenceViews,
}));

vi.mock("@/lib/citations/reference-entry-service", () => ({
  deleteReferenceEntryWithLegacyProjection:
    hoisted.deleteReferenceEntryWithLegacyProjection,
}));

import { GET } from "./route";

describe("GET /api/papers/[id]/references", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the widened referenceState + references payload", async () => {
    hoisted.requirePaperAccess.mockResolvedValue({
      id: "paper-1",
      userId: "user-1",
      referenceState: "available",
    });
    hoisted.listPaperReferenceViews.mockResolvedValue([
      { id: "ref-1", title: "Reference One" },
    ]);

    const response = await GET(
      new NextRequest("http://localhost/api/papers/paper-1/references"),
      { params: Promise.resolve({ id: "paper-1" }) },
    );
    const body = await response.json();

    expect(body).toEqual({
      referenceState: "available",
      references: [{ id: "ref-1", title: "Reference One" }],
    });
  });
});
