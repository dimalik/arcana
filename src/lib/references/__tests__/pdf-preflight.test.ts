import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  countReplacementChars,
  runPdfPreflight,
  type PreflightConfig,
} from "../pdf-preflight";

vi.mock("pdf-parse", () => ({
  PDFParse: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  readFile: vi.fn().mockResolvedValue(Buffer.from("fake-pdf")),
}));

import { PDFParse } from "pdf-parse";

const MockPDFParse = vi.mocked(PDFParse);

function mockPdf(text: string, pages: number) {
  MockPDFParse.mockImplementation(
    () =>
      ({
        getText: vi.fn().mockResolvedValue({ text }),
        getInfo: vi.fn().mockResolvedValue({ total: pages }),
        destroy: vi.fn().mockResolvedValue(undefined),
      }) as never,
  );
}

const config: PreflightConfig = {
  minCharsPerPage: 100,
  maxReplacementCharRatio: 0.15,
  maxPages: 500,
};

describe("countReplacementChars", () => {
  it("counts U+FFFD characters", () => {
    expect(countReplacementChars("hello \uFFFD world \uFFFD")).toBe(2);
  });

  it("returns 0 for clean text", () => {
    expect(countReplacementChars("clean academic text")).toBe(0);
  });
});

describe("runPdfPreflight", () => {
  beforeEach(() => {
    MockPDFParse.mockReset();
  });

  it("returns text_layer_ok for a PDF with good text", async () => {
    mockPdf("This is a well-formed academic paper. ".repeat(50), 10);

    const result = await runPdfPreflight("/tmp/good.pdf", config);
    expect(result.result).toBe("text_layer_ok");
    expect(result.pageCount).toBe(10);
    expect(result.totalChars).toBeGreaterThan(0);
  });

  it("returns text_layer_missing for empty text", async () => {
    mockPdf("", 5);

    const result = await runPdfPreflight("/tmp/empty.pdf", config);
    expect(result.result).toBe("text_layer_missing");
    expect(result.reason).toContain("text");
  });

  it("returns text_layer_garbled for high replacement char ratio", async () => {
    mockPdf("Some \uFFFD\uFFFD\uFFFD garbled \uFFFD text \uFFFD\uFFFD".repeat(30), 3);

    const result = await runPdfPreflight("/tmp/garbled.pdf", config);
    expect(result.result).toBe("text_layer_garbled");
    expect(result.reason).toContain("replacement");
  });

  it("returns text_layer_missing when chars per page below threshold", async () => {
    mockPdf("tiny", 20);

    const result = await runPdfPreflight("/tmp/sparse.pdf", config);
    expect(result.result).toBe("text_layer_missing");
  });

  it("returns preflight_error for page count exceeding limit", async () => {
    mockPdf("text ".repeat(500), 600);

    const result = await runPdfPreflight("/tmp/huge.pdf", config);
    expect(result.result).toBe("preflight_error");
    expect(result.reason).toContain("page");
  });

  it("returns preflight_error when PDF parsing throws", async () => {
    MockPDFParse.mockImplementation(() => {
      throw new Error("corrupted PDF");
    });

    const result = await runPdfPreflight("/tmp/corrupt.pdf", config);
    expect(result.result).toBe("preflight_error");
    expect(result.reason).toContain("corrupted");
  });
});
