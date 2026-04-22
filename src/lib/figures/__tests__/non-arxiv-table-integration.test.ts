import { describe, it, expect } from "vitest";
import { mergeFigureSources, type MergeableFigure } from "../source-merger";

function makeTable(overrides: Partial<MergeableFigure>): MergeableFigure {
  return {
    figureLabel: "Table 1",
    captionText: null,
    captionSource: "html_caption",
    sourceMethod: "pmc_jats",
    sourceUrl: null,
    confidence: "high",
    description: null,
    imagePath: null,
    assetHash: null,
    pdfPage: null,
    bbox: null,
    type: "table",
    width: null,
    height: null,
    cropOutcome: null,
    ...overrides,
  };
}

describe("non-arXiv table HTML routing through merger", () => {
  it("PMC-derived tableHtml lands in description after merge", () => {
    const pmcTable = makeTable({
      captionText: "Summary of results.",
      captionSource: "jats",
      sourceMethod: "pmc_jats",
      sourceUrl: "https://www.ncbi.nlm.nih.gov/pmc/articles/PMC1234/",
      confidence: "high",
      description: "<table><tr><td>GPT-4</td><td>0.91</td></tr></table>",
    });

    const merged = mergeFigureSources([pmcTable]);
    expect(merged).toHaveLength(1);
    expect(merged[0].description).toContain("<td>GPT-4</td>");
    expect(merged[0].type).toBe("table");
  });

  it("publisher-derived tableHtml lands in description after merge", () => {
    const publisherTable = makeTable({
      figureLabel: "Table 2",
      captionText: "Benchmark scores.",
      captionSource: "html_caption",
      sourceMethod: "publisher_html",
      sourceUrl: "https://example.com/article",
      confidence: "medium",
      description: "<table><tr><td>QA</td><td>0.82</td></tr></table>",
    });

    const merged = mergeFigureSources([publisherTable]);
    expect(merged).toHaveLength(1);
    expect(merged[0].description).toContain("<td>QA</td>");
  });

  it("pdf_structural tableHtml lands in description after merge", () => {
    const pdfStructuralTable = makeTable({
      figureLabel: "Table 3",
      captionText: null,
      captionSource: "none",
      sourceMethod: "pdf_structural",
      sourceUrl: null,
      confidence: "medium",
      description: "<table><thead><tr><th>Model</th></tr></thead><tbody><tr><td>A</td></tr></tbody></table>",
      pdfPage: 7,
      bbox: "[72,100,500,260]",
    });

    const merged = mergeFigureSources([pdfStructuralTable]);
    expect(merged).toHaveLength(1);
    expect(merged[0].description).toContain("<th>Model</th>");
    expect(merged[0].description).toContain("<td>A</td>");
  });

  it("structured-HTML table wins over PDF-rendered screenshot on merge", () => {
    // HTML must be long enough to clear the structured-table gate in
    // selectCanonicalMember for the structured-wins path to trigger.
    const publisherTable = makeTable({
      figureLabel: "Table 4",
      sourceMethod: "publisher_html",
      sourceUrl: "https://example.com",
      confidence: "medium",
      description:
        "<table><thead><tr><th>Task</th><th>Score</th></tr></thead>"
        + "<tbody><tr><td>QA</td><td>0.82</td></tr>"
        + "<tr><td>Summarization</td><td>0.76</td></tr></tbody></table>",
    });
    const pdfScreenshot = makeTable({
      figureLabel: "Table 4",
      sourceMethod: "pdf_render_crop",
      confidence: "low",
      description: null,
      imagePath: "uploads/figures/x/table-4.png",
      assetHash: "deadbeef",
    });

    const merged = mergeFigureSources([publisherTable], [pdfScreenshot]);
    // Merger returns canonical + alternate rows; the canonical is the one
    // with isPrimaryExtraction=true. For a table with structured HTML, the
    // canonical must be the HTML-bearing source, not the screenshot.
    const canonical = merged.filter((m) => m.isPrimaryExtraction);
    expect(canonical).toHaveLength(1);
    expect(canonical[0].description).toContain("<th>Task</th>");
    expect(canonical[0].description).toContain("<td>QA</td>");
    expect(canonical[0].sourceMethod).toBe("publisher_html");
  });

  it("pdf_structural HTML wins over pdf_render_crop screenshot on merge", () => {
    // HTML must clear the structured-table gate; otherwise the
    // higher-priority pdf_render_crop would win the canonical slot even
    // though the HTML description still flows through.
    const structuralTable = makeTable({
      figureLabel: "Table 5",
      sourceMethod: "pdf_structural",
      confidence: "medium",
      description:
        "<table><thead><tr><th>Model</th><th>Score</th></tr></thead>"
        + "<tbody><tr><td>A</td><td>0.5</td></tr>"
        + "<tr><td>B</td><td>0.7</td></tr></tbody></table>",
      pdfPage: 4,
    });
    const screenshotTable = makeTable({
      figureLabel: "Table 5",
      sourceMethod: "pdf_render_crop",
      confidence: "low",
      description: null,
      imagePath: "uploads/figures/x/table-5.png",
      assetHash: "f00ba5",
      pdfPage: 4,
    });

    const merged = mergeFigureSources([structuralTable], [screenshotTable]);
    const canonical = merged.filter((m) => m.isPrimaryExtraction);
    expect(canonical).toHaveLength(1);
    expect(canonical[0].description).toContain("<th>Model</th>");
    expect(canonical[0].description).toContain("<td>A</td>");
    expect(canonical[0].sourceMethod).toBe("pdf_structural");
  });

  it("short pdf_structural HTML (between 20 and 100 chars) still wins over pdf_render_crop", () => {
    // A minimal real pymupdf 2x2 table: ~72 chars, above the 20-char gate
    // but BELOW the old 100-char gate that would have dropped it.
    const shortStructuralHtml = "<table><tr><td>1</td><td>2</td></tr><tr><td>3</td><td>4</td></tr></table>";
    expect(shortStructuralHtml.length).toBeGreaterThan(20);
    expect(shortStructuralHtml.length).toBeLessThan(100);

    const structuralTable = makeTable({
      figureLabel: "Table 6",
      sourceMethod: "pdf_structural",
      confidence: "medium",
      description: shortStructuralHtml,
      pdfPage: 4,
    });
    const screenshotTable = makeTable({
      figureLabel: "Table 6",
      sourceMethod: "pdf_render_crop",
      confidence: "low",
      description: null,
      imagePath: "uploads/figures/x/table-6.png",
      assetHash: "cafebabe",
      pdfPage: 4,
    });

    const merged = mergeFigureSources([structuralTable], [screenshotTable]);
    const canonical = merged.filter((m) => m.isPrimaryExtraction);
    expect(canonical).toHaveLength(1);
    expect(canonical[0].sourceMethod).toBe("pdf_structural");
    expect(canonical[0].description).toContain("<td>1</td>");
  });
});
