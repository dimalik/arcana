import { prisma } from "../prisma";

export const REFERENCE_STATE_VALUES = [
  "available",
  "pending",
  "extraction_failed",
  "unavailable_no_pdf",
] as const;

export type ReferenceState = (typeof REFERENCE_STATE_VALUES)[number];

export interface ReferenceStateClassificationInput {
  referenceCount: number;
  filePath: string | null;
  fullText: string | null;
  processingStatus: string | null;
}

export interface ReferenceStateSnapshot {
  totalPapers: number;
  counts: Record<ReferenceState, number>;
  availableNoPdfWithReferences: number;
}

type ReferenceStateDb = Pick<typeof prisma, "paper" | "reference">;

const TERMINAL_REFERENCE_EXTRACTION_STATUSES = new Set([
  "COMPLETED",
  "FAILED",
  "NO_PDF",
]);

export function classifyReferenceState(
  input: ReferenceStateClassificationInput,
): ReferenceState {
  if (input.referenceCount >= 1) {
    return "available";
  }

  if (
    input.filePath &&
    input.processingStatus &&
    TERMINAL_REFERENCE_EXTRACTION_STATUSES.has(input.processingStatus)
  ) {
    return "extraction_failed";
  }

  if (!input.filePath && input.fullText) {
    return "unavailable_no_pdf";
  }

  return "pending";
}

export function buildInitialReferenceState(input: {
  filePath?: string | null;
  fullText?: string | null;
  processingStatus?: string | null;
}): ReferenceState {
  return classifyReferenceState({
    referenceCount: 0,
    filePath: input.filePath ?? null,
    fullText: input.fullText ?? null,
    processingStatus: input.processingStatus ?? null,
  });
}

export async function syncPaperReferenceState(
  paperId: string,
  tx: ReferenceStateDb = prisma,
): Promise<ReferenceState> {
  const [paper, referenceCount] = await Promise.all([
    tx.paper.findUnique({
      where: { id: paperId },
      select: {
        id: true,
        filePath: true,
        fullText: true,
        processingStatus: true,
        referenceState: true,
      },
    }),
    tx.reference.count({
      where: { paperId },
    }),
  ]);

  if (!paper) {
    throw new Error(`Paper ${paperId} not found while syncing referenceState`);
  }

  const nextState = classifyReferenceState({
    referenceCount,
    filePath: paper.filePath,
    fullText: paper.fullText,
    processingStatus: paper.processingStatus,
  });

  if (paper.referenceState !== nextState) {
    await tx.paper.update({
      where: { id: paperId },
      data: { referenceState: nextState },
    });
  }

  return nextState;
}

export async function backfillReferenceStates(
  tx: ReferenceStateDb = prisma,
): Promise<ReferenceStateSnapshot> {
  const snapshot = await collectReferenceStateSnapshot(tx);

  const papers = await tx.paper.findMany({
    select: {
      id: true,
      filePath: true,
      fullText: true,
      processingStatus: true,
      _count: {
        select: {
          references: true,
        },
      },
    },
  });

  for (const paper of papers) {
    const nextState = classifyReferenceState({
      referenceCount: paper._count.references,
      filePath: paper.filePath,
      fullText: paper.fullText,
      processingStatus: paper.processingStatus,
    });

    await tx.paper.update({
      where: { id: paper.id },
      data: { referenceState: nextState },
    });
  }

  return snapshot;
}

export async function collectReferenceStateSnapshot(
  tx: ReferenceStateDb = prisma,
): Promise<ReferenceStateSnapshot> {
  const papers = await tx.paper.findMany({
    select: {
      id: true,
      filePath: true,
      fullText: true,
      processingStatus: true,
      _count: {
        select: {
          references: true,
        },
      },
    },
  });

  const counts = Object.fromEntries(
    REFERENCE_STATE_VALUES.map((state) => [state, 0]),
  ) as Record<ReferenceState, number>;

  let availableNoPdfWithReferences = 0;

  for (const paper of papers) {
    const nextState = classifyReferenceState({
      referenceCount: paper._count.references,
      filePath: paper.filePath,
      fullText: paper.fullText,
      processingStatus: paper.processingStatus,
    });
    counts[nextState] += 1;

    if (
      nextState === "available" &&
      !paper.filePath &&
      paper._count.references >= 1
    ) {
      availableNoPdfWithReferences += 1;
    }
  }

  return {
    totalPapers: papers.length,
    counts,
    availableNoPdfWithReferences,
  };
}
