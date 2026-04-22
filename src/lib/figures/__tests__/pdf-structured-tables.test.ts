import { describe, it, expect, vi, afterEach } from "vitest";

import {
  extractFiguresFromPdf,
  pdfFigurePipelineInternals,
  type StructuredTableRecord,
} from "../pdf-figure-pipeline";

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
