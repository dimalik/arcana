import { describe, expect, it } from "vitest";

import {
  SHARED_RAW_PAPER_VECTOR_DIMENSIONS,
  averageVectors,
  buildSharedPaperFeatureDocument,
  cosineSimilarity,
  encodeFeatureSectionsToVector,
  encodeTextToVector,
} from "./embeddings";

describe("retrieval embeddings", () => {
  it("builds a stable shared feature document", () => {
    const document = buildSharedPaperFeatureDocument({
      title: "Attention Is All You Need",
      abstract: "Transformers replace recurrence with attention.",
      summary: "A sequence model built entirely on attention.",
      keyFindings: JSON.stringify([
        "Scaled dot-product attention improves translation quality.",
      ]),
      authors: JSON.stringify(["Ashish Vaswani", "Noam Shazeer"]),
      venue: "NeurIPS",
      year: 2017,
      tags: [{ tag: { name: "transformers" } }],
      claims: [
        {
          normalizedText: "transformers remove recurrence",
          rhetoricalRole: "result",
          facet: "method",
          polarity: "positive",
          sectionPath: "main/results",
          evaluationContext: JSON.stringify({
            task: "machine translation",
            dataset: "wmt14 en-de",
            metric: "bleu",
          }),
        },
      ],
    });

    expect(document.metadata.authorNames).toEqual([
      "ashish vaswani",
      "noam shazeer",
    ]);
    expect(document.metadata.tagNames).toEqual(["transformers"]);
    expect(document.metadata.claimCount).toBe(1);
    expect(document.featureText).toContain("title: Attention Is All You Need");
    expect(document.featureText).toContain("claim:");
  });

  it("encodes sections deterministically", () => {
    const sections = [
      { label: "title", text: "transformer attention", weight: 3 },
      { label: "abstract", text: "sequence models use attention", weight: 2 },
    ];

    const first = encodeFeatureSectionsToVector(
      sections,
      SHARED_RAW_PAPER_VECTOR_DIMENSIONS,
    );
    const second = encodeFeatureSectionsToVector(
      sections,
      SHARED_RAW_PAPER_VECTOR_DIMENSIONS,
    );

    expect(first).toEqual(second);
    expect(first).toHaveLength(SHARED_RAW_PAPER_VECTOR_DIMENSIONS);
  });

  it("keeps related texts closer than unrelated ones", () => {
    const query = encodeTextToVector("transformer attention for translation");
    const related = encodeTextToVector("attention based transformer translation model");
    const unrelated = encodeTextToVector("protein folding with molecular dynamics");

    expect(cosineSimilarity(query, related)).toBeGreaterThan(
      cosineSimilarity(query, unrelated),
    );
  });

  it("averages vectors into a normalized profile vector", () => {
    const first = encodeTextToVector("graph neural networks");
    const second = encodeTextToVector("neural graph representations");
    const profile = averageVectors([first, second]);

    expect(profile).toHaveLength(SHARED_RAW_PAPER_VECTOR_DIMENSIONS);
    expect(cosineSimilarity(profile, first)).toBeGreaterThan(0);
  });
});
