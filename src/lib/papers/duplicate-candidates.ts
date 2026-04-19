import {
  PaperDuplicateAction,
  PaperDuplicateClass,
  PaperDuplicateReviewStatus,
  PaperDuplicateState,
} from "../../generated/prisma/enums";
import { prisma } from "@/lib/prisma";
import { normalizeIdentifier } from "../canonical/normalize";
import { normalizeTitle } from "../references/match";
import { countUserAuthoredRelationRowsForPaper } from "../assertions/relation-reader";
import {
  type SafeAutoCollapseLoserInput,
  isSafeAutoCollapseLoser,
  isUserManualRelationProvenance,
} from "./duplicate-review";

type DuplicateScanPaper = {
  id: string;
  title: string;
  authors: string | null;
  year: number | null;
  doi: string | null;
  arxivId: string | null;
  filePath: string | null;
  summary: string | null;
  keyFindings: string | null;
  processingStatus: string;
  isLiked: boolean;
  engagementScore: number;
  entityId: string | null;
  createdAt: Date;
};

type DuplicateCandidateEvidence = {
  reasons: string[];
  normalizedDoi?: string | null;
  normalizedArxivId?: string | null;
  normalizedTitle?: string | null;
  authorOverlap?: number;
  yearDelta?: number | null;
  winnerScore: number;
  loserScore: number;
  safeAutoCollapse: boolean;
  loserSignals?: SafeAutoCollapseLoserInput | null;
};

type DuplicateCandidateDraft = {
  userId: string;
  winnerPaperId: string;
  loserPaperId: string;
  duplicateClass: PaperDuplicateClass;
  score: number;
  evidence: DuplicateCandidateEvidence;
  reviewStatus: PaperDuplicateReviewStatus;
  chosenAction: PaperDuplicateAction | null;
  autoSafeCollapse: boolean;
  canonicalEntityCollision: boolean;
};

export interface PaperDuplicateScanSummary {
  scannedPaperCount: number;
  exactDuplicateCount: number;
  fuzzyDuplicateCount: number;
  safeAutoCollapseCount: number;
  reviewRequiredCount: number;
  canonicalEntityCollisionCount: number;
  persistedCandidateCount: number;
}

const DUPLICATE_SCAN_SELECT = {
  id: true,
  title: true,
  authors: true,
  year: true,
  doi: true,
  arxivId: true,
  filePath: true,
  summary: true,
  keyFindings: true,
  processingStatus: true,
  isLiked: true,
  engagementScore: true,
  entityId: true,
  createdAt: true,
} as const;

function parseAuthors(authors: string | null): string[] {
  if (!authors) return [];
  try {
    const parsed = JSON.parse(authors);
    if (Array.isArray(parsed)) {
      return parsed
        .map((value) => String(value).trim().toLowerCase())
        .filter(Boolean);
    }
  } catch {
    return authors
      .split(",")
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
  }
  return [];
}

function authorOverlapRatio(left: DuplicateScanPaper, right: DuplicateScanPaper): number {
  const leftAuthors = parseAuthors(left.authors);
  const rightAuthors = new Set(parseAuthors(right.authors));
  if (leftAuthors.length === 0 || rightAuthors.size === 0) return 0;

  const overlap = leftAuthors.filter((author) => rightAuthors.has(author)).length;
  return overlap / Math.max(leftAuthors.length, rightAuthors.size);
}

function normalizeDoi(doi: string | null): string | null {
  return doi ? normalizeIdentifier("doi", doi) : null;
}

function normalizeArxivId(arxivId: string | null): string | null {
  return arxivId ? normalizeIdentifier("arxiv", arxivId) : null;
}

function scorePaperForDuplicateWinning(paper: DuplicateScanPaper): number {
  return (
    (paper.filePath ? 6 : 0) +
    (paper.summary ? 4 : 0) +
    (paper.keyFindings ? 3 : 0) +
    (paper.processingStatus === "COMPLETED" ? 2 : 0) +
    (paper.entityId ? 2 : 0) +
    (paper.isLiked ? 2 : 0) +
    (paper.doi ? 1 : 0) +
    (paper.arxivId ? 1 : 0) +
    Math.min(Math.max(paper.engagementScore, 0), 10)
  );
}

function pickWinner(left: DuplicateScanPaper, right: DuplicateScanPaper): {
  winner: DuplicateScanPaper;
  loser: DuplicateScanPaper;
  winnerScore: number;
  loserScore: number;
} {
  const leftScore = scorePaperForDuplicateWinning(left);
  const rightScore = scorePaperForDuplicateWinning(right);

  if (leftScore !== rightScore) {
    return leftScore > rightScore
      ? { winner: left, loser: right, winnerScore: leftScore, loserScore: rightScore }
      : { winner: right, loser: left, winnerScore: rightScore, loserScore: leftScore };
  }

  if (left.createdAt.getTime() !== right.createdAt.getTime()) {
    return left.createdAt <= right.createdAt
      ? { winner: left, loser: right, winnerScore: leftScore, loserScore: rightScore }
      : { winner: right, loser: left, winnerScore: rightScore, loserScore: leftScore };
  }

  return left.id < right.id
    ? { winner: left, loser: right, winnerScore: leftScore, loserScore: rightScore }
    : { winner: right, loser: left, winnerScore: rightScore, loserScore: leftScore };
}

async function inspectSafeAutoCollapseLoser(
  loser: DuplicateScanPaper,
  winner: DuplicateScanPaper,
): Promise<SafeAutoCollapseLoserInput> {
  const [paperCounts, userManualRelationCount, referenceCount, referenceEntryCount, derivedAssertionCount, recreatableReferenceMatchAssertionCount] =
    await Promise.all([
      prisma.paper.findUniqueOrThrow({
        where: { id: loser.id },
        select: {
          _count: {
            select: {
              chatMessages: true,
              conversations: true,
              conversationPapers: true,
              notebookEntries: true,
              synthesisPapers: true,
              tags: true,
              agentSessions: true,
              engagements: true,
              discoverySeeds: true,
              discoveryImports: true,
              promptResults: true,
              insights: true,
              matchedBy: true,
              citationMentions: true,
              figures: true,
              figureCandidates: true,
              figureIdentities: true,
              figureOverrides: true,
              claimEvidence: true,
            },
          },
        },
      }),
      countUserAuthoredRelationRowsForPaper(loser.id),
      prisma.reference.count({
        where: {
          paperId: loser.id,
          OR: [
            { title: { not: "" } },
            { matchedPaperId: { not: null } },
          ],
        },
      }),
      prisma.referenceEntry.count({
        where: {
          paperId: loser.id,
          OR: [
            { title: { not: "" } },
            { resolvedEntityId: { not: null } },
          ],
        },
      }),
      prisma.relationAssertion.count({
        where: { sourcePaperId: loser.id },
      }),
      winner.entityId && loser.entityId && winner.entityId === loser.entityId
        ? prisma.relationAssertion.count({
            where: {
              sourcePaperId: loser.id,
              provenance: "reference_match",
            },
          })
        : Promise.resolve(0),
    ]);

  return {
    chatMessageCount: paperCounts._count.chatMessages,
    conversationCount: paperCounts._count.conversations,
    conversationPaperCount: paperCounts._count.conversationPapers,
    notebookEntryCount: paperCounts._count.notebookEntries,
    synthesisPaperCount: paperCounts._count.synthesisPapers,
    isLiked: loser.isLiked,
    paperTagCount: paperCounts._count.tags,
    agentSessionCount: paperCounts._count.agentSessions,
    engagementCount: paperCounts._count.engagements,
    discoverySeedCount: paperCounts._count.discoverySeeds,
    discoveryImportCount: paperCounts._count.discoveryImports,
    userManualRelationCount,
    promptResultCount: paperCounts._count.promptResults,
    insightCount: paperCounts._count.insights,
    extractedReferenceCount: referenceCount + referenceEntryCount,
    incomingReferenceCount: paperCounts._count.matchedBy,
    citationMentionCount: paperCounts._count.citationMentions,
    figureCount: paperCounts._count.figures,
    figureCandidateCount: paperCounts._count.figureCandidates,
    figureIdentityCount: paperCounts._count.figureIdentities,
    figureOverrideCount: paperCounts._count.figureOverrides,
    claimEvidenceCount: paperCounts._count.claimEvidence,
    derivedAssertionCount,
    recreatableReferenceMatchAssertionCount,
  };
}

function makeDraftKey(winnerPaperId: string, loserPaperId: string): string {
  return `${winnerPaperId}::${loserPaperId}`;
}

function buildDraft(
  userId: string,
  winner: DuplicateScanPaper,
  loser: DuplicateScanPaper,
  duplicateClass: PaperDuplicateClass,
  score: number,
  evidence: DuplicateCandidateEvidence,
): DuplicateCandidateDraft {
  const autoSafeCollapse = duplicateClass === PaperDuplicateClass.EXACT_IDENTIFIER && evidence.safeAutoCollapse;

  return {
    userId,
    winnerPaperId: winner.id,
    loserPaperId: loser.id,
    duplicateClass,
    score,
    evidence,
    reviewStatus: autoSafeCollapse ? PaperDuplicateReviewStatus.ACCEPTED : PaperDuplicateReviewStatus.PENDING,
    chosenAction:
      autoSafeCollapse ? PaperDuplicateAction.COLLAPSE
      : duplicateClass === PaperDuplicateClass.EXACT_IDENTIFIER ? PaperDuplicateAction.COLLAPSE
      : PaperDuplicateAction.HIDE,
    autoSafeCollapse,
    canonicalEntityCollision: false,
  };
}

function mergeDraftReason(
  existing: DuplicateCandidateDraft | undefined,
  next: DuplicateCandidateDraft,
): DuplicateCandidateDraft {
  if (!existing) return next;

  const mergedReasons = Array.from(new Set([...existing.evidence.reasons, ...next.evidence.reasons]));

  return {
    ...existing,
    duplicateClass:
      existing.duplicateClass === PaperDuplicateClass.EXACT_IDENTIFIER
        || next.duplicateClass === PaperDuplicateClass.EXACT_IDENTIFIER
        ? PaperDuplicateClass.EXACT_IDENTIFIER
        : PaperDuplicateClass.FUZZY,
    score: Math.max(existing.score, next.score),
    evidence: {
      ...existing.evidence,
      ...next.evidence,
      reasons: mergedReasons,
      safeAutoCollapse: existing.evidence.safeAutoCollapse || next.evidence.safeAutoCollapse,
      loserSignals: next.evidence.loserSignals ?? existing.evidence.loserSignals,
    },
    reviewStatus:
      existing.reviewStatus === PaperDuplicateReviewStatus.ACCEPTED
      || next.reviewStatus === PaperDuplicateReviewStatus.ACCEPTED
        ? PaperDuplicateReviewStatus.ACCEPTED
        : existing.reviewStatus,
    chosenAction:
      existing.chosenAction === PaperDuplicateAction.COLLAPSE
      || next.chosenAction === PaperDuplicateAction.COLLAPSE
        ? PaperDuplicateAction.COLLAPSE
        : existing.chosenAction ?? next.chosenAction,
    autoSafeCollapse: existing.autoSafeCollapse || next.autoSafeCollapse,
  };
}

export async function scanPaperDuplicateCandidates(
  userId: string,
): Promise<PaperDuplicateScanSummary> {
  const papers = await prisma.paper.findMany({
    where: {
      userId,
      duplicateState: PaperDuplicateState.ACTIVE,
    },
    select: DUPLICATE_SCAN_SELECT,
    orderBy: { createdAt: "asc" },
  });

  const entityCollisionGroups = new Map<string, string[]>();
  for (const paper of papers) {
    if (!paper.entityId) continue;
    const ids = entityCollisionGroups.get(paper.entityId) ?? [];
    ids.push(paper.id);
    entityCollisionGroups.set(paper.entityId, ids);
  }
  const canonicalEntityCollisionCount = Array.from(entityCollisionGroups.values()).filter(
    (ids) => ids.length > 1,
  ).length;

  const draftByPair = new Map<string, DuplicateCandidateDraft>();
  let exactDuplicateCount = 0;
  let fuzzyDuplicateCount = 0;
  let safeAutoCollapseCount = 0;
  let reviewRequiredCount = 0;

  const exactGroups = new Map<string, DuplicateScanPaper[]>();
  for (const paper of papers) {
    const normalizedDoi = normalizeDoi(paper.doi);
    if (normalizedDoi) {
      exactGroups.set(`doi:${normalizedDoi}`, [...(exactGroups.get(`doi:${normalizedDoi}`) ?? []), paper]);
    }
    const normalizedArxivId = normalizeArxivId(paper.arxivId);
    if (normalizedArxivId) {
      exactGroups.set(
        `arxiv:${normalizedArxivId}`,
        [...(exactGroups.get(`arxiv:${normalizedArxivId}`) ?? []), paper],
      );
    }
  }

  for (const [groupKey, group] of Array.from(exactGroups.entries())) {
    if (group.length < 2) continue;
    const [kind, normalizedValue] = groupKey.split(":");
    const winner = group.reduce<DuplicateScanPaper>(
      (best, current) => pickWinner(best, current).winner,
      group[0],
    );
    for (const paper of group) {
      if (paper.id === winner.id) continue;
      const picked = pickWinner(winner, paper);
      const loserSignals = await inspectSafeAutoCollapseLoser(picked.loser, picked.winner);
      const safeAutoCollapse = isSafeAutoCollapseLoser(loserSignals);
      const draft = buildDraft(
        userId,
        picked.winner,
        picked.loser,
        PaperDuplicateClass.EXACT_IDENTIFIER,
        1,
        {
          reasons: [kind === "doi" ? "exact_doi" : "exact_arxiv"],
          normalizedDoi: kind === "doi" ? normalizedValue : null,
          normalizedArxivId: kind === "arxiv" ? normalizedValue : null,
          winnerScore: picked.winnerScore,
          loserScore: picked.loserScore,
          safeAutoCollapse,
          loserSignals,
        },
      );
      const key = makeDraftKey(draft.winnerPaperId, draft.loserPaperId);
      if (!draftByPair.has(key)) {
        exactDuplicateCount += 1;
        if (safeAutoCollapse) safeAutoCollapseCount += 1;
        else reviewRequiredCount += 1;
      }
      draftByPair.set(key, mergeDraftReason(draftByPair.get(key), draft));
    }
  }

  const titleGroups = new Map<string, DuplicateScanPaper[]>();
  for (const paper of papers) {
    const normalized = normalizeTitle(paper.title);
    if (!normalized || normalized.length < 20) continue;
    titleGroups.set(normalized, [...(titleGroups.get(normalized) ?? []), paper]);
  }

  for (const [normalizedTitle, group] of Array.from(titleGroups.entries())) {
    if (group.length < 2) continue;
    for (let index = 0; index < group.length; index += 1) {
      for (let inner = index + 1; inner < group.length; inner += 1) {
        const left = group[index];
        const right = group[inner];

        const sameExactId =
          (normalizeDoi(left.doi) && normalizeDoi(left.doi) === normalizeDoi(right.doi))
          || (normalizeArxivId(left.arxivId) && normalizeArxivId(left.arxivId) === normalizeArxivId(right.arxivId));
        if (sameExactId) continue;

        const overlap = authorOverlapRatio(left, right);
        if (overlap <= 0) continue;

        const yearDelta =
          left.year != null && right.year != null ? Math.abs(left.year - right.year) : null;
        if (yearDelta != null && yearDelta > 1) continue;

        const picked = pickWinner(left, right);
        const draft = buildDraft(
          userId,
          picked.winner,
          picked.loser,
          PaperDuplicateClass.FUZZY,
          0.9 + Math.min(overlap, 0.1),
          {
            reasons: ["title_author_match"],
            normalizedTitle,
            authorOverlap: overlap,
            yearDelta,
            winnerScore: picked.winnerScore,
            loserScore: picked.loserScore,
            safeAutoCollapse: false,
            loserSignals: null,
          },
        );

        const key = makeDraftKey(draft.winnerPaperId, draft.loserPaperId);
        if (!draftByPair.has(key)) {
          fuzzyDuplicateCount += 1;
          reviewRequiredCount += 1;
        }
        draftByPair.set(key, mergeDraftReason(draftByPair.get(key), draft));
      }
    }
  }

  const drafts = Array.from(draftByPair.values());
  await prisma.$transaction(async (tx) => {
    await tx.paperDuplicateCandidate.deleteMany({ where: { userId } });
    if (drafts.length === 0) return;
    await tx.paperDuplicateCandidate.createMany({
      data: drafts.map((draft) => ({
        userId: draft.userId,
        winnerPaperId: draft.winnerPaperId,
        loserPaperId: draft.loserPaperId,
        duplicateClass: draft.duplicateClass,
        score: draft.score,
        evidenceJson: JSON.stringify(draft.evidence),
        reviewStatus: draft.reviewStatus,
        chosenAction: draft.chosenAction,
        autoSafeCollapse: draft.autoSafeCollapse,
        canonicalEntityCollision: draft.canonicalEntityCollision,
      })),
    });
  });

  return {
    scannedPaperCount: papers.length,
    exactDuplicateCount,
    fuzzyDuplicateCount,
    safeAutoCollapseCount,
    reviewRequiredCount,
    canonicalEntityCollisionCount,
    persistedCandidateCount: drafts.length,
  };
}

export async function listPaperDuplicateCandidates(userId: string) {
  const candidates = await prisma.paperDuplicateCandidate.findMany({
    where: { userId },
    orderBy: [
      { autoSafeCollapse: "desc" },
      { duplicateClass: "asc" },
      { score: "desc" },
      { createdAt: "asc" },
    ],
    include: {
      winnerPaper: {
        select: {
          id: true,
          title: true,
          authors: true,
          year: true,
          venue: true,
          doi: true,
          arxivId: true,
          duplicateState: true,
        },
      },
      loserPaper: {
        select: {
          id: true,
          title: true,
          authors: true,
          year: true,
          venue: true,
          doi: true,
          arxivId: true,
          duplicateState: true,
          collapsedIntoPaperId: true,
        },
      },
    },
  });

  return candidates.map((candidate) => ({
    ...candidate,
    evidence: JSON.parse(candidate.evidenceJson) as DuplicateCandidateEvidence,
  }));
}

export async function reviewPaperDuplicateCandidate(input: {
  userId: string;
  candidateId: string;
  reviewStatus: "ACCEPTED" | "DISMISSED";
  chosenAction?: PaperDuplicateAction | null;
  winnerPaperId?: string;
}) {
  const candidate = await prisma.paperDuplicateCandidate.findFirst({
    where: { id: input.candidateId, userId: input.userId },
  });
  if (!candidate) return null;

  const nextWinnerPaperId = input.winnerPaperId ?? candidate.winnerPaperId;
  const nextLoserPaperId =
    nextWinnerPaperId === candidate.winnerPaperId ? candidate.loserPaperId : candidate.winnerPaperId;

  return prisma.paperDuplicateCandidate.update({
    where: { id: input.candidateId },
    data: {
      winnerPaperId: nextWinnerPaperId,
      loserPaperId: nextLoserPaperId,
      reviewStatus: input.reviewStatus,
      chosenAction: input.reviewStatus === "ACCEPTED"
        ? (input.chosenAction ?? candidate.chosenAction)
        : null,
      reviewedAt: new Date(),
    },
  });
}

export async function applyAcceptedPaperDuplicateCandidates(userId: string) {
  const candidates = await prisma.paperDuplicateCandidate.findMany({
    where: {
      userId,
      reviewStatus: PaperDuplicateReviewStatus.ACCEPTED,
      chosenAction: { not: null },
      appliedAt: null,
    },
    orderBy: { createdAt: "asc" },
  });

  let applied = 0;
  for (const candidate of candidates) {
    await prisma.$transaction(async (tx) => {
      if (candidate.chosenAction === PaperDuplicateAction.COLLAPSE) {
        await tx.paper.update({
          where: { id: candidate.loserPaperId },
          data: {
            duplicateState: PaperDuplicateState.COLLAPSED,
            collapsedIntoPaperId: candidate.winnerPaperId,
          },
        });
      } else {
        await tx.paper.update({
          where: { id: candidate.loserPaperId },
          data: {
            duplicateState:
              candidate.chosenAction === PaperDuplicateAction.ARCHIVE
                ? PaperDuplicateState.ARCHIVED
                : PaperDuplicateState.HIDDEN,
            collapsedIntoPaperId: null,
          },
        });
      }

      await tx.paperDuplicateCandidate.update({
        where: { id: candidate.id },
        data: {
          reviewStatus: PaperDuplicateReviewStatus.APPLIED,
          appliedAt: new Date(),
        },
      });
    });
    applied += 1;
  }

  return { applied };
}

export async function restorePaperDuplicateState(userId: string, paperId: string) {
  return prisma.paper.updateMany({
    where: { id: paperId, userId },
    data: {
      duplicateState: PaperDuplicateState.ACTIVE,
      collapsedIntoPaperId: null,
    },
  });
}

export async function getPaperDuplicateDashboard(userId: string) {
  const [candidates, visiblePapers, hiddenPapers, archivedPapers, collapsedPapers] = await Promise.all([
    prisma.paperDuplicateCandidate.groupBy({
      by: ["reviewStatus"],
      where: { userId },
      _count: { _all: true },
    }),
    prisma.paper.count({ where: { userId, duplicateState: PaperDuplicateState.ACTIVE } }),
    prisma.paper.count({ where: { userId, duplicateState: PaperDuplicateState.HIDDEN } }),
    prisma.paper.count({ where: { userId, duplicateState: PaperDuplicateState.ARCHIVED } }),
    prisma.paper.count({ where: { userId, duplicateState: PaperDuplicateState.COLLAPSED } }),
  ]);

  return {
    reviewCounts: Object.fromEntries(
      candidates.map((candidate) => [candidate.reviewStatus, candidate._count._all]),
    ),
    paperCounts: {
      active: visiblePapers,
      hidden: hiddenPapers,
      archived: archivedPapers,
      collapsed: collapsedPapers,
    },
  };
}

export function filterUserManualAssertions<T extends { provenance: string | null | undefined }>(
  assertions: T[],
): T[] {
  return assertions.filter((assertion) => isUserManualRelationProvenance(assertion.provenance));
}
