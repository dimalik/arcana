import { describe, expect, it } from "vitest";

import {
  getKnownPaperUsageOperations,
  getProviderUsageSegment,
} from "./usage-segmentation";
import {
  PAPER_ANALYSIS_LLM_OPERATION_VALUES,
  PAPER_INTERACTIVE_LLM_OPERATION_VALUES,
  PAPER_REFERENCE_ENRICHMENT_LLM_OPERATION_VALUES,
} from "./llm/paper-llm-operations";

describe("usage segmentation", () => {
  it("maps every committed interactive paper operation to the interactive segment", () => {
    for (const operation of PAPER_INTERACTIVE_LLM_OPERATION_VALUES) {
      expect(getProviderUsageSegment(operation)).toBe("interactive");
    }
    for (const operation of PAPER_ANALYSIS_LLM_OPERATION_VALUES) {
      expect(getProviderUsageSegment(operation)).toBe("interactive");
    }
  });

  it("maps reference-enrichment operations to the reference_enrichment segment", () => {
    for (const operation of PAPER_REFERENCE_ENRICHMENT_LLM_OPERATION_VALUES) {
      expect(getProviderUsageSegment(operation)).toBe("reference_enrichment");
    }
    expect(getProviderUsageSegment("processing_extractReferences")).toBe(
      "reference_enrichment",
    );
    expect(getProviderUsageSegment("processing_extractCitationContexts")).toBe(
      "reference_enrichment",
    );
  });

  it("maps non-reference processing operations by the processing_ prefix", () => {
    expect(getProviderUsageSegment("processing_summarize")).toBe("processing");
    expect(getProviderUsageSegment("processing_extract")).toBe("processing");
  });

  it("routes unknown operations to unclassified", () => {
    expect(getProviderUsageSegment("research-chat")).toBe("unclassified");
  });

  it("keeps the known paper operation fixture free of unclassified entries", () => {
    const unclassified = getKnownPaperUsageOperations().filter(
      (operation) => getProviderUsageSegment(operation) === "unclassified",
    );
    expect(unclassified).toEqual([]);
  });
});
