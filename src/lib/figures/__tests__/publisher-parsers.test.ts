import { describe, it, expect } from "vitest";
import { extractWithPublisherParser } from "../publisher-parsers";

const NATURE_HTML_WITH_TABLE = `<html><body>
  <article>
    <figure id="fig1"><img src="/fig1.png"/><figcaption>Figure 1. An illustration.</figcaption></figure>
    <div class="c-article-table">
      <h3>Table 1 Summary of results</h3>
      <table>
        <caption>Results by model.</caption>
        <thead><tr><th>Model</th><th>Accuracy</th></tr></thead>
        <tbody><tr><td>A</td><td>0.9</td></tr><tr><td>B</td><td>0.95</td></tr></tbody>
      </table>
    </div>
  </article>
</body></html>`;

const PLOS_HTML_WITH_TABLE = `<html><body>
  <article>
    <div class="table-wrap">
      <h3>Table 1. Benchmark scores.</h3>
      <table>
        <thead><tr><th>Task</th><th>Score</th></tr></thead>
        <tbody><tr><td>QA</td><td>0.82</td></tr></tbody>
      </table>
    </div>
  </article>
</body></html>`;

describe("publisher-parsers table extraction", () => {
  it("extracts <table> HTML from Nature pages", () => {
    const result = extractWithPublisherParser(NATURE_HTML_WITH_TABLE, "https://www.nature.com/articles/s41586-024-00001");
    expect(result).not.toBeNull();
    const tableRec = result!.figures.find((f) => f.type === "table");
    expect(tableRec).toBeDefined();
    expect(tableRec!.tableHtml).toContain("<tr>");
    expect(tableRec!.tableHtml).toContain("<td>0.95</td>");
    expect(tableRec!.figureLabel).toMatch(/^Table\s+1/);
  });

  it("extracts <table> HTML from PLoS pages", () => {
    const result = extractWithPublisherParser(PLOS_HTML_WITH_TABLE, "https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0000001");
    expect(result).not.toBeNull();
    const tableRec = result!.figures.find((f) => f.type === "table");
    expect(tableRec).toBeDefined();
    expect(tableRec!.tableHtml).toContain("<td>QA</td>");
  });

  it("preserves existing figure extraction (no regression)", () => {
    const result = extractWithPublisherParser(NATURE_HTML_WITH_TABLE, "https://www.nature.com/articles/test");
    const figureRec = result!.figures.find((f) => f.type === "figure");
    expect(figureRec).toBeDefined();
    expect(figureRec!.imgUrl).toContain("fig1.png");
    expect(figureRec!.tableHtml).toBeUndefined();
  });
});
