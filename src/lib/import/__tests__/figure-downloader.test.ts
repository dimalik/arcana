import { describe, it, expect } from "vitest";
import { applyHtmlTrustPolicy, extractFiguresFromHtml } from "../figure-downloader";

describe("extractFiguresFromHtml", () => {
  const baseUrl = "https://arxiv.org/html/2510.21391v1/";

  describe("standard <table> extraction", () => {
    it("extracts a table from a <figure> block with <table>", () => {
      const html = `
        <figure id="S4.T2">
          <table class="ltx_tabular">
            <tr><th>Method</th><th>Score</th></tr>
            <tr><td>Ours</td><td>0.95</td></tr>
          </table>
          <figcaption>Table 2: Decoding strategies for zero-shot generation.</figcaption>
        </figure>
      `;
      const results = extractFiguresFromHtml(html, baseUrl);
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe("table");
      expect(results[0].figureLabel).toBe("Table 2");
      expect(results[0].caption).toContain("Decoding strategies");
      expect(results[0].tableHtml).toContain("<table");
      expect(results[0].tableHtml).toContain("0.95");
      expect(results[0].url).toBe("");
    });

    it("splits a multi-caption table figure into separate table candidates", () => {
      const html = `
        <figure class="ltx_table" id="A7.T15">
          <div class="ltx_flex_figure ltx_flex_table">
            <div class="ltx_flex_cell ltx_flex_size_1">
              <table class="ltx_tabular"><tr><td>reward</td></tr></table>
            </div>
          </div>
          <figcaption>Table 14: Average reward summary.</figcaption>
          <div class="ltx_flex_figure">
            <div class="ltx_flex_cell ltx_flex_size_1">
              <table class="ltx_tabular"><tr><td>rouge</td></tr></table>
            </div>
          </div>
          <figcaption>Table 15: Diversity based on ROUGE-L.</figcaption>
        </figure>
      `;

      const results = extractFiguresFromHtml(html, baseUrl);
      expect(results).toHaveLength(2);
      expect(results.map((result) => result.figureLabel)).toEqual(["Table 14", "Table 15"]);
      expect(results.map((result) => result.caption)).toEqual([
        "Table 14: Average reward summary.",
        "Table 15: Diversity based on ROUGE-L.",
      ]);
      expect(results[0].tableHtml).toContain("reward");
      expect(results[1].tableHtml).toContain("rouge");
      expect(results[0].sourceUrl).toBe("https://arxiv.org/html/2510.21391v1/#A7.T15");
      expect(results[1].sourceUrl).toBe("https://arxiv.org/html/2510.21391v1/#A7.T15");
    });
  });

  describe("ltx_tabular extraction", () => {
    it("extracts a table from a <figure> block with ltx_tabular spans", () => {
      const html = `
        <figure id="S4.T1">
          <span class="ltx_text ltx_inline-block" style="width:433pt;">
            <span class="ltx_inline-block ltx_transformed_outer">
              <span class="ltx_transformed_inner">
                <span class="ltx_p">
                  <span class="ltx_tabular ltx_align_middle">
                    <span class="ltx_tr">
                      <span class="ltx_td ltx_align_left">Method</span>
                      <span class="ltx_td ltx_align_center">Score</span>
                    </span>
                    <span class="ltx_tr">
                      <span class="ltx_td ltx_align_left">Ours</span>
                      <span class="ltx_td ltx_align_center">0.83</span>
                    </span>
                  </span>
                </span>
              </span>
            </span>
          </span>
          <figcaption>Table 1: Generation Quality Comparison.</figcaption>
        </figure>
      `;
      const results = extractFiguresFromHtml(html, baseUrl);
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe("table");
      expect(results[0].figureLabel).toBe("Table 1");
      expect(results[0].caption).toContain("Generation Quality");
      expect(results[0].tableHtml).toContain("ltx_tabular");
      expect(results[0].tableHtml).toContain("0.83");
      expect(results[0].tableHtml).not.toContain("figcaption");
      expect(results[0].url).toBe("");
    });

    it("does not capture ltx_tabular if <img> is present", () => {
      const html = `
        <figure>
          <img src="figure1.png" />
          <span class="ltx_tabular ltx_align_middle">
            <span class="ltx_tr"><span class="ltx_td">data</span></span>
          </span>
          <figcaption>Figure 1: Some figure with embedded table.</figcaption>
        </figure>
      `;
      const results = extractFiguresFromHtml(html, baseUrl);
      // Should extract as figure (img), not table
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe("figure");
      expect(results[0].url).toContain("figure1.png");
    });
  });

  describe("label-caption pairing", () => {
    it("preserves correct label for each figure block", () => {
      const html = `
        <figure>
          <img src="fig1.png" />
          <figcaption>Figure 1: Architecture overview.</figcaption>
        </figure>
        <figure>
          <table><tr><td>A</td></tr></table>
          <figcaption>Table 1: Results on benchmark.</figcaption>
        </figure>
        <figure>
          <span class="ltx_tabular ltx_align_middle">
            <span class="ltx_tr"><span class="ltx_td">B</span></span>
          </span>
          <figcaption>Table 2: Ablation study.</figcaption>
        </figure>
      `;
      const results = extractFiguresFromHtml(html, baseUrl);
      expect(results).toHaveLength(3);
      expect(results[0].figureLabel).toBe("Figure 1");
      expect(results[0].type).toBe("figure");
      expect(results[1].figureLabel).toBe("Table 1");
      expect(results[1].type).toBe("table");
      expect(results[2].figureLabel).toBe("Table 2");
      expect(results[2].type).toBe("table");
    });
  });

  describe("vector figure extraction", () => {
    it("extracts inline SVG figures from LaTeXML figure blocks", () => {
      const html = `
        <figure class="ltx_figure" id="S4.F1">
          <svg class="ltx_picture" width="320" height="180" viewBox="0 0 320 180">
            <rect width="320" height="180" fill="#fff"></rect>
            <text x="20" y="40">Confusion Matrix</text>
          </svg>
          <figcaption>Figure 1: Ternary confusion matrices for different detectors.</figcaption>
        </figure>
      `;

      const results = extractFiguresFromHtml(html, baseUrl);
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe("figure");
      expect(results[0].figureLabel).toBe("Figure 1");
      expect(results[0].inlineImageMimeType).toBe("image/svg+xml");
      expect(results[0].inlineImageData).toContain("<svg");
      expect(results[0].sourceUrl).toBe("https://arxiv.org/html/2510.21391v1/#S4.F1");
      expect(results[0].url).toBe("");
    });

    it("extracts object-backed figure assets in figure blocks", () => {
      const html = `
        <figure class="ltx_figure" id="S4.F2">
          <object data="figures/confusion.svg" type="image/svg+xml"></object>
          <figcaption>Figure 2: Object-backed SVG figure.</figcaption>
        </figure>
      `;

      const results = extractFiguresFromHtml(html, baseUrl);
      expect(results).toHaveLength(1);
      expect(results[0].type).toBe("figure");
      expect(results[0].figureLabel).toBe("Figure 2");
      expect(results[0].url).toBe("https://arxiv.org/html/2510.21391v1/figures/confusion.svg");
      expect(results[0].sourceUrl).toBe("https://arxiv.org/html/2510.21391v1/#S4.F2");
    });
  });

  describe("grouped panel figures", () => {
    it("extracts nested panel figures and skips the outer wrapper figure", () => {
      const html = `
        <figure class="ltx_figure" id="S3.SS3.fig3">
          <div class="ltx_block">
            <figure class="ltx_figure ltx_figure_panel" id="S3.F2">
              <img src="x2.png" />
              <figcaption>Figure 2: First panel figure.</figcaption>
            </figure>
            <figure class="ltx_figure ltx_figure_panel" id="S3.F3">
              <img src="x3.png" />
              <figcaption>Figure 3: Second panel figure.</figcaption>
            </figure>
          </div>
        </figure>
      `;

      const results = extractFiguresFromHtml(html, baseUrl);
      expect(results).toHaveLength(2);
      expect(results.map((result) => result.figureLabel)).toEqual(["Figure 2", "Figure 3"]);
      expect(results.map((result) => result.sourceUrl)).toEqual([
        "https://arxiv.org/html/2510.21391v1/#S3.F2",
        "https://arxiv.org/html/2510.21391v1/#S3.F3",
      ]);
      expect(results.map((result) => result.url)).toEqual([
        "https://arxiv.org/html/2510.21391v1/x2.png",
        "https://arxiv.org/html/2510.21391v1/x3.png",
      ]);
    });

    it("keeps labeled parent figures and borrows a child panel asset for preview", () => {
      const html = `
        <figure class="ltx_figure" id="S3.F1">
          <div class="ltx_flex_figure">
            <figure class="ltx_figure ltx_figure_panel" id="S3.F1.sf1">
              <img src="x1.png" />
              <figcaption><span>(a)</span> Color</figcaption>
            </figure>
            <figure class="ltx_figure ltx_figure_panel" id="S3.F1.sf2">
              <img src="x2.png" />
              <figcaption><span>(b)</span> Count</figcaption>
            </figure>
          </div>
          <figcaption>Figure 1: Parent grouped figure caption.</figcaption>
        </figure>
      `;

      const results = extractFiguresFromHtml(html, baseUrl);
      expect(results).toHaveLength(1);
      expect(results[0].figureLabel).toBe("Figure 1");
      expect(results[0].caption).toContain("Parent grouped figure caption");
      expect(results[0].url).toBe("https://arxiv.org/html/2510.21391v1/x1.png");
      expect(results[0].sourceUrl).toBe("https://arxiv.org/html/2510.21391v1/#S3.F1");
    });

    it("preserves a labeled parent even when nested child figures are also labeled", () => {
      const html = `
        <figure class="ltx_figure" id="S5.F1">
          <div class="ltx_flex_figure">
            <figure class="ltx_figure ltx_figure_panel" id="S5.F1.sf1">
              <img src="child-a.png" />
              <figcaption>Figure 1a: First labeled panel.</figcaption>
            </figure>
            <figure class="ltx_figure ltx_figure_panel" id="S5.F1.sf2">
              <img src="child-b.png" />
              <figcaption>Figure 1b: Second labeled panel.</figcaption>
            </figure>
          </div>
          <figcaption>Figure 1: Parent grouped figure caption.</figcaption>
        </figure>
      `;

      const results = extractFiguresFromHtml(html, baseUrl);
      expect(results.map((result) => result.figureLabel)).toEqual(["Figure 1", "Figure 1a", "Figure 1b"]);
      expect(results[0].url).toBe("https://arxiv.org/html/2510.21391v1/child-a.png");
      expect(results[0].sourceUrl).toBe("https://arxiv.org/html/2510.21391v1/#S5.F1");
    });

    it("uses a top-level grouped-panel image before falling back to nested child panels", () => {
      const html = `
        <figure class="ltx_figure" id="S4.F7.11">
          <div class="ltx_flex_figure">
            <div class="ltx_flex_cell ltx_flex_size_1"><img src="x9.png" /></div>
            <div class="ltx_flex_break"></div>
            <div class="ltx_flex_cell ltx_flex_size_1">
              <figure class="ltx_figure ltx_figure_panel" id="S4.F6.sf1">
                <img src="" />
                <figcaption><span>(a)</span> Missing child</figcaption>
              </figure>
            </div>
          </div>
          <figcaption>Figure 6: Parent grouped figure with direct image asset.</figcaption>
        </figure>
      `;

      const results = extractFiguresFromHtml(html, baseUrl);
      expect(results).toHaveLength(1);
      expect(results[0].figureLabel).toBe("Figure 6");
      expect(results[0].url).toBe("https://arxiv.org/html/2510.21391v1/x9.png");
      expect(results[0].sourceUrl).toBe("https://arxiv.org/html/2510.21391v1/#S4.F7.11");
    });

    it("suppresses unlabeled nested child figures under a labeled parent figure", () => {
      const html = `
        <figure class="ltx_figure" id="S1.F1">
          <figure class="ltx_figure ltx_figure_panel" id="S1.F1.1">
            <img src="x1.png" />
          </figure>
          <figure class="ltx_figure ltx_figure_panel" id="S1.F1.2">
            <img src="x2.png" />
          </figure>
          <figcaption>Figure 1: Parent figure caption.</figcaption>
        </figure>
      `;

      const results = extractFiguresFromHtml(html, baseUrl);
      expect(results).toHaveLength(1);
      expect(results[0].figureLabel).toBe("Figure 1");
      expect(results[0].sourceUrl).toBe("https://arxiv.org/html/2510.21391v1/#S1.F1");
    });
  });

  describe("base href resolution", () => {
    it("respects <base href> for relative image URLs", () => {
      const html = `
        <base href="/html/2510.21391v1/" />
        <figure>
          <img src="figures/arch.png" />
          <figcaption>Figure 1: Architecture.</figcaption>
        </figure>
      `;
      const results = extractFiguresFromHtml(html, "https://arxiv.org/html/2510.21391");
      expect(results).toHaveLength(1);
      expect(results[0].url).toBe("https://arxiv.org/html/2510.21391v1/figures/arch.png");
    });
  });

  describe("broken HTML trust policy", () => {
    it("downgrades partially broken HTML by suppressing anonymous candidates", () => {
      const html = `
        <figure id="S1.F1">
          <img src="fig1.png" />
          <figcaption>Figure 1: Trusted labeled figure.</figcaption>
        </figure>
        <figure id="S1.T1">
          <table><tr><td>A</td></tr></table>
          <figcaption>Table 1: Trusted labeled table.</figcaption>
        </figure>
        <figure id="S1.broken">
          <img src="junk.png" />
        </figure>
      `;

      const raw = extractFiguresFromHtml(html, baseUrl);
      const result = applyHtmlTrustPolicy(raw);

      expect(result.qualityStatus).toBe("downgraded");
      expect(result.reasonCode).toBe("anonymous_html_candidates_suppressed");
      expect(result.rawCandidateCount).toBe(3);
      expect(result.keptCandidateCount).toBe(2);
      expect(result.suppressedCandidateCount).toBe(1);
      expect(result.figures.map((figure) => figure.figureLabel)).toEqual(["Figure 1", "Table 1"]);
    });

    it("suppresses anonymous-only HTML candidate sets", () => {
      const html = `
        <figure id="S1.broken1">
          <img src="junk1.png" />
        </figure>
        <figure id="S1.broken2">
          <img src="junk2.png" />
        </figure>
      `;

      const raw = extractFiguresFromHtml(html, baseUrl);
      const result = applyHtmlTrustPolicy(raw);

      expect(result.qualityStatus).toBe("suppressed");
      expect(result.reasonCode).toBe("anonymous_only_html_candidates");
      expect(result.keptCandidateCount).toBe(0);
      expect(result.suppressedCandidateCount).toBe(2);
      expect(result.figures).toEqual([]);
    });
  });
});
