import { describe, expect, it } from "vitest";

import { identityResolutionInternals } from "../identity-resolution";

function makeCandidate(overrides: Partial<Parameters<typeof identityResolutionInternals.resolveCandidateIdentityGroups>[0][number]> = {}) {
  return {
    id: "cand-1",
    paperId: "paper-1",
    type: "figure",
    sourceMethod: "pdf_embedded",
    sourceNamespace: null,
    sourceLocalLocator: null,
    sourceOrder: 0,
    figureLabelNormalized: null,
    nativeAssetHash: null,
    ...overrides,
  };
}

describe("resolveCandidateIdentityGroups", () => {
  it("groups same normalized label within the same namespace", () => {
    const groups = identityResolutionInternals.resolveCandidateIdentityGroups([
      makeCandidate({
        id: "a",
        sourceMethod: "pmc_jats",
        figureLabelNormalized: "figure 1",
      }),
      makeCandidate({
        id: "b",
        sourceMethod: "pdf_embedded",
        figureLabelNormalized: "figure 1",
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].members.map((member) => member.id)).toEqual(["a", "b"]);
    expect(groups[0].key).toBe("figure:default:label:figure 1");
  });

  it("keeps same label in different namespaces as separate identities", () => {
    const groups = identityResolutionInternals.resolveCandidateIdentityGroups([
      makeCandidate({
        id: "main",
        sourceMethod: "pmc_jats",
        sourceNamespace: "main",
        figureLabelNormalized: "table 1",
        type: "table",
      }),
      makeCandidate({
        id: "appendix",
        sourceMethod: "pmc_jats",
        sourceNamespace: "appendix",
        figureLabelNormalized: "table 1",
        type: "table",
      }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.key).sort()).toEqual([
      "table:appendix:label:table 1",
      "table:main:label:table 1",
    ]);
  });

  it("groups unlabeled candidates by shared asset hash", () => {
    const groups = identityResolutionInternals.resolveCandidateIdentityGroups([
      makeCandidate({
        id: "img-a",
        sourceMethod: "pdf_embedded",
        nativeAssetHash: "same-asset",
      }),
      makeCandidate({
        id: "img-b",
        sourceMethod: "grobid_tei",
        nativeAssetHash: "same-asset",
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe("figure:default:asset:same-asset");
  });

  it("prefers stronger source priority when ordering members", () => {
    const groups = identityResolutionInternals.resolveCandidateIdentityGroups([
      makeCandidate({
        id: "pdf",
        sourceMethod: "pdf_embedded",
        figureLabelNormalized: "figure 5",
      }),
      makeCandidate({
        id: "arxiv",
        sourceMethod: "arxiv_html",
        figureLabelNormalized: "figure 5",
      }),
    ]);

    expect(groups[0].members.map((member) => member.id)).toEqual(["arxiv", "pdf"]);
  });
});
