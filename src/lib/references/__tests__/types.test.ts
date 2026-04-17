import { describe, expect, it } from "vitest";
import { isExtractionMethod, isPreflightResult } from "../types";

describe("reference extraction types", () => {
  describe("isExtractionMethod", () => {
    it("accepts valid extraction methods", () => {
      expect(isExtractionMethod("grobid_tei")).toBe(true);
      expect(isExtractionMethod("llm_repair")).toBe(true);
      expect(isExtractionMethod("source_native")).toBe(true);
    });

    it("rejects invalid extraction methods", () => {
      expect(isExtractionMethod("openai")).toBe(false);
      expect(isExtractionMethod("")).toBe(false);
      expect(isExtractionMethod(null)).toBe(false);
    });
  });

  describe("isPreflightResult", () => {
    it("accepts valid preflight results", () => {
      expect(isPreflightResult("text_layer_ok")).toBe(true);
      expect(isPreflightResult("text_layer_missing")).toBe(true);
      expect(isPreflightResult("text_layer_garbled")).toBe(true);
      expect(isPreflightResult("preflight_error")).toBe(true);
      expect(isPreflightResult("not_applicable")).toBe(true);
    });

    it("rejects invalid preflight results", () => {
      expect(isPreflightResult("ok")).toBe(false);
      expect(isPreflightResult("")).toBe(false);
    });
  });
});
