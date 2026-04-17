import { describe, expect, it } from "vitest";

import { pdfFigurePipelineInternals } from "../pdf-figure-pipeline";

describe("evaluatePdfCropAcceptance", () => {
  it("accepts sufficiently large graphics-backed figure crops", () => {
    expect(pdfFigurePipelineInternals.evaluatePdfCropAcceptance({
      type: "figure",
      width: 640,
      height: 480,
      regionKind: "graphics",
    })).toEqual({ accepted: true });
  });

  it("rejects figure crops that only came from text fallback", () => {
    expect(pdfFigurePipelineInternals.evaluatePdfCropAcceptance({
      type: "figure",
      width: 900,
      height: 260,
      regionKind: "text",
    })).toEqual({
      accepted: false,
      rejectionReason: "crop_rejected",
    });
  });

  it("still allows text-backed table crops when size is adequate", () => {
    expect(pdfFigurePipelineInternals.evaluatePdfCropAcceptance({
      type: "table",
      width: 900,
      height: 260,
      regionKind: "text",
    })).toEqual({ accepted: true });
  });

  it("rejects tiny crops regardless of detector", () => {
    expect(pdfFigurePipelineInternals.evaluatePdfCropAcceptance({
      type: "figure",
      width: 180,
      height: 80,
      regionKind: "graphics",
    })).toEqual({
      accepted: false,
      rejectionReason: "crop_rejected",
    });
  });
});
