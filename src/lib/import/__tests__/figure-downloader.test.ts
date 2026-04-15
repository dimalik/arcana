import { describe, it, expect } from "vitest";
import { extractFiguresFromHtml } from "../figure-downloader";

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
});
