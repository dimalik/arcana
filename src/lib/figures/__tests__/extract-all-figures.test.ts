import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    paper: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("../pdf-figure-pipeline", () => ({
  extractFiguresFromPdf: vi.fn(),
}));

vi.mock("../grobid-tei-extractor", () => ({
  extractFiguresWithGrobid: vi.fn(),
  isGrobidConfigured: vi.fn(() => false),
}));

vi.mock("../pmc-jats-extractor", () => ({
  downloadPmcFigures: vi.fn(),
}));

vi.mock("@/lib/import/figure-downloader", () => ({
  downloadFiguresFromHtml: vi.fn(),
}));

vi.mock("../publisher-parsers", () => ({
  extractWithPublisherParser: vi.fn(),
}));

vi.mock("../extraction-foundation", () => ({
  persistExtractionEvidence: vi.fn(),
}));

vi.mock("../capability-substrate", () => ({
  prepareCapabilitySnapshotForExtraction: vi.fn(),
}));

vi.mock("../identity-resolution", () => ({
  createIdentityResolutionSnapshot: vi.fn(),
}));

vi.mock("../projection-publication", () => ({
  createProjectionRunSnapshot: vi.fn(),
  publishProjectionRun: vi.fn(),
}));

vi.mock("../publication-guards", () => ({
  acquirePaperWorkLease: vi.fn(),
  FigurePublicationGuardConflictError: class FigurePublicationGuardConflictError extends Error {},
  releasePaperWorkLease: vi.fn(),
}));

vi.mock("../source-merger", () => ({
  mergeFigureSources: vi.fn(() => []),
}));

import { prisma } from "@/lib/prisma";
import { extractAllFigures } from "../extract-all-figures";

describe("extractAllFigures contract", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("rejects calls that omit caller context before any DB work", async () => {
    await expect(
      extractAllFigures("paper-1", { maxPages: 20 } as never),
    ).rejects.toThrow("extractAllFigures requires a caller context");

    expect(prisma.paper.findUnique).not.toHaveBeenCalled();
  });

  it("rejects invalid maxPages before any DB work", async () => {
    await expect(
      extractAllFigures("paper-1", { context: "route", maxPages: 0 }),
    ).rejects.toThrow("extractAllFigures maxPages must be an integer between 1 and 100");

    expect(prisma.paper.findUnique).not.toHaveBeenCalled();
  });
});
