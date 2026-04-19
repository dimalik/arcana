import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  prisma: {
    paper: {
      findMany: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    paperRelation: {
      count: vi.fn(),
    },
    relationAssertion: {
      count: vi.fn(),
    },
    reference: {
      count: vi.fn(),
    },
    referenceEntry: {
      count: vi.fn(),
    },
    paperDuplicateCandidate: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      groupBy: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: hoisted.prisma,
}));

import {
  applyAcceptedPaperDuplicateCandidates,
  reviewPaperDuplicateCandidate,
  scanPaperDuplicateCandidates,
} from "./duplicate-candidates";

describe("duplicate candidates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.prisma.$transaction.mockImplementation(async (callback: (tx: typeof hoisted.prisma) => unknown) => callback({
      paper: hoisted.prisma.paper,
      paperDuplicateCandidate: hoisted.prisma.paperDuplicateCandidate,
    } as typeof hoisted.prisma));
    hoisted.prisma.paperRelation.count.mockResolvedValue(0);
    hoisted.prisma.relationAssertion.count.mockResolvedValue(0);
    hoisted.prisma.reference.count.mockResolvedValue(0);
    hoisted.prisma.referenceEntry.count.mockResolvedValue(0);
  });

  it("auto-accepts safe exact identifier duplicates for collapse", async () => {
    hoisted.prisma.paper.findMany.mockResolvedValue([
      {
        id: "paper-winner",
        title: "Deterministic Relatedness For Papers",
        authors: JSON.stringify(["Alice Smith", "Bob Jones"]),
        year: 2024,
        doi: "10.1000/test",
        arxivId: null,
        filePath: "uploads/winner.pdf",
        summary: "Summary",
        keyFindings: "Findings",
        processingStatus: "COMPLETED",
        isLiked: true,
        engagementScore: 5,
        entityId: null,
        createdAt: new Date("2026-04-18T12:00:00.000Z"),
      },
      {
        id: "paper-loser",
        title: "Deterministic Relatedness For Papers",
        authors: JSON.stringify(["Alice Smith", "Bob Jones"]),
        year: 2024,
        doi: "10.1000/test",
        arxivId: null,
        filePath: null,
        summary: null,
        keyFindings: null,
        processingStatus: "PENDING",
        isLiked: false,
        engagementScore: 0,
        entityId: null,
        createdAt: new Date("2026-04-19T12:00:00.000Z"),
      },
    ]);
    hoisted.prisma.paper.findUniqueOrThrow.mockResolvedValue({
      _count: {
        chatMessages: 0,
        conversations: 0,
        conversationPapers: 0,
        notebookEntries: 0,
        synthesisPapers: 0,
        tags: 0,
        agentSessions: 0,
        engagements: 0,
        discoverySeeds: 0,
        discoveryImports: 0,
        promptResults: 0,
        insights: 0,
        matchedBy: 0,
        citationMentions: 0,
        figures: 0,
        figureCandidates: 0,
        figureIdentities: 0,
        figureOverrides: 0,
        claimEvidence: 0,
      },
    });

    const summary = await scanPaperDuplicateCandidates("user-1");

    expect(summary).toMatchObject({
      scannedPaperCount: 2,
      exactDuplicateCount: 1,
      fuzzyDuplicateCount: 0,
      safeAutoCollapseCount: 1,
      reviewRequiredCount: 0,
      persistedCandidateCount: 1,
    });
    expect(hoisted.prisma.paperDuplicateCandidate.deleteMany).toHaveBeenCalledWith({
      where: { userId: "user-1" },
    });
    expect(hoisted.prisma.paperDuplicateCandidate.createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          userId: "user-1",
          winnerPaperId: "paper-winner",
          loserPaperId: "paper-loser",
          duplicateClass: "EXACT_IDENTIFIER",
          reviewStatus: "ACCEPTED",
          chosenAction: "COLLAPSE",
          autoSafeCollapse: true,
        }),
      ],
    });
  });

  it("allows review to flip winner and loser", async () => {
    hoisted.prisma.paperDuplicateCandidate.findFirst.mockResolvedValue({
      id: "candidate-1",
      userId: "user-1",
      winnerPaperId: "winner-a",
      loserPaperId: "loser-b",
      duplicateClass: "FUZZY",
      score: 0.94,
      evidenceJson: "{}",
      reviewStatus: "PENDING",
      chosenAction: "HIDE",
      autoSafeCollapse: false,
      canonicalEntityCollision: false,
    });
    hoisted.prisma.paperDuplicateCandidate.update.mockResolvedValue({
      id: "candidate-1",
      winnerPaperId: "loser-b",
      loserPaperId: "winner-a",
      reviewStatus: "ACCEPTED",
      chosenAction: "ARCHIVE",
    });

    await reviewPaperDuplicateCandidate({
      userId: "user-1",
      candidateId: "candidate-1",
      reviewStatus: "ACCEPTED",
      chosenAction: "ARCHIVE" as any,
      winnerPaperId: "loser-b",
    });

    expect(hoisted.prisma.paperDuplicateCandidate.update).toHaveBeenCalledWith({
      where: { id: "candidate-1" },
      data: expect.objectContaining({
        winnerPaperId: "loser-b",
        loserPaperId: "winner-a",
        reviewStatus: "ACCEPTED",
        chosenAction: "ARCHIVE",
      }),
    });
  });

  it("applies accepted collapse candidates without reparenting data", async () => {
    hoisted.prisma.paperDuplicateCandidate.findMany.mockResolvedValue([
      {
        id: "candidate-1",
        userId: "user-1",
        winnerPaperId: "paper-winner",
        loserPaperId: "paper-loser",
        reviewStatus: "ACCEPTED",
        chosenAction: "COLLAPSE",
        appliedAt: null,
      },
    ]);

    const result = await applyAcceptedPaperDuplicateCandidates("user-1");

    expect(result).toEqual({ applied: 1 });
    expect(hoisted.prisma.paper.update).toHaveBeenCalledWith({
      where: { id: "paper-loser" },
      data: {
        duplicateState: "COLLAPSED",
        collapsedIntoPaperId: "paper-winner",
      },
    });
    expect(hoisted.prisma.paperDuplicateCandidate.update).toHaveBeenCalledWith({
      where: { id: "candidate-1" },
      data: {
        reviewStatus: "APPLIED",
        appliedAt: expect.any(Date),
      },
    });
  });
});
