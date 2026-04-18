import { describe, expect, it } from "vitest";

import {
  StructuredRuntimeOutputError,
  parseStructuredRuntimeOutputText,
  serializeStructuredRuntimeOutput,
} from "../runtime-output-schemas";

describe("runtime output schemas", () => {
  it("preserves the full extract payload when normalizing structured output", () => {
    const parsed = parseStructuredRuntimeOutputText(
      "extract",
      JSON.stringify({
        title: "Paper title",
        authors: ["Ada Lovelace"],
        year: 2026,
        venue: "ICML",
        doi: "10.1000/example",
        arxivId: "2501.12345",
        abstract: "Abstract",
        keyFindings: ["Finding"],
        methodology: "Benchmarked retrieval models",
        contributions: ["Contribution"],
        limitations: ["Limitation"],
      }),
      "provider",
    );

    expect(JSON.parse(serializeStructuredRuntimeOutput("extract", parsed))).toEqual(
      expect.objectContaining({
        doi: "10.1000/example",
        arxivId: "2501.12345",
        methodology: "Benchmarked retrieval models",
        contributions: ["Contribution"],
        limitations: ["Limitation"],
      }),
    );
  });

  it("normalizes legacy extractReferences arrays under the frozen schema", () => {
    const parsed = parseStructuredRuntimeOutputText(
      "extractReferences",
      JSON.stringify([
        {
          index: 1,
          title: "Scaling Laws for Neural Language Models",
          authors: ["Jared Kaplan"],
          year: 2020,
          venue: "arXiv",
          doi: null,
          rawCitation: "Kaplan et al. 2020. Scaling Laws for Neural Language Models.",
        },
      ]),
      "batch",
    );

    expect(
      JSON.parse(serializeStructuredRuntimeOutput("extractReferences", parsed)),
    ).toEqual([
      expect.objectContaining({
        index: 1,
        title: "Scaling Laws for Neural Language Models",
        rawCitation:
          "Kaplan et al. 2020. Scaling Laws for Neural Language Models.",
      }),
    ]);
  });

  it("raises a typed JSON parse error for invalid batch output", () => {
    expect(() =>
      parseStructuredRuntimeOutputText("categorize", "not-json", "batch"),
    ).toThrowError(StructuredRuntimeOutputError);

    try {
      parseStructuredRuntimeOutputText("categorize", "not-json", "batch");
    } catch (error) {
      expect(error).toBeInstanceOf(StructuredRuntimeOutputError);
      expect((error as StructuredRuntimeOutputError).code).toBe(
        "json_parse_failed",
      );
    }
  });

  it("raises a typed schema validation error for mismatched structured output", () => {
    expect(() =>
      parseStructuredRuntimeOutputText(
        "categorize",
        JSON.stringify({ tags: "nlp" }),
        "provider",
      ),
    ).toThrowError(StructuredRuntimeOutputError);

    try {
      parseStructuredRuntimeOutputText(
        "categorize",
        JSON.stringify({ tags: "nlp" }),
        "provider",
      );
    } catch (error) {
      expect(error).toBeInstanceOf(StructuredRuntimeOutputError);
      expect((error as StructuredRuntimeOutputError).code).toBe(
        "schema_validation_failed",
      );
    }
  });
});
