import { describe, expect, it } from "vitest";

import {
  buildRawCitationFallbackText,
  candidateAuthorsPassTrustCheck,
  cleanReferenceText,
  looksLikePollutedAuthors,
  restoreReferenceTitleCasing,
  stripLeadingCitationMarker,
} from "../reference-quality";

describe("candidateAuthorsPassTrustCheck", () => {
  it("rejects truncated candidate author lists when the raw citation clearly carries more authors", () => {
    expect(
      candidateAuthorsPassTrustCheck({
        rawCitation:
          "AON + 21] Jacob Austin, Augustus Odena, Maxwell Nye, Maarten Bosma, Henryk Michalewski, David Dohan, Ellen Jiang, Carrie Cai, Michael Terry, Quoc Le, and Charles Sutton. Program synthesis with large language models. arXiv preprint arXiv:2108.07732, 2021.",
        title: "Program Synthesis with Large Language Models",
        candidateAuthors: ["Jacob Austin"],
      }),
    ).toBe(false);
  });

  it("accepts candidate author lists when the matched citation segment agrees", () => {
    expect(
      candidateAuthorsPassTrustCheck({
        rawCitation:
          "DFE + 22] Tri Dao, Dan Fu, Stefano Ermon, Atri Rudra, and Christopher Re. Flashattention: Fast and memory-efficient exact attention with io-awareness. Advances in Neural Information Processing Systems, 35:16344-16359, 2022.",
        title: "FlashAttention: Fast and Memory-Efficient Exact Attention with IO-Awareness",
        candidateAuthors: [
          "Tri Dao",
          "Daniel Y. Fu",
          "Stefano Ermon",
          "Atri Rudra",
          "Christopher Re",
        ],
      }),
    ).toBe(true);
  });
});

describe("citation key normalization", () => {
  it("strips leading citation-key prefixes with suffix letters", () => {
    expect(
      stripLeadingCitationMarker(
        "DZZ + 24a] Yiran Ding, Li Lyna Zhang, Chengruidong Zhang.",
      ),
    ).toBe("Yiran Ding, Li Lyna Zhang, Chengruidong Zhang.");
  });

  it("strips leading citation-key prefixes followed by separators", () => {
    expect(cleanReferenceText("Fhl + 24 ; Xingyu Fu")).toBe("Xingyu Fu");
  });

  it("flags author lists polluted by citation-key prefixes without closing brackets", () => {
    expect(
      looksLikePollutedAuthors(
        JSON.stringify(["Fhl + 24 ; Xingyu", "Yushi Fu", "Bangzheng Hu"]),
      ),
    ).toBe(true);
  });
});

describe("buildRawCitationFallbackText", () => {
  it("suppresses fallback text when structured metadata is already present", () => {
    expect(
      buildRawCitationFallbackText({
        title: "Longrope: Extending llm context window beyond 2 million tokens",
        authors: JSON.stringify(["Yiran Ding", "Li Lyna Zhang"]),
        year: 2024,
        venue: null,
        rawCitation:
          "DZZ + 24a] Yiran Ding, Li Lyna Zhang, Chengruidong Zhang, Yuanyuan Xu, Ning Shang, Jiahang Xu, Fan Yang, and Mao Yang. Longrope: Extending llm context window beyond 2 million tokens, 2024.",
        citationContext: null,
      }),
    ).toBeNull();
  });

  it("suppresses fallback text when a normalized citation context exists", () => {
    expect(
      buildRawCitationFallbackText({
        title: "LLaVA",
        authors: null,
        year: null,
        venue: null,
        rawCitation: "LLaVA. Large language and vision assistant.",
        citationContext:
          "We adopted the evaluation setting used in Llava-1.5, without any specific prompt.",
      }),
    ).toBeNull();
  });

  it("keeps a cleaned fallback only when structured metadata is otherwise absent", () => {
    expect(
      buildRawCitationFallbackText({
        title: "Unknown reference",
        authors: null,
        year: null,
        venue: null,
        rawCitation:
          "DZZ + 24a] Yiran Ding, Li Lyna Zhang, Chengruidong Zhang. Longrope: Extending llm context window beyond 2 million tokens, 2024.",
        citationContext: null,
      }),
    ).toBe(
      "Yiran Ding, Li Lyna Zhang, Chengruidong Zhang. Longrope: Extending llm context window beyond 2 million tokens, 2024.",
    );
  });
});

describe("restoreReferenceTitleCasing", () => {
  it("restores common model and acronym casing without forcing generic title case", () => {
    expect(
      restoreReferenceTitleCasing(
        "Longrope: Extending llm context window beyond 2 million tokens",
      ),
    ).toBe("LongRoPE: Extending LLM context window beyond 2 million tokens");

    expect(
      restoreReferenceTitleCasing(
        "Qwen-vl: A versatile vision-language model for understanding, localization, text reading, and beyond",
      ),
    ).toBe(
      "Qwen-VL: A versatile vision-language model for understanding, localization, text reading, and beyond",
    );
  });

  it("capitalizes sentence starts after punctuation when the stored title is degraded", () => {
    expect(
      restoreReferenceTitleCasing(
        "What disease does this patient have? a large-scale open domain question answering dataset from medical exams",
      ),
    ).toBe(
      "What disease does this patient have? A large-scale open domain question answering dataset from medical exams",
    );
  });
});
