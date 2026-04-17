import { describe, expect, it } from "vitest";
import { scoreExtraction, type ExpectedRef, type ExtractedRef } from "../benchmark";

describe("scoreExtraction", () => {
  const expected: ExpectedRef[] = [
    {
      title: "Attention Is All You Need",
      year: 2017,
      doi: "10.5555/3295222.3295349",
    },
    {
      title: "BERT: Pre-training of Deep Bidirectional Transformers",
      year: 2019,
    },
    {
      title: "GPT-2: Language Models are Unsupervised Multitask Learners",
      year: 2019,
    },
  ];

  it("scores perfect extraction", () => {
    const extracted: ExtractedRef[] = [
      {
        title: "Attention Is All You Need",
        year: 2017,
        doi: "10.5555/3295222.3295349",
      },
      {
        title: "BERT: Pre-training of Deep Bidirectional Transformers",
        year: 2019,
      },
      {
        title: "GPT-2: Language Models are Unsupervised Multitask Learners",
        year: 2019,
      },
    ];

    const result = scoreExtraction(expected, extracted);
    expect(result.precision).toBe(1);
    expect(result.recall).toBe(1);
    expect(result.f1).toBe(1);
  });

  it("scores partial extraction", () => {
    const extracted: ExtractedRef[] = [
      { title: "Attention Is All You Need", year: 2017 },
      { title: "Some Extra Paper", year: 2020 },
    ];

    const result = scoreExtraction(expected, extracted);
    expect(result.recall).toBeCloseTo(1 / 3);
    expect(result.precision).toBeCloseTo(1 / 2);
    expect(result.matched).toBe(1);
    expect(result.missed).toBe(2);
    expect(result.extra).toBe(1);
  });

  it("scores empty extraction", () => {
    const result = scoreExtraction(expected, []);
    expect(result.recall).toBe(0);
    expect(result.matched).toBe(0);
    expect(result.missed).toBe(3);
  });

  it("matches on DOI when titles differ slightly", () => {
    const extracted: ExtractedRef[] = [
      {
        title: "Attention is all you need!",
        year: 2017,
        doi: "10.5555/3295222.3295349",
      },
    ];

    const result = scoreExtraction(expected, extracted);
    expect(result.matched).toBe(1);
  });
});
