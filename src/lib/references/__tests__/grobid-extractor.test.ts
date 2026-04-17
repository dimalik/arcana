import { readFile } from "fs/promises";
import { describe, expect, it, vi } from "vitest";
import { runPdfPreflight } from "../pdf-preflight";
import { GrobidReferenceExtractor } from "../extractors/grobid";

vi.mock("../pdf-preflight", () => ({
  runPdfPreflight: vi.fn(),
}));

vi.mock("fs/promises", () => ({
  readFile: vi.fn(),
}));

const mockRunPdfPreflight = vi.mocked(runPdfPreflight);
const mockReadFile = vi.mocked(readFile);

describe("GrobidReferenceExtractor", () => {
  it("returns parsed candidates when preflight and GROBID succeed", async () => {
    mockRunPdfPreflight.mockResolvedValueOnce({
      result: "text_layer_ok",
      pageCount: 3,
      totalChars: 1000,
    });
    mockReadFile.mockResolvedValueOnce(Buffer.from("pdf"));

    const client = {
      processReferences: vi.fn().mockResolvedValue({
        teiXml: `<?xml version="1.0" encoding="UTF-8"?>
          <TEI xmlns="http://www.tei-c.org/ns/1.0">
            <text><back><div type="references"><listBibl>
              <biblStruct>
                <analytic><title level="a">Structured Paper</title></analytic>
                <monogr><title level="m">Venue</title><imprint><date>2021</date></imprint></monogr>
                <note type="raw_reference">Structured Paper. Venue. 2021.</note>
              </biblStruct>
            </listBibl></div></back></text>
          </TEI>`,
        statusCode: 200,
        durationMs: 42,
      }),
    };

    const extractor = new GrobidReferenceExtractor({
      client: client as never,
    });

    const result = await extractor.extract("paper-1", "/tmp/paper.pdf");
    expect(result.status).toBe("succeeded");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].title).toBe("Structured Paper");
    expect(client.processReferences).toHaveBeenCalledWith(
      expect.objectContaining({ pageCount: 3, includeRawCitations: true }),
    );
  });

  it("fails fast when preflight does not allow GROBID", async () => {
    mockRunPdfPreflight.mockResolvedValueOnce({
      result: "text_layer_missing",
      reason: "no text layer",
    });

    const client = {
      processReferences: vi.fn(),
    };

    const extractor = new GrobidReferenceExtractor({
      client: client as never,
    });

    const result = await extractor.extract("paper-1", "/tmp/paper.pdf");
    expect(result.status).toBe("failed");
    expect(result.errorSummary).toContain("no text layer");
    expect(client.processReferences).not.toHaveBeenCalled();
  });
});
