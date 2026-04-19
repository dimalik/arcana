import { describe, expect, it } from "vitest";

import {
  buildManifestRowId,
  validateManifestDecision,
  type CitationContextDecision,
  type ReferenceMetadataDecision,
} from "../reference-quality-manifest";

describe("reference-quality-manifest", () => {
  it("builds stable manifest row ids from stable parts", () => {
    const left = buildManifestRowId("reference_metadata", ["paper-1", "entry-1", "reference_metadata"]);
    const right = buildManifestRowId("reference_metadata", ["paper-1", "entry-1", "reference_metadata"]);
    const different = buildManifestRowId("reference_metadata", ["paper-1", "entry-2", "reference_metadata"]);

    expect(left).toBe(right);
    expect(left).not.toBe(different);
  });

  it("rejects disallowed suppression actions on title and authors", () => {
    const decision: ReferenceMetadataDecision = {
      manifestRowId: "row-1",
      kind: "reference_metadata",
      referenceEntryId: "entry-1",
      legacyReferenceId: "legacy-1",
      paperId: "paper-1",
      pollutedFields: [
        { field: "title", beforeValue: "BAD + 24] Broken Title" },
        { field: "authors", beforeValue: "[\"BAD + 24] Alice\"]" },
      ],
      candidate: null,
      candidateSource: "none",
      candidateIdentifiers: {
        doi: null,
        arxivId: null,
        semanticScholarId: null,
        externalUrl: null,
      },
      confidence: { score: null, reason: "none" },
      fieldActions: {
        title: "suppress",
        authors: "suppress",
      },
      persistIdentifiers: false,
      actionReason: "invalid",
    };

    expect(validateManifestDecision(decision)).toEqual(
      expect.arrayContaining([
        "title cannot be suppressed",
        "title has invalid action suppress",
        "authors cannot be suppressed",
        "authors has invalid action suppress",
      ]),
    );
  });

  it("requires candidate metadata for replace actions", () => {
    const decision: ReferenceMetadataDecision = {
      manifestRowId: "row-2",
      kind: "reference_metadata",
      referenceEntryId: "entry-1",
      legacyReferenceId: "legacy-1",
      paperId: "paper-1",
      pollutedFields: [{ field: "venue", beforeValue: "FDL + 24" }],
      candidate: null,
      candidateSource: "none",
      candidateIdentifiers: {
        doi: null,
        arxivId: null,
        semanticScholarId: null,
        externalUrl: null,
      },
      confidence: { score: null, reason: "none" },
      fieldActions: {
        venue: "replace",
      },
      persistIdentifiers: true,
      actionReason: "invalid",
    };

    expect(validateManifestDecision(decision)).toEqual(
      expect.arrayContaining([
        "replace action requires candidate",
        "replace action requires non-none candidateSource",
      ]),
    );
  });

  it("requires normalizedValue for replace_normalized citation-context decisions", () => {
    const decision: CitationContextDecision = {
      manifestRowId: "row-3",
      kind: "citation_context",
      referenceEntryId: "entry-1",
      legacyReferenceId: "legacy-1",
      paperId: "paper-1",
      scope: "legacy_reference_context",
      mentionId: null,
      beforeValue: "Bad [LLLL23] context",
      normalizedValue: null,
      action: "replace_normalized",
      actionReason: "invalid",
    };

    expect(validateManifestDecision(decision)).toEqual(
      expect.arrayContaining(["replace_normalized requires normalizedValue"]),
    );
  });
});
