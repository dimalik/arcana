import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  prisma,
  launch,
  mkdir,
  writeFile,
  createRenderedPreview,
  createEnrichmentPreviewSelectionRun,
  publishPreviewSelectionRun,
  upsertRenderedPreviewAsset,
  acquirePaperWorkLease,
  releasePaperWorkLease,
} = vi.hoisted(() => ({
  prisma: {
    paperPublicationState: {
      findUnique: vi.fn(),
    },
    previewSelectionFigure: {
      findMany: vi.fn(),
    },
    renderRun: {
      create: vi.fn(),
      update: vi.fn(),
    },
    $transaction: vi.fn(),
  },
  launch: vi.fn(),
  mkdir: vi.fn(),
  writeFile: vi.fn(),
  createRenderedPreview: vi.fn(),
  createEnrichmentPreviewSelectionRun: vi.fn(),
  publishPreviewSelectionRun: vi.fn(),
  upsertRenderedPreviewAsset: vi.fn(),
  acquirePaperWorkLease: vi.fn(),
  releasePaperWorkLease: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma,
}));

vi.mock("playwright", () => ({
  chromium: {
    launch,
  },
}));

vi.mock("fs/promises", () => ({
  mkdir,
  writeFile,
}));

vi.mock("../projection-publication", () => ({
  createRenderedPreview,
  createEnrichmentPreviewSelectionRun,
  publishPreviewSelectionRun,
  upsertRenderedPreviewAsset,
}));

vi.mock("../publication-guards", () => ({
  acquirePaperWorkLease,
  releasePaperWorkLease,
}));

import {
  renderTablePreviews,
  tablePreviewRendererInternals,
} from "../html-table-preview-renderer";

describe("html-table-preview-renderer", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    prisma.paperPublicationState.findUnique.mockResolvedValue({
      activeProjectionRunId: "projection-run-1",
      activePreviewSelectionRunId: "preview-run-1",
    });
    prisma.renderRun.create.mockResolvedValue({ id: "render-run-1" });
    prisma.renderRun.update.mockResolvedValue({});
    prisma.$transaction.mockImplementation(async (callback: (tx: unknown) => Promise<unknown>) => callback({}));

    acquirePaperWorkLease.mockResolvedValue("lease-1");
    releasePaperWorkLease.mockResolvedValue(undefined);
    upsertRenderedPreviewAsset.mockResolvedValue("asset-1");
    createRenderedPreview.mockResolvedValue("rendered-preview-1");
    createEnrichmentPreviewSelectionRun.mockResolvedValue("preview-run-2");
    publishPreviewSelectionRun.mockResolvedValue(undefined);
    mkdir.mockResolvedValue(undefined);
    writeFile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("renders and publishes short structured tables instead of skipping them on an arbitrary length threshold", async () => {
    prisma.previewSelectionFigure.findMany.mockResolvedValue([
      {
        projectionFigureId: "proj-1",
        projectionFigure: {
          figureLabel: "Table 1",
          structuredContent: "<table><tr><td>A</td></tr></table>",
        },
      },
    ]);

    const page = {
      setContent: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockReturnValue({
        boundingBox: vi.fn().mockResolvedValue({ width: 321.2, height: 123.7 }),
        screenshot: vi.fn().mockResolvedValue(Buffer.from("png")),
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const browser = {
      version: vi.fn().mockReturnValue("123.0"),
      newPage: vi.fn().mockResolvedValue(page),
      close: vi.fn().mockResolvedValue(undefined),
    };
    launch.mockResolvedValue(browser);

    const result = await renderTablePreviews("paper-1");

    expect(result).toEqual({ rendered: 1, failed: 0, skipped: 0 });
    expect(prisma.previewSelectionFigure.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          previewSelectionRunId: "preview-run-1",
          selectedPreviewSource: { not: "rendered" },
        }),
      }),
    );
    expect(upsertRenderedPreviewAsset).toHaveBeenCalledWith(
      {},
      "paper-1",
      expect.objectContaining({
        storagePath: "uploads/figures/paper-1/table-preview-table_1-proj_1.png",
      }),
    );
    expect(createEnrichmentPreviewSelectionRun).toHaveBeenCalledWith(
      {},
      "paper-1",
      "projection-run-1",
      "preview-run-1",
      [
        expect.objectContaining({
          projectionFigureId: "proj-1",
          assetId: "asset-1",
          renderedPreviewId: "rendered-preview-1",
          sourceMethod: "html_table_render",
        }),
      ],
    );
    expect(publishPreviewSelectionRun).toHaveBeenCalledWith(
      {},
      "paper-1",
      "preview-run-2",
      "lease-1",
      "projection-run-1",
    );
  });

  it("skips empty structured content rather than attempting to render it", async () => {
    prisma.previewSelectionFigure.findMany.mockResolvedValue([
      {
        projectionFigureId: "proj-empty",
        projectionFigure: {
          figureLabel: "Table 9",
          structuredContent: "   ",
        },
      },
    ]);

    const result = await renderTablePreviews("paper-1");

    expect(result).toEqual({ rendered: 0, failed: 0, skipped: 1 });
    expect(launch).not.toHaveBeenCalled();
    expect(createEnrichmentPreviewSelectionRun).not.toHaveBeenCalled();
  });

  it("re-renders structured tables that are still using a carried-forward native preview", async () => {
    prisma.previewSelectionFigure.findMany.mockResolvedValue([
      {
        projectionFigureId: "proj-native",
        projectionFigure: {
          figureLabel: "Table 5",
          structuredContent: "<table><tr><td>Needs canonical preview</td></tr></table>",
        },
      },
    ]);

    const page = {
      setContent: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockReturnValue({
        boundingBox: vi.fn().mockResolvedValue({ width: 640, height: 180 }),
        screenshot: vi.fn().mockResolvedValue(Buffer.from("png-native")),
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const browser = {
      version: vi.fn().mockReturnValue("123.0"),
      newPage: vi.fn().mockResolvedValue(page),
      close: vi.fn().mockResolvedValue(undefined),
    };
    launch.mockResolvedValue(browser);

    const result = await renderTablePreviews("paper-1");

    expect(result).toEqual({ rendered: 1, failed: 0, skipped: 0 });
    expect(createEnrichmentPreviewSelectionRun).toHaveBeenCalledWith(
      {},
      "paper-1",
      "projection-run-1",
      "preview-run-1",
      [
        expect.objectContaining({
          projectionFigureId: "proj-native",
          sourceMethod: "html_table_render",
        }),
      ],
    );
  });

  it("builds collision-safe preview filenames per projection figure", () => {
    expect(
      tablePreviewRendererInternals.buildTablePreviewFilename("Table 1", "proj-1"),
    ).toBe("table-preview-table_1-proj_1.png");
    expect(
      tablePreviewRendererInternals.buildTablePreviewFilename("Table 1", "proj-2"),
    ).toBe("table-preview-table_1-proj_2.png");
    expect(
      tablePreviewRendererInternals.hasRenderableStructuredTableContent("<table><tr><td>A</td></tr></table>"),
    ).toBe(true);
    expect(
      tablePreviewRendererInternals.hasRenderableStructuredTableContent(" \n "),
    ).toBe(false);
  });
});
