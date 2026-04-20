import type {
  ConversationArtifact,
  ConversationArtifactKind,
  PaperClaim,
  PaperClaimEvidenceType,
  PaperClaimFacet,
  PaperClaimPolarity,
  PaperClaimRhetoricalRole,
  PaperClaimRun,
  PaperClaimRunStatus,
  Prisma,
} from "@/generated/prisma/client";

import { prisma } from "@/lib/prisma";

import {
  type PaperClaimCitationAnchor,
  type PaperClaimEvaluationContext,
  type PaperClaimSourceSpan,
  type PaperClaimStance,
  parsePaperClaimCitationAnchors,
  parsePaperClaimEvaluationContext,
  parsePaperClaimSourceSpan,
  parsePaperClaimStance,
  serializePaperClaimCitationAnchors,
  serializePaperClaimEvaluationContext,
  serializePaperClaimSourceSpan,
  serializePaperClaimStance,
} from "./types";

type PaperAnalysisDb = Prisma.TransactionClient | typeof prisma;

export interface UpsertPaperClaimRunInput {
  paperId: string;
  extractorVersion: string;
  sourceTextHash: string;
  status?: PaperClaimRunStatus;
  completedAt?: Date | null;
}

export interface StoredPaperClaimInput {
  claimType?: string | null;
  rhetoricalRole: PaperClaimRhetoricalRole;
  facet: PaperClaimFacet;
  polarity: PaperClaimPolarity;
  stance?: PaperClaimStance | null;
  evaluationContext?: PaperClaimEvaluationContext | null;
  text: string;
  normalizedText: string;
  confidence?: number;
  sectionLabel?: string | null;
  sectionPath: string;
  sourceExcerpt: string;
  excerptHash: string;
  sourceSpan?: PaperClaimSourceSpan | null;
  citationAnchors?: PaperClaimCitationAnchor[] | null;
  evidenceType: PaperClaimEvidenceType;
  orderIndex: number;
}

export interface PaperClaimView
  extends Omit<
    PaperClaim,
    "stance" | "evaluationContext" | "sourceSpan" | "citationAnchors"
  > {
  stance: PaperClaimStance | null;
  evaluationContext: PaperClaimEvaluationContext | null;
  sourceSpan: PaperClaimSourceSpan | null;
  citationAnchors: PaperClaimCitationAnchor[];
}

export interface ConversationArtifactView
  extends Omit<ConversationArtifact, "payloadJson"> {
  payloadJson: string;
}

export async function upsertPaperClaimRun(
  db: PaperAnalysisDb,
  input: UpsertPaperClaimRunInput,
): Promise<PaperClaimRun> {
  const status = input.status ?? "PENDING";
  return db.paperClaimRun.upsert({
    where: {
      paperId_extractorVersion_sourceTextHash: {
        paperId: input.paperId,
        extractorVersion: input.extractorVersion,
        sourceTextHash: input.sourceTextHash,
      },
    },
    create: {
      paperId: input.paperId,
      extractorVersion: input.extractorVersion,
      sourceTextHash: input.sourceTextHash,
      status,
      completedAt: input.completedAt ?? null,
    },
    update: {
      status,
      completedAt: input.completedAt ?? null,
    },
  });
}

export async function replacePaperClaimsForRun(
  db: PaperAnalysisDb,
  params: {
    paperId: string;
    runId: string;
    claims: StoredPaperClaimInput[];
  },
): Promise<void> {
  await db.paperClaim.deleteMany({
    where: { runId: params.runId },
  });

  if (params.claims.length === 0) return;

  await db.paperClaim.createMany({
    data: params.claims.map((claim) => ({
      paperId: params.paperId,
      runId: params.runId,
      claimType: claim.claimType ?? null,
      rhetoricalRole: claim.rhetoricalRole,
      facet: claim.facet,
      polarity: claim.polarity,
      stance: serializePaperClaimStance(claim.stance),
      evaluationContext: serializePaperClaimEvaluationContext(
        claim.evaluationContext,
      ),
      text: claim.text,
      normalizedText: claim.normalizedText,
      confidence: claim.confidence ?? 0,
      sectionLabel: claim.sectionLabel ?? null,
      sectionPath: claim.sectionPath,
      sourceExcerpt: claim.sourceExcerpt,
      excerptHash: claim.excerptHash,
      sourceSpan: serializePaperClaimSourceSpan(claim.sourceSpan),
      citationAnchors: serializePaperClaimCitationAnchors(
        claim.citationAnchors,
      ),
      evidenceType: claim.evidenceType,
      orderIndex: claim.orderIndex,
    })),
  });
}

export async function completePaperClaimRun(
  db: PaperAnalysisDb,
  params: {
    runId: string;
    status: PaperClaimRunStatus;
    completedAt?: Date;
  },
): Promise<PaperClaimRun> {
  return db.paperClaimRun.update({
    where: { id: params.runId },
    data: {
      status: params.status,
      completedAt: params.completedAt ?? new Date(),
    },
  });
}

export function hydratePaperClaim(claim: PaperClaim): PaperClaimView {
  return {
    ...claim,
    stance: parsePaperClaimStance(claim.stance),
    evaluationContext: parsePaperClaimEvaluationContext(
      claim.evaluationContext,
    ),
    sourceSpan: parsePaperClaimSourceSpan(claim.sourceSpan),
    citationAnchors: parsePaperClaimCitationAnchors(claim.citationAnchors),
  };
}

export async function getLatestCompletedPaperClaimRun(
  db: PaperAnalysisDb,
  paperId: string,
): Promise<(PaperClaimRun & { claims: PaperClaimView[] }) | null> {
  const run = await db.paperClaimRun.findFirst({
    where: { paperId, status: "COMPLETED" },
    include: {
      claims: {
        orderBy: { orderIndex: "asc" },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!run) return null;
  return {
    ...run,
    claims: run.claims.map(hydratePaperClaim),
  };
}

export async function listPaperClaimsForPaper(
  db: PaperAnalysisDb,
  paperId: string,
): Promise<PaperClaimView[]> {
  const claims = await db.paperClaim.findMany({
    where: { paperId },
    orderBy: [{ run: { createdAt: "desc" } }, { orderIndex: "asc" }],
  });
  return claims.map(hydratePaperClaim);
}

export async function createConversationArtifact(
  db: PaperAnalysisDb,
  params: {
    conversationId: string;
    messageId?: string | null;
    kind: ConversationArtifactKind;
    title: string;
    payloadJson: string;
  },
): Promise<ConversationArtifact> {
  return db.conversationArtifact.create({
    data: {
      conversationId: params.conversationId,
      messageId: params.messageId ?? null,
      kind: params.kind,
      title: params.title,
      payloadJson: params.payloadJson,
    },
  });
}

export async function listConversationArtifacts(
  db: PaperAnalysisDb,
  conversationId: string,
): Promise<ConversationArtifactView[]> {
  const artifacts = await db.conversationArtifact.findMany({
    where: { conversationId },
    orderBy: { createdAt: "asc" },
  });
  return artifacts;
}
