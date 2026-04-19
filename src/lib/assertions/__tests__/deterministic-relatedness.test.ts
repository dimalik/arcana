import { describe, expect, it } from "vitest";

import {
  DETERMINISTIC_RELATEDNESS_LIMIT,
  computeDeterministicTitleSimilarity,
  parseDeterministicSignalPayload,
  rankDeterministicRelatednessCandidates,
  serializeDeterministicSignalPayload,
} from "../deterministic-relatedness";

describe("computeDeterministicTitleSimilarity", () => {
  it("ignores stopwords and case while scoring token overlap", () => {
    expect(
      computeDeterministicTitleSimilarity(
        "Video-MME: The First-Ever Benchmark",
        "video mme benchmark for multi-modal analysis",
      ),
    ).toBeGreaterThan(0.3);
  });

  it("returns zero when there is no meaningful overlap", () => {
    expect(
      computeDeterministicTitleSimilarity(
        "Diffusion policy optimization",
        "Protein folding with transformers",
      ),
    ).toBe(0);
  });
});

describe("deterministic signal payload helpers", () => {
  it("round-trips the persisted evidence payload", () => {
    const serialized = serializeDeterministicSignalPayload({
      rawValue: 2,
      weight: 0.2,
      contribution: 0.133333,
    });

    expect(parseDeterministicSignalPayload(serialized)).toEqual({
      rawValue: 2,
      weight: 0.2,
      contribution: 0.133333,
    });
  });

  it("fails closed on malformed evidence JSON", () => {
    expect(parseDeterministicSignalPayload("{not json")).toBeNull();
    expect(parseDeterministicSignalPayload(null)).toBeNull();
  });
});

describe("rankDeterministicRelatednessCandidates", () => {
  it("emits direct-citation peers even when they have no additional signals", () => {
    const ranked = rankDeterministicRelatednessCandidates("Paper A", [
      {
        peerPaperId: "paper-2",
        peerEntityId: "entity-2",
        peerTitle: "Completely different benchmark",
        directCitationReferenceEntryId: "ref-entry-1",
        reverseCitationReferenceEntryId: null,
        bibliographicCouplingCount: 0,
        coCitationCount: 0,
      },
    ]);

    expect(ranked).toHaveLength(1);
    expect(ranked[0]?.confidence).toBe(0.4);
    expect(ranked[0]?.description).toContain("direct citation");
  });

  it("rejects weak non-direct candidates below the threshold", () => {
    const ranked = rankDeterministicRelatednessCandidates("Paper A", [
      {
        peerPaperId: "paper-2",
        peerEntityId: "entity-2",
        peerTitle: "Different paper",
        directCitationReferenceEntryId: null,
        reverseCitationReferenceEntryId: null,
        bibliographicCouplingCount: 1,
        coCitationCount: 0,
      },
    ]);

    expect(ranked).toHaveLength(0);
  });

  it("orders candidates by total contribution and keeps the top cap", () => {
    const ranked = rankDeterministicRelatednessCandidates(
      "Scaling Language Models With Retrieval",
      Array.from({ length: DETERMINISTIC_RELATEDNESS_LIMIT + 5 }, (_, index) => ({
        peerPaperId: `paper-${index + 1}`,
        peerEntityId: `entity-${index + 1}`,
        peerTitle: `Scaling retrieval systems ${index + 1}`,
        directCitationReferenceEntryId: `ref-entry-${index + 1}`,
        reverseCitationReferenceEntryId: index <= 1 ? `reverse-${index}` : null,
        bibliographicCouplingCount: Math.max(0, 3 - (index % 4)),
        coCitationCount: index % 3,
      })),
    );

    expect(ranked).toHaveLength(DETERMINISTIC_RELATEDNESS_LIMIT);
    expect(ranked[0]?.peerPaperId).toBe("paper-1");
    expect(ranked[0]?.confidence).toBeGreaterThanOrEqual(
      ranked[1]?.confidence ?? 0,
    );
  });

  it("keeps the evidence sum aligned with the stored confidence", () => {
    const [ranked] = rankDeterministicRelatednessCandidates("Paper A", [
      {
        peerPaperId: "paper-2",
        peerEntityId: "entity-2",
        peerTitle: "Paper A with shared references",
        directCitationReferenceEntryId: "ref-entry-1",
        reverseCitationReferenceEntryId: "ref-entry-2",
        bibliographicCouplingCount: 2,
        coCitationCount: 1,
      },
    ]);

    expect(ranked).toBeDefined();
    const contributionSum = ranked!.evidence.reduce((sum, evidence) => {
      const payload = parseDeterministicSignalPayload(evidence.excerpt);
      return sum + (payload?.contribution ?? 0);
    }, 0);

    expect(Math.abs(contributionSum - ranked!.confidence)).toBeLessThanOrEqual(
      0.001,
    );
  });
});
