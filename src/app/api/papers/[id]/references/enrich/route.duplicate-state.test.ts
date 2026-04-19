import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const hoisted = vi.hoisted(() => ({
  requirePaperAccess: vi.fn(),
  findMany: vi.fn(),
  searchByTitle: vi.fn(),
  enrichReferenceEntryFromCandidate: vi.fn(),
  referenceEntryNeedsMetadataRepair: vi.fn(() => false),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    referenceEntry: {
      findMany: hoisted.findMany,
    },
  },
}));

vi.mock("@/lib/import/semantic-scholar", () => ({
  searchByTitle: hoisted.searchByTitle,
  S2RateLimitError: class S2RateLimitError extends Error {},
}));

vi.mock("@/lib/citations/reference-entry-service", () => ({
  enrichReferenceEntryFromCandidate: hoisted.enrichReferenceEntryFromCandidate,
  referenceEntryNeedsMetadataRepair: hoisted.referenceEntryNeedsMetadataRepair,
}));

vi.mock("@/lib/paper-auth", () => ({
  requirePaperAccess: hoisted.requirePaperAccess,
  paperAccessErrorToResponse: vi.fn(() => null),
}));

import { POST } from "./route";

describe("POST /api/papers/[id]/references/enrich duplicate-state contract", () => {
  it("adds duplicate-state headers before streaming progress output", async () => {
    hoisted.requirePaperAccess.mockResolvedValue({
      userId: "user-1",
      setDuplicateStateHeaders(response: Response) {
        response.headers.set("X-Paper-Duplicate-State", "active");
        return response;
      },
    });
    hoisted.findMany.mockResolvedValue([
      {
        id: "ref-1",
        title: "Reference One",
        authors: null,
        year: 2024,
        venue: null,
        semanticScholarId: null,
      },
    ]);
    hoisted.searchByTitle.mockResolvedValue({ title: "Reference One", year: 2024 });
    hoisted.enrichReferenceEntryFromCandidate.mockResolvedValue({
      mergeSummary: { title: "filled_missing" },
    });

    const response = await POST(
      new NextRequest("http://localhost/api/papers/paper-1/references/enrich", {
        method: "POST",
      }),
      { params: Promise.resolve({ id: "paper-1" }) },
    );

    expect(response.headers.get("X-Paper-Duplicate-State")).toBe("active");
    const text = await response.text();
    expect(text).toContain("\"type\":\"progress\"");
    expect(text).toContain("\"type\":\"done\"");
  });
});
