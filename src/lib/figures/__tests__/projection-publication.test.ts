import { describe, expect, it } from "vitest";

import { projectionPublicationInternals } from "../projection-publication";

function makeCandidate(
  overrides: Partial<
    Parameters<typeof projectionPublicationInternals.candidateToProjectable>[0]
  > = {},
) {
  return {
    id: "cand-1",
    sourceMethod: "pdf_embedded",
    sourceOrder: 0,
    figureLabelRaw: null,
    captionTextRaw: null,
    structuredContentRaw: null,
    structuredContentType: null,
    pageAnchorCandidate: null,
    diagnostics: JSON.stringify({
      captionSource: "none",
      sourceUrl: null,
      cropOutcome: null,
      imagePath: null,
      width: null,
      height: null,
    }),
    type: "figure",
    confidence: "medium",
    nativeAsset: null,
    ...overrides,
  };
}

describe("buildProjectionFigureDraft", () => {
  it("keeps structured tables as canonical content while rejecting unsafe PDF previews", () => {
    const draft = projectionPublicationInternals.buildProjectionFigureDraft("identity-1", "table:main:label:table 1", [
      projectionPublicationInternals.candidateToProjectable(
        makeCandidate({
          id: "html-table",
          sourceMethod: "arxiv_html",
          type: "table",
          figureLabelRaw: "Table 1",
          structuredContentRaw: "<table><tr><td>A</td></tr></table>".repeat(20),
          structuredContentType: "html_table",
          diagnostics: JSON.stringify({
            captionSource: "html_figcaption",
            sourceUrl: "https://arxiv.org/html/1234",
          }),
        }),
      ),
      projectionPublicationInternals.candidateToProjectable(
        makeCandidate({
          id: "pdf-crop",
          sourceMethod: "pdf_render_crop",
          type: "table",
          figureLabelRaw: "Table 1",
          pageAnchorCandidate: JSON.stringify({ pdfPage: 7, bbox: "10,10,50,50" }),
          diagnostics: JSON.stringify({
            captionSource: "pdf_caption",
            cropOutcome: "success",
            imagePath: "uploads/figures/paper/crop-p7-table1.png",
            width: 800,
            height: 600,
          }),
          nativeAsset: {
            storagePath: "uploads/figures/paper/crop-p7-table1.png",
            contentHash: "pdf-crop-asset",
            width: 800,
            height: 600,
          },
        }),
      ),
    ]);

    expect(draft).not.toBeNull();
    expect(draft?.contentCandidateId).toBe("html-table");
    expect(draft?.basePreviewCandidateId).toBeNull();
    expect(draft?.imagePath).toBeNull();
    expect(draft?.gapReason).toBe("structured_content_no_preview");
    expect(draft?.pageAnchorCandidateId).toBe("pdf-crop");
    expect(draft?.pageSourceMethod).toBe("pdf_render_crop");
  });

  it("suppresses unlabeled PDF-only identities from canonical projection", () => {
    const draft = projectionPublicationInternals.buildProjectionFigureDraft("identity-2", "figure:default:asset:pdf-1", [
      projectionPublicationInternals.candidateToProjectable(
        makeCandidate({
          id: "pdf-1",
          sourceMethod: "pdf_embedded",
          diagnostics: JSON.stringify({
            captionSource: "none",
            imagePath: "uploads/figures/paper/p4-img1.png",
            width: 300,
            height: 200,
          }),
          nativeAsset: {
            storagePath: "uploads/figures/paper/p4-img1.png",
            contentHash: "pdf-1",
            width: 300,
            height: 200,
          },
        }),
      ),
      projectionPublicationInternals.candidateToProjectable(
        makeCandidate({
          id: "pdf-2",
          sourceMethod: "pdf_render_crop",
          diagnostics: JSON.stringify({
            captionSource: "none",
            imagePath: "uploads/figures/paper/p4-img2.png",
            width: 320,
            height: 220,
          }),
          nativeAsset: {
            storagePath: "uploads/figures/paper/p4-img2.png",
            contentHash: "pdf-2",
            width: 320,
            height: 220,
          },
        }),
      ),
    ]);

    expect(draft).toBeNull();
  });

  it("suppresses unlabeled GROBID-only identities even if they carry caption text", () => {
    const draft = projectionPublicationInternals.buildProjectionFigureDraft("identity-grobid", "table:default:locator:grobid_tei:page:6:idx:6", [
      projectionPublicationInternals.candidateToProjectable(
        makeCandidate({
          id: "grobid-ghost",
          sourceMethod: "grobid_tei",
          type: "table",
          captionTextRaw: "Confusion matrices showing the performance of detectors...",
          pageAnchorCandidate: JSON.stringify({ pdfPage: 6, bbox: "70.62,74.80,455.44,415.70" }),
          diagnostics: JSON.stringify({
            captionSource: "grobid_tei",
            sourceUrl: null,
            cropOutcome: null,
            imagePath: null,
            width: null,
            height: null,
          }),
        }),
      ),
    ]);

    expect(draft).toBeNull();
  });

  it("sorts projection drafts by page, then source order, then label", () => {
    const sorted = projectionPublicationInternals.sortProjectionFigureDrafts([
      {
        figureIdentityId: "c",
        identityKey: "figure:default:label:figure 3",
        sourceMethod: "arxiv_html",
        imageSourceMethod: null,
        pageSourceMethod: null,
        contentCandidateId: "c",
        basePreviewCandidateId: null,
        pageAnchorCandidateId: null,
        figureLabel: "Figure 3",
        captionText: null,
        captionSource: "none",
        structuredContent: null,
        structuredContentType: null,
        sourceUrl: null,
        confidence: "medium",
        imagePath: null,
        assetHash: null,
        pdfPage: null,
        bbox: null,
        type: "figure",
        width: null,
        height: null,
        gapReason: "no_image_candidate",
        sortHintPage: 9,
        sortHintOrder: 2,
        sortHintLabel: "figure 3",
      },
      {
        figureIdentityId: "a",
        identityKey: "figure:default:label:figure 1",
        sourceMethod: "arxiv_html",
        imageSourceMethod: null,
        pageSourceMethod: null,
        contentCandidateId: "a",
        basePreviewCandidateId: null,
        pageAnchorCandidateId: null,
        figureLabel: "Figure 1",
        captionText: null,
        captionSource: "none",
        structuredContent: null,
        structuredContentType: null,
        sourceUrl: null,
        confidence: "medium",
        imagePath: null,
        assetHash: null,
        pdfPage: null,
        bbox: null,
        type: "figure",
        width: null,
        height: null,
        gapReason: "no_image_candidate",
        sortHintPage: 5,
        sortHintOrder: 1,
        sortHintLabel: "figure 1",
      },
      {
        figureIdentityId: "b",
        identityKey: "figure:default:label:figure 2",
        sourceMethod: "arxiv_html",
        imageSourceMethod: null,
        pageSourceMethod: null,
        contentCandidateId: "b",
        basePreviewCandidateId: null,
        pageAnchorCandidateId: null,
        figureLabel: "Figure 2",
        captionText: null,
        captionSource: "none",
        structuredContent: null,
        structuredContentType: null,
        sourceUrl: null,
        confidence: "medium",
        imagePath: null,
        assetHash: null,
        pdfPage: null,
        bbox: null,
        type: "figure",
        width: null,
        height: null,
        gapReason: "no_image_candidate",
        sortHintPage: 5,
        sortHintOrder: 2,
        sortHintLabel: "figure 2",
      },
    ]);

    expect(sorted.map((draft) => draft.figureIdentityId)).toEqual(["a", "b", "c"]);
  });

  it("keeps structured figure content canonical while using PDF fallback only for preview", () => {
    const draft = projectionPublicationInternals.buildProjectionFigureDraft("identity-3", "figure:main:label:figure 2", [
      projectionPublicationInternals.candidateToProjectable(
        makeCandidate({
          id: "html-figure",
          sourceMethod: "arxiv_html",
          type: "figure",
          figureLabelRaw: "Figure 2",
          captionTextRaw: "Structured figure caption",
          diagnostics: JSON.stringify({
            captionSource: "html_figcaption",
            sourceUrl: "https://arxiv.org/html/1234",
          }),
        }),
      ),
      projectionPublicationInternals.candidateToProjectable(
        makeCandidate({
          id: "pdf-crop-figure",
          sourceMethod: "pdf_render_crop",
          type: "figure",
          figureLabelRaw: "Figure 2",
          captionTextRaw: "Structured figure caption",
          pageAnchorCandidate: JSON.stringify({ pdfPage: 5, bbox: "1,2,3,4" }),
          diagnostics: JSON.stringify({
            captionSource: "pdf_caption",
            cropOutcome: "success",
            imagePath: "uploads/figures/paper/crop-p5-figure2.png",
            width: 900,
            height: 700,
          }),
          nativeAsset: {
            storagePath: "uploads/figures/paper/crop-p5-figure2.png",
            contentHash: "pdf-crop-figure-asset",
            width: 900,
            height: 700,
          },
        }),
      ),
    ]);

    expect(draft).not.toBeNull();
    expect(draft?.sourceMethod).toBe("arxiv_html");
    expect(draft?.contentCandidateId).toBe("html-figure");
    expect(draft?.basePreviewCandidateId).toBe("pdf-crop-figure");
    expect(draft?.imageSourceMethod).toBe("pdf_render_crop");
    expect(draft?.imagePath).toBe("uploads/figures/paper/crop-p5-figure2.png");
    expect(draft?.captionSource).toBe("html_figcaption");
  });

  it("dedupes compatibility alternates that would collide on sourceMethod and assetHash", () => {
    const deduped = projectionPublicationInternals.dedupeCompatibilityAlternates([
      {
        figureLabel: null,
        captionText: null,
        captionSource: "none",
        sourceMethod: "arxiv_html",
        sourceUrl: "https://arxiv.org/html/paper#frag",
        confidence: "medium",
        imagePath: "uploads/figures/paper/html-1.png",
        assetHash: "same-asset",
        pdfPage: null,
        bbox: null,
        type: "figure",
        width: 500,
        height: 300,
        description: null,
        gapReason: null,
        imageSourceMethod: "arxiv_html",
        isPrimaryExtraction: false,
      },
      {
        figureLabel: "Figure 1",
        captionText: "Main figure caption",
        captionSource: "html_figcaption",
        sourceMethod: "arxiv_html",
        sourceUrl: "https://arxiv.org/html/paper#figure1",
        confidence: "medium",
        imagePath: "uploads/figures/paper/html-1.png",
        assetHash: "same-asset",
        pdfPage: null,
        bbox: null,
        type: "figure",
        width: 500,
        height: 300,
        description: null,
        gapReason: null,
        imageSourceMethod: "arxiv_html",
        isPrimaryExtraction: false,
      },
      {
        figureLabel: "Figure 2",
        captionText: "Distinct asset",
        captionSource: "html_figcaption",
        sourceMethod: "arxiv_html",
        sourceUrl: "https://arxiv.org/html/paper#figure2",
        confidence: "medium",
        imagePath: "uploads/figures/paper/html-2.png",
        assetHash: "other-asset",
        pdfPage: null,
        bbox: null,
        type: "figure",
        width: 520,
        height: 320,
        description: null,
        gapReason: null,
        imageSourceMethod: "arxiv_html",
        isPrimaryExtraction: false,
      },
    ]);

    expect(deduped).toHaveLength(2);
    expect(deduped[0]?.figureLabel).toBe("Figure 1");
    expect(deduped[1]?.figureLabel).toBe("Figure 2");
  });

  it("skips compatibility alternates that would collide with primary paper figures", () => {
    const deduped = projectionPublicationInternals.dedupeCompatibilityAlternates(
      [
        {
          figureLabel: "Figure 1",
          captionText: "Primary-colliding alternate",
          captionSource: "html_figcaption",
          sourceMethod: "arxiv_html",
          sourceUrl: "https://arxiv.org/html/paper#figure1",
          confidence: "medium",
          imagePath: "uploads/figures/paper/html-1.png",
          assetHash: "same-as-primary",
          pdfPage: null,
          bbox: null,
          type: "figure",
          width: 500,
          height: 300,
          description: null,
          gapReason: null,
          imageSourceMethod: "arxiv_html",
          isPrimaryExtraction: false,
        },
        {
          figureLabel: "Figure 2",
          captionText: "Keep me",
          captionSource: "html_figcaption",
          sourceMethod: "arxiv_html",
          sourceUrl: "https://arxiv.org/html/paper#figure2",
          confidence: "medium",
          imagePath: "uploads/figures/paper/html-2.png",
          assetHash: "alternate-asset",
          pdfPage: null,
          bbox: null,
          type: "figure",
          width: 520,
          height: 320,
          description: null,
          gapReason: null,
          imageSourceMethod: "arxiv_html",
          isPrimaryExtraction: false,
        },
      ],
      new Set(["arxiv_html:same-as-primary"]),
    );

    expect(deduped).toHaveLength(1);
    expect(deduped[0]?.figureLabel).toBe("Figure 2");
  });
});

describe("planPublishedFigureHandleAssignments", () => {
  it("reuses handles when identity keys match the active projection", () => {
    const assignments = projectionPublicationInternals.planPublishedFigureHandleAssignments(
      [
        {
          projectionFigureId: "current-1",
          identityKey: "figure:main:label:figure 1",
        },
      ],
      [
        {
          projectionFigureId: "previous-1",
          identityKey: "figure:main:label:figure 1",
          publishedFigureHandleId: "handle-1",
        },
      ],
    );

    expect(assignments).toEqual([
      expect.objectContaining({
        projectionFigureId: "current-1",
        assignmentDecision: "reuse",
        predecessorProjectionFigureId: "previous-1",
        publishedFigureHandleId: "handle-1",
        handleAssignmentEvidenceType: "identity_key",
      }),
    ]);
  });

  it("allocates new handles when there is no continuity match", () => {
    const assignments = projectionPublicationInternals.planPublishedFigureHandleAssignments(
      [
        {
          projectionFigureId: "current-2",
          identityKey: "figure:main:label:figure 2",
        },
      ],
      [],
    );

    expect(assignments).toEqual([
      expect.objectContaining({
        projectionFigureId: "current-2",
        assignmentDecision: "new",
        predecessorProjectionFigureId: null,
        publishedFigureHandleId: null,
        handleAssignmentEvidenceType: "identity_key_new",
      }),
    ]);
  });
});
