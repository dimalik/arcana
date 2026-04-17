import { describe, expect, it } from "vitest";

import { grobidExtractorInternals } from "../grobid-tei-extractor";

describe("parseGrobidTeiFigures", () => {
  it("extracts figure/table captions and page anchors from TEI", () => {
    const tei = `
      <TEI>
        <text>
          <body>
            <figure type="figure" coords="6,115.3,86.2,350.1,84.7">
              <label>Figure 1</label>
              <figDesc>Confusion matrices for ternary classification.</figDesc>
            </figure>
            <figure type="table" coords="3,70.6,201.8,453.8,45.8">
              <head>Table 1</head>
              <figDesc>F1 scores of LLM-based detectors in binary classification.</figDesc>
            </figure>
          </body>
        </text>
      </TEI>
    `;

    expect(grobidExtractorInternals.parseGrobidTeiFigures(tei)).toEqual([
      {
        figureLabel: "Figure 1",
        captionText: "Figure 1: Confusion matrices for ternary classification.",
        pdfPage: 6,
        bbox: "115.30,86.20,350.10,170.90",
        type: "figure",
      },
      {
        figureLabel: "Table 1",
        captionText: "Table 1: F1 scores of LLM-based detectors in binary classification.",
        pdfPage: 3,
        bbox: "70.60,201.80,453.80,247.60",
        type: "table",
      },
    ]);
  });

  it("deduplicates repeated figure nodes and ignores empty shells", () => {
    const tei = `
      <TEI>
        <text>
          <body>
            <figure type="figure" coords="2,10,20,30,40">
              <label>Figure 2</label>
              <figDesc>An ablation study.</figDesc>
            </figure>
            <figure type="figure" coords="2,10,20,30,40">
              <label>Figure 2</label>
              <figDesc>An ablation study.</figDesc>
            </figure>
            <figure type="figure" />
          </body>
        </text>
      </TEI>
    `;

    expect(grobidExtractorInternals.parseGrobidTeiFigures(tei)).toEqual([
      {
        figureLabel: "Figure 2",
        captionText: "Figure 2: An ablation study.",
        pdfPage: 2,
        bbox: "10.00,20.00,30.00,40.00",
        type: "figure",
      },
    ]);
  });

  it("expands numeric GROBID labels using the type hint", () => {
    const tei = `
      <TEI>
        <text>
          <body>
            <figure type="table" coords="5,70.0,200.0,300.0,40.0">
              <label>5</label>
              <figDesc>Classification results.</figDesc>
            </figure>
            <figure type="figure" coords="6,80.0,100.0,200.0,50.0">
              <label>1</label>
              <figDesc>Confusion matrix.</figDesc>
            </figure>
          </body>
        </text>
      </TEI>
    `;

    expect(grobidExtractorInternals.parseGrobidTeiFigures(tei)).toEqual([
      {
        figureLabel: "Table 5",
        captionText: "Table 5: Classification results.",
        pdfPage: 5,
        bbox: "70.00,200.00,300.00,240.00",
        type: "table",
      },
      {
        figureLabel: "Figure 1",
        captionText: "Figure 1: Confusion matrix.",
        pdfPage: 6,
        bbox: "80.00,100.00,200.00,150.00",
        type: "figure",
      },
    ]);
  });
});
