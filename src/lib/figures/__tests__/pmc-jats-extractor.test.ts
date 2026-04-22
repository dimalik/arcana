import { describe, it, expect } from "vitest";
import { parseJatsXml } from "../pmc-jats-extractor";

const JATS_WITH_TABLE = `<?xml version="1.0"?>
<article>
  <body>
    <table-wrap id="T1">
      <label>Table 1</label>
      <caption><p>Summary of results.</p></caption>
      <table>
        <thead><tr><th>Model</th><th>Accuracy</th></tr></thead>
        <tbody>
          <tr><td>GPT-4</td><td>0.91</td></tr>
          <tr><td>Claude</td><td>0.93</td></tr>
        </tbody>
      </table>
    </table-wrap>
    <fig id="F1">
      <label>Figure 1</label>
      <caption><p>An illustration.</p></caption>
      <graphic xlink:href="fig1.jpg"/>
    </fig>
  </body>
</article>`;

describe("parseJatsXml", () => {
  it("extracts tableHtml from <table-wrap> blocks", () => {
    const { figures } = parseJatsXml(JATS_WITH_TABLE);

    const tableFig = figures.find((f) => f.type === "table");
    expect(tableFig).toBeDefined();
    expect(tableFig!.figureLabel).toBe("Table 1");
    expect(tableFig!.tableHtml).toContain("<tr>");
    expect(tableFig!.tableHtml).toContain("<td>GPT-4</td>");
    expect(tableFig!.tableHtml).toContain("<td>0.93</td>");
  });

  it("leaves tableHtml undefined for <fig> (non-table) elements", () => {
    const { figures } = parseJatsXml(JATS_WITH_TABLE);
    const figureFig = figures.find((f) => f.type === "figure");
    expect(figureFig).toBeDefined();
    expect(figureFig!.tableHtml).toBeUndefined();
  });
});
