import { describe, expect, it } from "vitest";

import { figureAuditInternals } from "../figure-audit";

describe("figure-audit", () => {
  it("classifies rollout status from active publication provenance first", () => {
    expect(figureAuditInternals.classifyFigureRolloutStatus({
      activeProvenanceKind: "extraction",
      extractionRunCount: 0,
      bootstrapRunCount: 0,
      primaryFigureCount: 0,
    })).toBe("published_extraction");

    expect(figureAuditInternals.classifyFigureRolloutStatus({
      activeProvenanceKind: "legacy_bootstrap",
      extractionRunCount: 10,
      bootstrapRunCount: 4,
      primaryFigureCount: 12,
    })).toBe("published_bootstrap");
  });

  it("falls back through extraction, bootstrap, legacy, and empty states", () => {
    expect(figureAuditInternals.classifyFigureRolloutStatus({
      activeProvenanceKind: null,
      extractionRunCount: 2,
      bootstrapRunCount: 0,
      primaryFigureCount: 0,
    })).toBe("extraction_only_unpublished");

    expect(figureAuditInternals.classifyFigureRolloutStatus({
      activeProvenanceKind: null,
      extractionRunCount: 0,
      bootstrapRunCount: 1,
      primaryFigureCount: 0,
    })).toBe("bootstrap_only_unpublished");

    expect(figureAuditInternals.classifyFigureRolloutStatus({
      activeProvenanceKind: null,
      extractionRunCount: 0,
      bootstrapRunCount: 0,
      primaryFigureCount: 3,
    })).toBe("legacy_only");

    expect(figureAuditInternals.classifyFigureRolloutStatus({
      activeProvenanceKind: null,
      extractionRunCount: 0,
      bootstrapRunCount: 0,
      primaryFigureCount: 0,
    })).toBe("no_figure_state");
  });

  it("summarizes primary figure surface stats", () => {
    const summary = figureAuditInternals.summarizePaperFigures([
      {
        imagePath: "/tmp/a.png",
        gapReason: null,
        sourceMethod: "pmc_jats",
        type: "figure",
        publishedFigureHandleId: "handle-1",
      },
      {
        imagePath: null,
        gapReason: "structured_content_no_preview",
        sourceMethod: "publisher_html",
        type: "table",
        publishedFigureHandleId: "handle-2",
      },
      {
        imagePath: null,
        gapReason: "manual_override",
        sourceMethod: "pdf_fallback",
        type: "figure",
        publishedFigureHandleId: null,
      },
    ]);

    expect(summary.primaryFigures).toBe(3);
    expect(summary.figuresWithImages).toBe(1);
    expect(summary.gapFigures).toBe(2);
    expect(summary.withPublishedHandle).toBe(2);
    expect(summary.byType).toEqual({ figure: 2, table: 1 });
    expect(summary.bySourceMethod).toEqual({
      pmc_jats: 1,
      publisher_html: 1,
      pdf_fallback: 1,
    });
    expect(summary.byGapReason).toEqual({
      structured_content_no_preview: 1,
      manual_override: 1,
    });
  });
});
