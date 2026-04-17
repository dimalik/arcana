import { describe, expect, it } from "vitest";

import {
  figureRetentionInternals,
  DEFAULT_FIGURE_RETENTION_POLICY,
} from "../figure-retention";

describe("figure-retention", () => {
  it("retains active publication closure plus bounded history", () => {
    const result = figureRetentionInternals.computeRetainedFigureRoots({
      activeProjectionRunId: "projection-active",
      activeIdentityResolutionId: "identity-active",
      activePreviewSelectionRunId: "preview-active",
      latestBootstrapRunId: "bootstrap-latest",
      projectionRuns: [
        { id: "projection-active", identityResolutionId: "identity-active", createdAt: new Date("2026-04-16T12:00:00Z") },
        { id: "projection-old-1", identityResolutionId: "identity-old-1", createdAt: new Date("2026-04-15T12:00:00Z") },
        { id: "projection-old-2", identityResolutionId: "identity-old-2", createdAt: new Date("2026-04-14T12:00:00Z") },
      ],
      previewSelectionRuns: [
        { id: "preview-active", projectionRunId: "projection-active", createdAt: new Date("2026-04-16T12:00:00Z") },
        { id: "preview-old-1", projectionRunId: "projection-old-1", createdAt: new Date("2026-04-15T12:00:00Z") },
        { id: "preview-old-2", projectionRunId: "projection-old-2", createdAt: new Date("2026-04-14T12:00:00Z") },
      ],
      identityResolutions: [
        { id: "identity-active", extractionRunId: "extraction-active", bootstrapRunId: null, createdAt: new Date("2026-04-16T12:00:00Z") },
        { id: "identity-old-1", extractionRunId: null, bootstrapRunId: "bootstrap-old-1", createdAt: new Date("2026-04-15T12:00:00Z") },
        { id: "identity-old-2", extractionRunId: "extraction-old-2", bootstrapRunId: null, createdAt: new Date("2026-04-14T12:00:00Z") },
      ],
      extractionRuns: [
        { id: "extraction-active", capabilitySnapshotId: "snapshot-active", createdAt: new Date("2026-04-16T11:00:00Z") },
        { id: "extraction-old-2", capabilitySnapshotId: "snapshot-old-2", createdAt: new Date("2026-04-14T11:00:00Z") },
        { id: "extraction-free", capabilitySnapshotId: "snapshot-free", createdAt: new Date("2026-04-13T11:00:00Z") },
      ],
      bootstrapRuns: [
        { id: "bootstrap-latest", createdAt: new Date("2026-04-16T10:00:00Z") },
        { id: "bootstrap-old-1", createdAt: new Date("2026-04-15T10:00:00Z") },
        { id: "bootstrap-free", createdAt: new Date("2026-04-13T10:00:00Z") },
      ],
    }, {
      keepProjectionRuns: 1,
      keepExtractionRuns: 1,
      keepBootstrapRuns: 1,
    });

    expect(Array.from(result.projectionRunIds)).toEqual([
      "projection-active",
      "projection-old-1",
    ]);
    expect(Array.from(result.previewSelectionRunIds)).toEqual([
      "preview-active",
      "preview-old-1",
    ]);
    expect(Array.from(result.identityResolutionIds)).toEqual([
      "identity-active",
      "identity-old-1",
    ]);
    expect(Array.from(result.extractionRunIds)).toEqual([
      "extraction-active",
      "extraction-old-2",
    ]);
    expect(Array.from(result.capabilitySnapshotIds)).toEqual([
      "snapshot-active",
      "snapshot-old-2",
    ]);
    expect(Array.from(result.bootstrapRunIds)).toEqual([
      "bootstrap-old-1",
      "bootstrap-latest",
      "bootstrap-free",
    ]);
  });

  it("defaults to active-only roots when no history exists", () => {
    const result = figureRetentionInternals.computeRetainedFigureRoots({
      activeProjectionRunId: null,
      activeIdentityResolutionId: null,
      activePreviewSelectionRunId: null,
      latestBootstrapRunId: null,
      projectionRuns: [],
      previewSelectionRuns: [],
      identityResolutions: [],
      extractionRuns: [],
      bootstrapRuns: [],
    }, DEFAULT_FIGURE_RETENTION_POLICY);

    expect(Array.from(result.projectionRunIds)).toEqual([]);
    expect(Array.from(result.previewSelectionRunIds)).toEqual([]);
    expect(Array.from(result.identityResolutionIds)).toEqual([]);
    expect(Array.from(result.extractionRunIds)).toEqual([]);
    expect(Array.from(result.capabilitySnapshotIds)).toEqual([]);
    expect(Array.from(result.bootstrapRunIds)).toEqual([]);
  });
});
