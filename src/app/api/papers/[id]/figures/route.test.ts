import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    paperFigure: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/paper-auth", () => ({
  requirePaperAccess: vi.fn(),
}));

vi.mock("@/lib/figures/extract-all-figures", () => ({
  extractAllFigures: vi.fn(),
}));

vi.mock("@/lib/figures/read-model", () => ({
  FIGURE_VIEW_SELECT: { id: true },
  mapPaperFiguresToView: vi.fn((rows: unknown[]) => rows),
}));

import { prisma } from "@/lib/prisma";
import { requirePaperAccess } from "@/lib/paper-auth";
import { extractAllFigures } from "@/lib/figures/extract-all-figures";
import { GET, POST } from "./route";

describe("figures route", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns 404 for GET when the paper is not owned by the viewer", async () => {
    vi.mocked(requirePaperAccess).mockResolvedValue(null as never);

    const response = await GET(
      new NextRequest("http://localhost/api/papers/paper-1/figures"),
      { params: { id: "paper-1" } },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Paper not found" });
    expect(prisma.paperFigure.findMany).not.toHaveBeenCalled();
  });

  it("returns the explicit published read-model shape for GET", async () => {
    vi.mocked(requirePaperAccess).mockResolvedValue({ id: "paper-1", userId: "user-1" } as never);
    vi.mocked(prisma.paperFigure.findMany).mockResolvedValue([
      {
        id: "fig-1",
        paperId: "paper-1",
        publishedFigureHandleId: "handle-1",
        figureLabel: "Figure 1",
        captionText: "Main result",
        captionSource: "html_figcaption",
        description: "A useful chart",
        sourceMethod: "arxiv_html",
        sourceUrl: "https://arxiv.org/html/1234.5678",
        sourceVersion: "preview-selection-v1",
        confidence: "high",
        imagePath: "/tmp/figure-1.png",
        assetHash: "asset-1",
        pdfPage: 4,
        sourcePage: null,
        figureIndex: 0,
        bbox: "10,20,30,40",
        type: "figure",
        parentFigureId: null,
        isPrimaryExtraction: true,
        width: 640,
        height: 480,
        gapReason: null,
        imageSourceMethod: "arxiv_html",
        createdAt: new Date("2026-04-17T18:40:00.000Z"),
      },
    ] as never);

    const response = await GET(
      new NextRequest("http://localhost/api/papers/paper-1/figures"),
      { params: { id: "paper-1" } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      {
        id: "fig-1",
        paperId: "paper-1",
        publishedFigureHandleId: "handle-1",
        figureLabel: "Figure 1",
        captionText: "Main result",
        captionSource: "html_figcaption",
        description: "A useful chart",
        sourceMethod: "arxiv_html",
        sourceUrl: "https://arxiv.org/html/1234.5678",
        sourceVersion: "preview-selection-v1",
        confidence: "high",
        imagePath: "/tmp/figure-1.png",
        assetHash: "asset-1",
        pdfPage: 4,
        sourcePage: null,
        figureIndex: 0,
        bbox: "10,20,30,40",
        type: "figure",
        parentFigureId: null,
        isPrimaryExtraction: true,
        width: 640,
        height: 480,
        gapReason: null,
        imageSourceMethod: "arxiv_html",
        createdAt: "2026-04-17T18:40:00.000Z",
      },
    ]);
  });

  it("returns 404 for POST when the paper is not owned by the viewer", async () => {
    vi.mocked(requirePaperAccess).mockResolvedValue(null as never);

    const response = await POST(
      new NextRequest("http://localhost/api/papers/paper-1/figures", {
        method: "POST",
        body: JSON.stringify({ maxPages: 20 }),
      }),
      { params: { id: "paper-1" } },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Paper not found" });
    expect(extractAllFigures).not.toHaveBeenCalled();
  });

  it("maps successful POST extraction to HTTP 200", async () => {
    vi.mocked(requirePaperAccess).mockResolvedValue({ id: "paper-1", userId: "user-1" } as never);
    vi.mocked(extractAllFigures).mockResolvedValue({
      paperId: "paper-1",
      context: "route",
      status: "success",
      sources: [],
      totalFigures: 3,
      figuresWithImages: 2,
      gapPlaceholders: 1,
      persistErrors: 0,
      error: null,
    } as never);

    const response = await POST(
      new NextRequest("http://localhost/api/papers/paper-1/figures", {
        method: "POST",
        body: JSON.stringify({ maxPages: 20 }),
      }),
      { params: { id: "paper-1" } },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      status: "success",
      totalFigures: 3,
    });
    expect(extractAllFigures).toHaveBeenCalledWith("paper-1", { context: "route", maxPages: 20 });
  });

  it("maps partial extraction to HTTP 207", async () => {
    vi.mocked(requirePaperAccess).mockResolvedValue({ id: "paper-1", userId: "user-1" } as never);
    vi.mocked(extractAllFigures).mockResolvedValue({
      paperId: "paper-1",
      context: "route",
      status: "partial",
      sources: [],
      totalFigures: 3,
      figuresWithImages: 2,
      gapPlaceholders: 1,
      persistErrors: 1,
      error: "rolled back",
    } as never);

    const response = await POST(
      new NextRequest("http://localhost/api/papers/paper-1/figures", {
        method: "POST",
        body: JSON.stringify({ maxPages: 20 }),
      }),
      { params: { id: "paper-1" } },
    );

    expect(response.status).toBe(207);
    expect(await response.json()).toMatchObject({
      ok: false,
      status: "partial",
      persistErrors: 1,
    });
  });

  it("maps publication conflicts to HTTP 409", async () => {
    vi.mocked(requirePaperAccess).mockResolvedValue({ id: "paper-1", userId: "user-1" } as never);
    vi.mocked(extractAllFigures).mockResolvedValue({
      paperId: "paper-1",
      context: "route",
      status: "conflict",
      sources: [],
      totalFigures: 0,
      figuresWithImages: 0,
      gapPlaceholders: 0,
      persistErrors: 0,
      error: "paper paper-1 is already leased",
    } as never);

    const response = await POST(
      new NextRequest("http://localhost/api/papers/paper-1/figures", {
        method: "POST",
        body: JSON.stringify({ maxPages: 20 }),
      }),
      { params: { id: "paper-1" } },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      ok: false,
      status: "conflict",
    });
  });

  it("returns HTTP 500 for unexpected extraction failures", async () => {
    vi.mocked(requirePaperAccess).mockResolvedValue({ id: "paper-1", userId: "user-1" } as never);
    vi.mocked(extractAllFigures).mockRejectedValue(new Error("boom"));

    const response = await POST(
      new NextRequest("http://localhost/api/papers/paper-1/figures", {
        method: "POST",
        body: JSON.stringify({ maxPages: 20 }),
      }),
      { params: { id: "paper-1" } },
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Extraction failed: boom" });
  });
});
