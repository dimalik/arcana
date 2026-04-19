import { describe, expect, it } from "vitest";
import { isSafeAutoCollapseLoser, type SafeAutoCollapseLoserInput } from "./duplicate-review";

function buildSafeLoser(overrides: Partial<SafeAutoCollapseLoserInput> = {}): SafeAutoCollapseLoserInput {
  return {
    chatMessageCount: 0,
    conversationCount: 0,
    conversationPaperCount: 0,
    notebookEntryCount: 0,
    synthesisPaperCount: 0,
    isLiked: false,
    paperTagCount: 0,
    agentSessionCount: 0,
    engagementCount: 0,
    discoverySeedCount: 0,
    discoveryImportCount: 0,
    userManualRelationCount: 0,
    promptResultCount: 0,
    insightCount: 0,
    extractedReferenceCount: 0,
    incomingReferenceCount: 0,
    citationMentionCount: 0,
    figureCount: 0,
    figureCandidateCount: 0,
    figureIdentityCount: 0,
    figureOverrideCount: 0,
    claimEvidenceCount: 0,
    derivedAssertionCount: 0,
    recreatableReferenceMatchAssertionCount: 0,
    ...overrides,
  };
}

describe("isSafeAutoCollapseLoser", () => {
  it("accepts a near-empty loser", () => {
    expect(isSafeAutoCollapseLoser(buildSafeLoser())).toBe(true);
  });

  const disqualifiers: Array<[keyof SafeAutoCollapseLoserInput, number | boolean]> = [
    ["chatMessageCount", 1],
    ["conversationCount", 1],
    ["conversationPaperCount", 1],
    ["notebookEntryCount", 1],
    ["synthesisPaperCount", 1],
    ["isLiked", true],
    ["paperTagCount", 1],
    ["agentSessionCount", 1],
    ["engagementCount", 1],
    ["discoverySeedCount", 1],
    ["discoveryImportCount", 1],
    ["userManualRelationCount", 1],
    ["promptResultCount", 1],
    ["insightCount", 1],
    ["extractedReferenceCount", 1],
    ["incomingReferenceCount", 1],
    ["citationMentionCount", 1],
    ["figureCount", 1],
    ["figureCandidateCount", 1],
    ["figureIdentityCount", 1],
    ["figureOverrideCount", 1],
    ["claimEvidenceCount", 1],
  ];

  for (const [field, value] of disqualifiers) {
    it(`rejects losers with ${field}`, () => {
      expect(isSafeAutoCollapseLoser(buildSafeLoser({ [field]: value }))).toBe(false);
    });
  }

  it("rejects non-recreatable derived assertions", () => {
    expect(
      isSafeAutoCollapseLoser(
        buildSafeLoser({
          derivedAssertionCount: 1,
          recreatableReferenceMatchAssertionCount: 0,
        }),
      ),
    ).toBe(false);
  });

  it("accepts fully recreatable reference-match assertions", () => {
    expect(
      isSafeAutoCollapseLoser(
        buildSafeLoser({
          derivedAssertionCount: 2,
          recreatableReferenceMatchAssertionCount: 2,
        }),
      ),
    ).toBe(true);
  });
});
