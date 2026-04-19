import { describe, expect, it } from "vitest";

import {
  candidateAuthorsPassTrustCheck,
  cleanReferenceText,
  looksLikePollutedAuthors,
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
