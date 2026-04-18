import { describe, expect, it } from "vitest";

import {
  getProcessingStatusDisplay,
  getReferenceStateEmptyMessage,
} from "../status-display";

describe("status display", () => {
  it("uses the active processing step when one is present", () => {
    expect(
      getProcessingStatusDisplay({
        processingStatus: "PENDING",
        processingStep: "categorize",
        referenceState: "pending",
      }),
    ).toEqual({
      label: "Categorizing",
      tone: "info",
      showSpinner: true,
    });
  });

  it("surfaces unavailable_no_pdf instead of generic pending text", () => {
    expect(
      getProcessingStatusDisplay({
        processingStatus: "PENDING",
        processingStep: null,
        referenceState: "unavailable_no_pdf",
      }),
    ).toEqual({
      label: "No PDF",
      tone: "warning",
      showSpinner: false,
    });
  });

  it("returns state-specific empty copy for the references tab", () => {
    expect(getReferenceStateEmptyMessage("unavailable_no_pdf")).toBe(
      "Reference extraction requires a PDF.",
    );
    expect(getReferenceStateEmptyMessage("extraction_failed")).toBe(
      "Reference extraction failed. Try re-running.",
    );
    expect(getReferenceStateEmptyMessage("pending")).toBe(
      "Reference extraction in progress.",
    );
    expect(getReferenceStateEmptyMessage("available")).toBe(
      "No references were found in this paper.",
    );
  });
});
