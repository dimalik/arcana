import { describe, expect, it } from "vitest";

import {
  buildInitialReferenceState,
  classifyReferenceState,
} from "../reference-state";

describe("reference state classification", () => {
  it("treats any paper with references as available even without a PDF", () => {
    expect(
      classifyReferenceState({
        referenceCount: 3,
        filePath: null,
        fullText: "HTML body",
        processingStatus: "NO_PDF",
      }),
    ).toBe("available");
  });

  it("marks PDF-backed terminal papers with zero references as extraction_failed", () => {
    expect(
      classifyReferenceState({
        referenceCount: 0,
        filePath: "/tmp/paper.pdf",
        fullText: "Body text",
        processingStatus: "COMPLETED",
      }),
    ).toBe("extraction_failed");
  });

  it("marks HTML-only papers without references as unavailable_no_pdf", () => {
    expect(
      buildInitialReferenceState({
        filePath: null,
        fullText: "HTML body",
        processingStatus: "TEXT_EXTRACTED",
      }),
    ).toBe("unavailable_no_pdf");
  });
});
