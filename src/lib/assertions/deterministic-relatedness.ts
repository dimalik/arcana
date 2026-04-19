import { z } from "zod";

import { prisma } from "../prisma";
import { projectLegacyRelation } from "./legacy-projection";
import { upsertAssertionWithEvidence } from "./relation-assertion-service";

export const DETERMINISTIC_RELATEDNESS_PROVENANCE = "deterministic_relatedness";
export const DETERMINISTIC_RELATEDNESS_RELATION_TYPE = "related";
export const DETERMINISTIC_RELATEDNESS_EXTRACTOR_VERSION =
  "deterministic_relatedness_v1";
export const LEGACY_LLM_RELATION_PROVENANCE = "llm_semantic";
export const DETERMINISTIC_RELATEDNESS_THRESHOLD = 0.35;
export const DETERMINISTIC_RELATEDNESS_LIMIT = 20;

export const DETERMINISTIC_SIGNAL_WEIGHTS = {
  direct_citation: 0.4,
  reverse_citation: 0.2,
  bibliographic_coupling: 0.2,
  co_citation: 0.1,
  title_similarity: 0.1,
} as const;

const TITLE_STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "by",
  "for",
  "from",
  "in",
  "into",
  "of",
  "on",
  "the",
  "to",
  "using",
  "via",
  "with",
]);

const deterministicSignalPayloadSchema = z.object({
  rawValue: z.number(),
  weight: z.number(),
  contribution: z.number(),
});

export type DeterministicSignalName = keyof typeof DETERMINISTIC_SIGNAL_WEIGHTS;
export type DeterministicSignalPayload = z.infer<
  typeof deterministicSignalPayloadSchema
>;

export interface DeterministicEvidenceRow {
  type: `deterministic_signal:${DeterministicSignalName}`;
  excerpt: string;
  referenceEntryId: string | null;
}

export interface DeterministicSignalBreakdown {
  signal: DeterministicSignalName;
  rawValue: number;
  weight: number;
  contribution: number;
  referenceEntryId: string | null;
}

export interface DeterministicCandidateInput {
  peerPaperId: string;
  peerEntityId: string;
  peerTitle: string;
  directCitationReferenceEntryId: string | null;
  reverseCitationReferenceEntryId: string | null;
  bibliographicCouplingCount: number;
  coCitationCount: number;
}

export interface DeterministicRankedRelation {
  peerPaperId: string;
  peerEntityId: string;
  peerTitle: string;
  relationType: string;
  description: string;
  confidence: number;
  evidence: DeterministicEvidenceRow[];
}

export interface DeterministicRecomputeResult {
  paperId: string;
  status: "updated" | "skipped_no_user" | "skipped_no_entity";
  emittedCount: number;
  deletedLlmSemanticCount: number;
  deletedStaleDeterministicCount: number;
  affectedPeerCount: number;
  signalHistogram: Record<
    DeterministicSignalName,
    { count: number; totalContribution: number }
  >;
}

type DeterministicRootDb = Pick<
  typeof prisma,
  | "$transaction"
  | "paper"
  | "reference"
  | "referenceEntry"
  | "relationAssertion"
  | "relationEvidence"
>;

type DeterministicTxDb = Pick<
  typeof prisma,
  | "paper"
  | "reference"
  | "referenceEntry"
  | "relationAssertion"
  | "relationEvidence"
  | "paperRelation"
>;

interface SourcePaperForDeterministic {
  id: string;
  userId: string | null;
  entityId: string | null;
  title: string;
}

interface PeerPaperSummary {
  id: string;
  entityId: string;
  title: string;
}

interface CandidateAccumulator {
  peerPaperId: string;
  peerEntityId: string;
  peerTitle: string;
  directCitationReferenceEntryId: string | null;
  reverseCitationReferenceEntryId: string | null;
  bibliographicCouplingKeys: Set<string>;
  coCitationPaperIds: Set<string>;
}

function roundScore(value: number): number {
  return Number(value.toFixed(6));
}

function emptySignalHistogram(): DeterministicRecomputeResult["signalHistogram"] {
  return {
    direct_citation: { count: 0, totalContribution: 0 },
    reverse_citation: { count: 0, totalContribution: 0 },
    bibliographic_coupling: { count: 0, totalContribution: 0 },
    co_citation: { count: 0, totalContribution: 0 },
    title_similarity: { count: 0, totalContribution: 0 },
  };
}

function normalizeTitleTokens(title: string): string[] {
  return title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !TITLE_STOPWORDS.has(token));
}

export function computeDeterministicTitleSimilarity(
  sourceTitle: string,
  peerTitle: string,
): number {
  const sourceTokens = new Set(normalizeTitleTokens(sourceTitle));
  const peerTokens = new Set(normalizeTitleTokens(peerTitle));
  if (sourceTokens.size === 0 || peerTokens.size === 0) return 0;

  let overlap = 0;
  for (const token of Array.from(sourceTokens)) {
    if (peerTokens.has(token)) overlap += 1;
  }

  const unionSize = new Set([
    ...Array.from(sourceTokens),
    ...Array.from(peerTokens),
  ]).size;
  if (unionSize === 0) return 0;
  return roundScore(overlap / unionSize);
}

export function serializeDeterministicSignalPayload(
  payload: DeterministicSignalPayload,
): string {
  return JSON.stringify(payload);
}

export function parseDeterministicSignalPayload(
  text: string | null | undefined,
): DeterministicSignalPayload | null {
  if (!text) return null;

  try {
    const parsed = JSON.parse(text);
    const result = deterministicSignalPayloadSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function buildEvidenceRow(
  signal: DeterministicSignalName,
  rawValue: number,
  referenceEntryId: string | null,
): DeterministicSignalBreakdown | null {
  const weight = DETERMINISTIC_SIGNAL_WEIGHTS[signal];
  if (rawValue <= 0) return null;

  let contribution = 0;
  switch (signal) {
    case "direct_citation":
    case "reverse_citation":
      contribution = weight;
      break;
    case "bibliographic_coupling":
    case "co_citation":
      contribution = Math.min(rawValue / 3, 1) * weight;
      break;
    case "title_similarity":
      contribution = Math.min(Math.max(rawValue, 0), 1) * weight;
      break;
  }

  if (contribution <= 0) return null;

  return {
    signal,
    rawValue: roundScore(rawValue),
    weight,
    contribution: roundScore(contribution),
    referenceEntryId,
  };
}

function buildDeterministicDescription(
  evidenceRows: DeterministicSignalBreakdown[],
): string {
  const labels = evidenceRows.map((row) => {
    switch (row.signal) {
      case "direct_citation":
        return "a direct citation";
      case "reverse_citation":
        return "being cited by a related paper";
      case "bibliographic_coupling":
        return "shared references";
      case "co_citation":
        return "shared citing papers";
      case "title_similarity":
        return "title similarity";
    }
  });

  if (labels.length === 1) {
    return `Related via ${labels[0]}.`;
  }

  if (labels.length === 2) {
    return `Related via ${labels[0]} and ${labels[1]}.`;
  }

  return `Related via ${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}.`;
}

function rankSingleCandidate(
  sourceTitle: string,
  candidate: DeterministicCandidateInput,
): DeterministicRankedRelation | null {
  const evidenceRows = [
    buildEvidenceRow(
      "direct_citation",
      candidate.directCitationReferenceEntryId ? 1 : 0,
      candidate.directCitationReferenceEntryId,
    ),
    buildEvidenceRow(
      "reverse_citation",
      candidate.reverseCitationReferenceEntryId ? 1 : 0,
      candidate.reverseCitationReferenceEntryId,
    ),
    buildEvidenceRow(
      "bibliographic_coupling",
      candidate.bibliographicCouplingCount,
      null,
    ),
    buildEvidenceRow("co_citation", candidate.coCitationCount, null),
    buildEvidenceRow(
      "title_similarity",
      computeDeterministicTitleSimilarity(sourceTitle, candidate.peerTitle),
      null,
    ),
  ].filter((row): row is DeterministicSignalBreakdown => Boolean(row));

  if (evidenceRows.length === 0) return null;

  const confidence = roundScore(
    evidenceRows.reduce((sum, row) => sum + row.contribution, 0),
  );
  const hasDirectCitation = evidenceRows.some(
    (row) => row.signal === "direct_citation",
  );

  if (!hasDirectCitation && confidence < DETERMINISTIC_RELATEDNESS_THRESHOLD) {
    return null;
  }

  return {
    peerPaperId: candidate.peerPaperId,
    peerEntityId: candidate.peerEntityId,
    peerTitle: candidate.peerTitle,
    relationType: DETERMINISTIC_RELATEDNESS_RELATION_TYPE,
    description: buildDeterministicDescription(evidenceRows),
    confidence,
    evidence: evidenceRows.map((row) => ({
      type: `deterministic_signal:${row.signal}`,
      excerpt: serializeDeterministicSignalPayload({
        rawValue: row.rawValue,
        weight: row.weight,
        contribution: row.contribution,
      }),
      referenceEntryId: row.referenceEntryId,
    })),
  };
}

export function rankDeterministicRelatednessCandidates(
  sourceTitle: string,
  candidates: DeterministicCandidateInput[],
): DeterministicRankedRelation[] {
  return candidates
    .map((candidate) => rankSingleCandidate(sourceTitle, candidate))
    .filter((candidate): candidate is DeterministicRankedRelation => Boolean(candidate))
    .sort((left, right) => {
      if (right.confidence !== left.confidence) {
        return right.confidence - left.confidence;
      }
      return left.peerPaperId.localeCompare(right.peerPaperId);
    })
    .slice(0, DETERMINISTIC_RELATEDNESS_LIMIT);
}

function makeEntityKey(entityId: string): string {
  return `entity:${entityId}`;
}

function makePaperKey(paperId: string): string {
  return `paper:${paperId}`;
}

function mergeCandidatePeer(
  candidates: Map<string, CandidateAccumulator>,
  peerPaper: PeerPaperSummary,
): CandidateAccumulator {
  const existing = candidates.get(peerPaper.id);
  if (existing) return existing;

  const created: CandidateAccumulator = {
    peerPaperId: peerPaper.id,
    peerEntityId: peerPaper.entityId,
    peerTitle: peerPaper.title,
    directCitationReferenceEntryId: null,
    reverseCitationReferenceEntryId: null,
    bibliographicCouplingKeys: new Set<string>(),
    coCitationPaperIds: new Set<string>(),
  };
  candidates.set(peerPaper.id, created);
  return created;
}

async function loadSourcePaper(
  paperId: string,
  db: Pick<typeof prisma, "paper">,
): Promise<SourcePaperForDeterministic | null> {
  return db.paper.findUnique({
    where: { id: paperId },
    select: {
      id: true,
      userId: true,
      entityId: true,
      title: true,
    },
  });
}

async function loadPeerPapersByEntity(
  userId: string,
  entityIds: string[],
  excludePaperId: string,
  db: Pick<typeof prisma, "paper">,
): Promise<Map<string, PeerPaperSummary>> {
  if (entityIds.length === 0) return new Map();

  const peers = await db.paper.findMany({
    where: {
      userId,
      entityId: { in: entityIds },
      id: { not: excludePaperId },
    },
    select: {
      id: true,
      entityId: true,
      title: true,
    },
  });

  return new Map(
    peers
      .filter((peer): peer is PeerPaperSummary => Boolean(peer.entityId))
      .map((peer) => [peer.entityId, peer]),
  );
}

async function collectCandidateInputs(
  sourcePaper: SourcePaperForDeterministic & { userId: string; entityId: string },
  db: Pick<typeof prisma, "paper" | "reference" | "referenceEntry">,
): Promise<DeterministicCandidateInput[]> {
  const candidates = new Map<string, CandidateAccumulator>();

  const [sourceEntries, sourceLegacyReferences] = await Promise.all([
    db.referenceEntry.findMany({
      where: { paperId: sourcePaper.id },
      select: {
        id: true,
        resolvedEntityId: true,
        legacyReferenceId: true,
      },
    }),
    db.reference.findMany({
      where: {
        paperId: sourcePaper.id,
        matchedPaperId: { not: null },
      },
      select: {
        id: true,
        matchedPaperId: true,
        matchedPaper: {
          select: {
            id: true,
            userId: true,
            entityId: true,
            title: true,
          },
        },
      },
    }),
  ]);

  const sourceEntryByLegacyReferenceId = new Map<string, string>();
  const sourceResolvedEntityIds = new Set<string>();
  const sourceCitationKeys = new Set<string>();
  const sourceMatchedPaperIds = new Set<string>();

  for (const entry of sourceEntries) {
    if (entry.legacyReferenceId) {
      sourceEntryByLegacyReferenceId.set(entry.legacyReferenceId, entry.id);
    }
    if (entry.resolvedEntityId) {
      sourceResolvedEntityIds.add(entry.resolvedEntityId);
      sourceCitationKeys.add(makeEntityKey(entry.resolvedEntityId));
    }
  }

  const directPeersByEntity = await loadPeerPapersByEntity(
    sourcePaper.userId,
    Array.from(sourceResolvedEntityIds),
    sourcePaper.id,
    db,
  );

  for (const entry of sourceEntries) {
    if (!entry.resolvedEntityId) continue;
    const peerPaper = directPeersByEntity.get(entry.resolvedEntityId);
    if (!peerPaper) continue;
    const candidate = mergeCandidatePeer(candidates, peerPaper);
    candidate.directCitationReferenceEntryId ||= entry.id;
  }

  for (const legacyReference of sourceLegacyReferences) {
    const matchedPaper = legacyReference.matchedPaper;
    if (!matchedPaper || matchedPaper.userId !== sourcePaper.userId) continue;
    if (matchedPaper.id === sourcePaper.id) continue;
    sourceMatchedPaperIds.add(matchedPaper.id);

    if (matchedPaper.entityId) {
      sourceResolvedEntityIds.add(matchedPaper.entityId);
      sourceCitationKeys.add(makeEntityKey(matchedPaper.entityId));
      const candidate = mergeCandidatePeer(candidates, {
        id: matchedPaper.id,
        entityId: matchedPaper.entityId,
        title: matchedPaper.title,
      });
      candidate.directCitationReferenceEntryId ||=
        sourceEntryByLegacyReferenceId.get(legacyReference.id) ?? null;
    } else if (legacyReference.matchedPaperId) {
      sourceCitationKeys.add(makePaperKey(legacyReference.matchedPaperId));
    }
  }

  const [reverseEntries, reverseLegacyReferences] = await Promise.all([
    db.referenceEntry.findMany({
      where: {
        resolvedEntityId: sourcePaper.entityId,
        paper: {
          userId: sourcePaper.userId,
          id: { not: sourcePaper.id },
        },
      },
      select: {
        id: true,
        paperId: true,
        paper: {
          select: {
            id: true,
            entityId: true,
            title: true,
          },
        },
      },
    }),
    db.reference.findMany({
      where: {
        matchedPaperId: sourcePaper.id,
        paper: {
          userId: sourcePaper.userId,
          id: { not: sourcePaper.id },
        },
      },
      select: {
        id: true,
        paperId: true,
        paper: {
          select: {
            id: true,
            entityId: true,
            title: true,
          },
        },
      },
    }),
  ]);

  const reverseLegacyReferenceIds = reverseLegacyReferences.map((reference) => reference.id);
  const reverseEntryByLegacyReferenceId = new Map<string, string>();
  if (reverseLegacyReferenceIds.length > 0) {
    const reverseEntriesForLegacyRefs = await db.referenceEntry.findMany({
      where: {
        legacyReferenceId: { in: reverseLegacyReferenceIds },
      },
      select: {
        id: true,
        legacyReferenceId: true,
      },
    });

    for (const entry of reverseEntriesForLegacyRefs) {
      if (entry.legacyReferenceId) {
        reverseEntryByLegacyReferenceId.set(entry.legacyReferenceId, entry.id);
      }
    }
  }

  const sourceCiterPaperIds = new Set<string>();

  for (const entry of reverseEntries) {
    sourceCiterPaperIds.add(entry.paperId);
    if (!entry.paper.entityId) continue;

    const candidate = mergeCandidatePeer(candidates, {
      id: entry.paper.id,
      entityId: entry.paper.entityId,
      title: entry.paper.title,
    });
    candidate.reverseCitationReferenceEntryId ||= entry.id;
  }

  for (const legacyReference of reverseLegacyReferences) {
    sourceCiterPaperIds.add(legacyReference.paperId);
    if (!legacyReference.paper.entityId) continue;

    const candidate = mergeCandidatePeer(candidates, {
      id: legacyReference.paper.id,
      entityId: legacyReference.paper.entityId,
      title: legacyReference.paper.title,
    });
    candidate.reverseCitationReferenceEntryId ||=
      reverseEntryByLegacyReferenceId.get(legacyReference.id) ?? null;
  }

  const sourceResolvedKeys = Array.from(sourceResolvedEntityIds);
  const [couplingEntries, couplingLegacyReferences] = await Promise.all([
    sourceResolvedKeys.length > 0
      ? db.referenceEntry.findMany({
          where: {
            resolvedEntityId: { in: sourceResolvedKeys },
            paper: {
              userId: sourcePaper.userId,
              id: { not: sourcePaper.id },
            },
          },
          select: {
            paperId: true,
            resolvedEntityId: true,
            paper: {
              select: {
                id: true,
                entityId: true,
                title: true,
              },
            },
          },
        })
      : Promise.resolve([]),
    sourceMatchedPaperIds.size > 0
      ? db.reference.findMany({
          where: {
            matchedPaperId: { in: Array.from(sourceMatchedPaperIds) },
            paper: {
              userId: sourcePaper.userId,
              id: { not: sourcePaper.id },
            },
          },
          select: {
            paperId: true,
            matchedPaperId: true,
            paper: {
              select: {
                id: true,
                entityId: true,
                title: true,
              },
            },
            matchedPaper: {
              select: {
                entityId: true,
              },
            },
          },
        })
      : Promise.resolve([]),
  ]);

  for (const entry of couplingEntries) {
    if (!entry.paper.entityId || !entry.resolvedEntityId) continue;
    const candidate = mergeCandidatePeer(candidates, {
      id: entry.paper.id,
      entityId: entry.paper.entityId,
      title: entry.paper.title,
    });
    candidate.bibliographicCouplingKeys.add(makeEntityKey(entry.resolvedEntityId));
  }

  for (const legacyReference of couplingLegacyReferences) {
    if (!legacyReference.paper.entityId || !legacyReference.matchedPaperId) continue;

    const key = legacyReference.matchedPaper?.entityId
      ? makeEntityKey(legacyReference.matchedPaper.entityId)
      : makePaperKey(legacyReference.matchedPaperId);
    if (!sourceCitationKeys.has(key)) continue;

    const candidate = mergeCandidatePeer(candidates, {
      id: legacyReference.paper.id,
      entityId: legacyReference.paper.entityId,
      title: legacyReference.paper.title,
    });
    candidate.bibliographicCouplingKeys.add(key);
  }

  const citerPaperIds = Array.from(sourceCiterPaperIds);
  if (citerPaperIds.length > 0) {
    const [coCitationEntries, coCitationLegacyReferences] = await Promise.all([
      db.referenceEntry.findMany({
        where: {
          paperId: { in: citerPaperIds },
          resolvedEntityId: { not: null },
          NOT: { resolvedEntityId: sourcePaper.entityId },
        },
        select: {
          paperId: true,
          resolvedEntityId: true,
        },
      }),
      db.reference.findMany({
        where: {
          paperId: { in: citerPaperIds },
          matchedPaperId: { not: sourcePaper.id },
        },
        select: {
          paperId: true,
          matchedPaper: {
            select: {
              id: true,
              userId: true,
              entityId: true,
              title: true,
            },
          },
        },
      }),
    ]);

    const coCitationPeersByEntity = await loadPeerPapersByEntity(
      sourcePaper.userId,
      Array.from(
        new Set(
          coCitationEntries
            .map((entry) => entry.resolvedEntityId)
            .filter((entityId): entityId is string => Boolean(entityId)),
        ),
      ),
      sourcePaper.id,
      db,
    );

    for (const entry of coCitationEntries) {
      if (!entry.resolvedEntityId) continue;
      const peerPaper = coCitationPeersByEntity.get(entry.resolvedEntityId);
      if (!peerPaper) continue;
      const candidate = mergeCandidatePeer(candidates, peerPaper);
      candidate.coCitationPaperIds.add(entry.paperId);
    }

    for (const legacyReference of coCitationLegacyReferences) {
      const matchedPaper = legacyReference.matchedPaper;
      if (
        !matchedPaper ||
        matchedPaper.userId !== sourcePaper.userId ||
        !matchedPaper.entityId ||
        matchedPaper.id === sourcePaper.id
      ) {
        continue;
      }

      const candidate = mergeCandidatePeer(candidates, {
        id: matchedPaper.id,
        entityId: matchedPaper.entityId,
        title: matchedPaper.title,
      });
      candidate.coCitationPaperIds.add(legacyReference.paperId);
    }
  }

  return Array.from(candidates.values()).map((candidate) => ({
    peerPaperId: candidate.peerPaperId,
    peerEntityId: candidate.peerEntityId,
    peerTitle: candidate.peerTitle,
    directCitationReferenceEntryId: candidate.directCitationReferenceEntryId,
    reverseCitationReferenceEntryId: candidate.reverseCitationReferenceEntryId,
    bibliographicCouplingCount: candidate.bibliographicCouplingKeys.size,
    coCitationCount: candidate.coCitationPaperIds.size,
  }));
}

export async function recomputeDeterministicRelatednessForPaper(
  paperId: string,
  db: DeterministicRootDb = prisma,
): Promise<DeterministicRecomputeResult> {
  const sourcePaper = await loadSourcePaper(paperId, db);
  if (!sourcePaper?.userId) {
    return {
      paperId,
      status: "skipped_no_user",
      emittedCount: 0,
      deletedLlmSemanticCount: 0,
      deletedStaleDeterministicCount: 0,
      affectedPeerCount: 0,
      signalHistogram: emptySignalHistogram(),
    };
  }

  if (!sourcePaper.entityId) {
    return {
      paperId,
      status: "skipped_no_entity",
      emittedCount: 0,
      deletedLlmSemanticCount: 0,
      deletedStaleDeterministicCount: 0,
      affectedPeerCount: 0,
      signalHistogram: emptySignalHistogram(),
    };
  }

  const sourceUserId = sourcePaper.userId;
  const sourceEntityId = sourcePaper.entityId;

  const candidates = await collectCandidateInputs(
    {
      ...sourcePaper,
      userId: sourceUserId,
      entityId: sourceEntityId,
    },
    db,
  );
  const ranked = rankDeterministicRelatednessCandidates(sourcePaper.title, candidates);

  return db.$transaction(async (tx) => {
    const [existingDeterministic, existingLegacyLlm] = await Promise.all([
      tx.relationAssertion.findMany({
        where: {
          sourcePaperId: paperId,
          provenance: DETERMINISTIC_RELATEDNESS_PROVENANCE,
        },
        select: {
          id: true,
          targetEntityId: true,
          relationType: true,
        },
      }),
      tx.relationAssertion.findMany({
        where: {
          sourcePaperId: paperId,
          provenance: LEGACY_LLM_RELATION_PROVENANCE,
        },
        select: {
          id: true,
          targetEntityId: true,
        },
      }),
    ]);

    if (existingLegacyLlm.length > 0) {
      await tx.relationAssertion.deleteMany({
        where: { id: { in: existingLegacyLlm.map((assertion) => assertion.id) } },
      });
    }

    const nextTargetEntityIds = new Set(ranked.map((row) => row.peerEntityId));
    const staleDeterministicIds = existingDeterministic
      .filter(
        (assertion) =>
          assertion.relationType !== DETERMINISTIC_RELATEDNESS_RELATION_TYPE ||
          !nextTargetEntityIds.has(assertion.targetEntityId),
      )
      .map((assertion) => assertion.id);

    if (staleDeterministicIds.length > 0) {
      await tx.relationAssertion.deleteMany({
        where: { id: { in: staleDeterministicIds } },
      });
    }

    for (const relation of ranked) {
      await upsertAssertionWithEvidence(
        {
          sourceEntityId,
          targetEntityId: relation.peerEntityId,
          sourcePaperId: sourcePaper.id,
          relationType: relation.relationType,
          description: relation.description,
          confidence: relation.confidence,
          provenance: DETERMINISTIC_RELATEDNESS_PROVENANCE,
          extractorVersion: DETERMINISTIC_RELATEDNESS_EXTRACTOR_VERSION,
        },
        relation.evidence,
        tx,
      );
    }

    const affectedEntityIds = new Set<string>([
      ...existingDeterministic.map((assertion) => assertion.targetEntityId),
      ...existingLegacyLlm.map((assertion) => assertion.targetEntityId),
      ...ranked.map((relation) => relation.peerEntityId),
    ]);

    const affectedPeers = affectedEntityIds.size
        ? await tx.paper.findMany({
            where: {
            userId: sourceUserId,
            entityId: { in: Array.from(affectedEntityIds) },
            id: { not: sourcePaper.id },
          },
          select: {
            id: true,
            entityId: true,
          },
        })
      : [];

    for (const peer of affectedPeers) {
      if (!peer.entityId) continue;
      await projectLegacyRelation(
        sourcePaper.id,
        peer.id,
        sourceEntityId,
        peer.entityId,
        tx,
      );
    }

    const signalHistogram = emptySignalHistogram();
    for (const relation of ranked) {
      for (const evidenceRow of relation.evidence) {
        const signal = evidenceRow.type.replace(
          "deterministic_signal:",
          "",
        ) as DeterministicSignalName;
        const payload = parseDeterministicSignalPayload(evidenceRow.excerpt);
        if (!payload) continue;
        signalHistogram[signal].count += 1;
        signalHistogram[signal].totalContribution = roundScore(
          signalHistogram[signal].totalContribution + payload.contribution,
        );
      }
    }

    return {
      paperId,
      status: "updated",
      emittedCount: ranked.length,
      deletedLlmSemanticCount: existingLegacyLlm.length,
      deletedStaleDeterministicCount: staleDeterministicIds.length,
      affectedPeerCount: affectedPeers.length,
      signalHistogram,
    };
  });
}

export async function recomputeDeterministicRelatednessForPapers(
  paperIds: string[],
  db: DeterministicRootDb = prisma,
): Promise<{
  processed: number;
  updated: number;
  skippedNoUser: number;
  skippedNoEntity: number;
  emittedCount: number;
  signalHistogram: DeterministicRecomputeResult["signalHistogram"];
}> {
  const aggregate = {
    processed: 0,
    updated: 0,
    skippedNoUser: 0,
    skippedNoEntity: 0,
    emittedCount: 0,
    signalHistogram: emptySignalHistogram(),
  };

  for (const paperId of paperIds) {
    const result = await recomputeDeterministicRelatednessForPaper(paperId, db);
    aggregate.processed += 1;
    aggregate.emittedCount += result.emittedCount;

    if (result.status === "updated") aggregate.updated += 1;
    if (result.status === "skipped_no_user") aggregate.skippedNoUser += 1;
    if (result.status === "skipped_no_entity") aggregate.skippedNoEntity += 1;

    for (const [signal, stats] of Object.entries(result.signalHistogram) as Array<
      [DeterministicSignalName, { count: number; totalContribution: number }]
    >) {
      aggregate.signalHistogram[signal].count += stats.count;
      aggregate.signalHistogram[signal].totalContribution = roundScore(
        aggregate.signalHistogram[signal].totalContribution +
          stats.totalContribution,
      );
    }
  }

  return aggregate;
}
