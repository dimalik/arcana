import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const hoisted = vi.hoisted(() => ({
  requirePaperAccess: vi.fn(),
  readFile: vi.fn(),
  trackEngagement: vi.fn(() => Promise.resolve()),
}));

vi.mock("fs/promises", () => ({
  readFile: hoisted.readFile,
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: vi.fn(),
    paper: {
      update: vi.fn(),
    },
  },
}));

vi.mock("@/lib/upload", () => ({
  saveUploadedFile: vi.fn(),
}));

vi.mock("@/lib/processing/queue", () => ({
  processingQueue: { enqueue: vi.fn() },
}));

vi.mock("@/lib/processing/runtime-ledger", () => ({
  setProcessingProjection: vi.fn(),
}));

vi.mock("@/lib/engagement/track", () => ({
  trackEngagement: hoisted.trackEngagement,
}));

vi.mock("@/lib/paper-auth", () => ({
  requirePaperAccess: hoisted.requirePaperAccess,
  paperAccessErrorToResponse: vi.fn(() => null),
}));

import { GET } from "./route";

describe("GET /api/papers/[id]/file duplicate-state contract", () => {
  it("falls back to the active database project root for relative file paths", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "file:/Users/dimi/projects/paper_finder_unscrubbed_backup_20260417/prisma/dev.db";

    hoisted.requirePaperAccess.mockResolvedValue({
      paper: { filePath: "uploads/paper.pdf", title: "Binary route paper" },
      setDuplicateStateHeaders(response: Response) {
        response.headers.set("X-Paper-Duplicate-State", "active");
        return response;
      },
    });
    hoisted.readFile
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }))
      .mockResolvedValueOnce(Buffer.from("pdf-bytes"));

    const response = await GET(
      new NextRequest("http://localhost/api/papers/paper-1/file"),
      { params: { id: "paper-1" } },
    );

    expect(hoisted.readFile).toHaveBeenNthCalledWith(
      1,
      "/Users/dimi/projects/paper_finder/uploads/paper.pdf",
    );
    expect(hoisted.readFile).toHaveBeenNthCalledWith(
      2,
      "/Users/dimi/projects/paper_finder_unscrubbed_backup_20260417/uploads/paper.pdf",
    );
    expect(response.headers.get("Content-Type")).toBe("application/pdf");

    process.env.DATABASE_URL = previousDatabaseUrl;
  });

  it("keeps the binary response body and adds duplicate-state headers", async () => {
    hoisted.requirePaperAccess.mockResolvedValue({
      paper: { filePath: "uploads/paper.pdf", title: "Binary route paper" },
      setDuplicateStateHeaders(response: Response) {
        response.headers.set("X-Paper-Duplicate-State", "archived");
        return response;
      },
    });
    hoisted.readFile.mockResolvedValue(Buffer.from("pdf-bytes"));

    const response = await GET(
      new NextRequest("http://localhost/api/papers/paper-1/file"),
      { params: { id: "paper-1" } },
    );

    expect(response.headers.get("X-Paper-Duplicate-State")).toBe("archived");
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect((await response.arrayBuffer()).byteLength).toBe(9);
  });
});
