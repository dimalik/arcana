import { describe, it, expect, vi, afterEach } from "vitest";

import {
  extractFiguresFromPdf,
  parsePdfTableExtractorStdout,
  pdfFigurePipelineInternals,
  type StructuredTableRecord,
} from "../pdf-figure-pipeline";

describe("parsePdfTableExtractorStdout", () => {
  it("parses clean JSON", () => {
    const stdout = '{"tables":[{"page":1,"bbox":[0,0,1,1],"label":"Table 1","html":"<table></table>","rowCount":2,"colCount":2}]}';
    const out = parsePdfTableExtractorStdout(stdout);
    expect(out).toHaveLength(1);
    expect(out[0].label).toBe("Table 1");
  });

  it("skips advisory lines printed by PyMuPDF before the JSON", () => {
    const stdout = 'Consider using the pymupdf_layout package for a greatly improved page layout analysis.\n{"tables":[{"page":2,"bbox":[0,0,1,1],"label":null,"html":"<table><tr><td>x</td></tr></table>","rowCount":1,"colCount":1}]}';
    const out = parsePdfTableExtractorStdout(stdout);
    expect(out).toHaveLength(1);
    expect(out[0].page).toBe(2);
  });

  it("returns empty array when no JSON line is present", () => {
    expect(parsePdfTableExtractorStdout("")).toEqual([]);
    expect(parsePdfTableExtractorStdout("some text\nmore text\n")).toEqual([]);
  });
});

// The pipeline also invokes two other Python subprocesses (text extraction
// and embedded-image extraction). Neither runs in this unit test because we
// stub the structured-table helper and let the other two fail silently —
// extractFiguresFromPdf catches those failures and continues.
describe("extractStructuredTables (via extractFiguresFromPdf)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("converts pymupdf table JSON into ExtractedFigure records with tableHtml", async () => {
    const fakeTables: StructuredTableRecord[] = [
      {
        page: 3,
        bbox: [72, 100, 500, 260],
        label: "Table 1",
        html:
          "<table><thead><tr><th>Model</th></tr></thead><tbody><tr><td>A</td></tr></tbody></table>",
        rowCount: 2,
        colCount: 1,
      },
    ];

    vi.spyOn(pdfFigurePipelineInternals, "runPdfTableExtractor").mockResolvedValue(
      fakeTables,
    );

    const figures = await extractFiguresFromPdf("fake-path.pdf", "paper-1", {
      maxPages: 10,
      coveredLabels: new Set(),
    });

    const tableRec = figures.find(
      (f) => f.type === "table" && f.sourceMethod === "pdf_structural",
    );
    expect(tableRec).toBeDefined();
    expect(tableRec!.tableHtml).toContain("<td>A</td>");
    expect(tableRec!.figureLabel).toBe("Table 1");
    expect(tableRec!.pdfPage).toBe(3);
  });

  it("skips pymupdf tables whose labels are already covered", async () => {
    const fakeTables: StructuredTableRecord[] = [
      {
        page: 3,
        bbox: [72, 100, 500, 260],
        label: "Table 1",
        html: "<table><tr><td>A</td></tr></table>",
        rowCount: 2,
        colCount: 2,
      },
    ];

    vi.spyOn(pdfFigurePipelineInternals, "runPdfTableExtractor").mockResolvedValue(
      fakeTables,
    );

    const figures = await extractFiguresFromPdf("fake-path.pdf", "paper-1", {
      maxPages: 10,
      coveredLabels: new Set(["table 1"]),
    });

    const structural = figures.filter((f) => f.sourceMethod === "pdf_structural");
    expect(structural).toHaveLength(0);
  });
});
