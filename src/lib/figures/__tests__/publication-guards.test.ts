import { describe, expect, it } from "vitest";

import { publicationGuardsInternals } from "../publication-guards";

describe("isCompatibleCarryForwardRenderedPreview", () => {
  it("accepts rendered previews recreated on the same projection figure", () => {
    expect(publicationGuardsInternals.isCompatibleCarryForwardRenderedPreview({
      currentProjectionFigureId: "proj-current",
      currentIdentityKey: "figure:default:label:table_1",
      currentSourceMethod: "arxiv_html",
      currentStructuredContent: "<table>A</table>",
      currentProjectionRunId: "run-current",
      renderedProjectionFigureId: "proj-current",
      renderedIdentityKey: "figure:default:label:table_1",
      renderedSourceMethod: "arxiv_html",
      renderedStructuredContent: "<table>A</table>",
      renderedProjectionRunId: "run-current",
    })).toBe(true);
  });

  it("accepts carry-forward rendered previews when identity and structured content are unchanged", () => {
    expect(publicationGuardsInternals.isCompatibleCarryForwardRenderedPreview({
      currentProjectionFigureId: "proj-current",
      currentIdentityKey: "table:default:label:table_1",
      currentSourceMethod: "arxiv_html",
      currentStructuredContent: "<table><tr><td>A</td></tr></table>",
      currentProjectionRunId: "run-current",
      renderedProjectionFigureId: "proj-prev",
      renderedIdentityKey: "table:default:label:table_1",
      renderedSourceMethod: "arxiv_html",
      renderedStructuredContent: "<table><tr><td>A</td></tr></table>",
      renderedProjectionRunId: "run-prev",
    })).toBe(true);
  });

  it("rejects carry-forward rendered previews when semantic content changed", () => {
    expect(publicationGuardsInternals.isCompatibleCarryForwardRenderedPreview({
      currentProjectionFigureId: "proj-current",
      currentIdentityKey: "table:default:label:table_1",
      currentSourceMethod: "arxiv_html",
      currentStructuredContent: "<table><tr><td>B</td></tr></table>",
      currentProjectionRunId: "run-current",
      renderedProjectionFigureId: "proj-prev",
      renderedIdentityKey: "table:default:label:table_1",
      renderedSourceMethod: "arxiv_html",
      renderedStructuredContent: "<table><tr><td>A</td></tr></table>",
      renderedProjectionRunId: "run-prev",
    })).toBe(false);
  });
});
