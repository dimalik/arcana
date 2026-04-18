import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { syncPaperReferenceState } from "../references/reference-state";

export const PROCESSING_TERMINAL_STATUSES = new Set([
  "COMPLETED",
  "FAILED",
  "PENDING",
  "NEEDS_DEFERRED",
  "NO_PDF",
  "BATCH_PROCESSING",
]);

export const PROCESSING_RUN_ACTIVE_STATUS = "RUNNING";
export const PROCESSING_RECONCILED_ERROR = "reconciled_after_restart";

type DbClient = Prisma.TransactionClient | typeof prisma;
type RunLifecycleStatus = "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
type StepLifecycleStatus = "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";

interface ProjectionState {
  processingStatus: string;
  processingStep: string | null;
  processingStartedAt: Date | null;
}

interface CreateRunInput {
  paperId: string;
  trigger: string;
  processingStatus: string;
  processingStep?: string | null;
  metadata?: Record<string, unknown>;
  startedAt?: Date;
}

interface StartStepInput {
  paperId: string;
  processingRunId: string;
  step: string;
  processingStatus: string;
  metadata?: Record<string, unknown>;
  startedAt?: Date;
}

interface ClearStepInput {
  paperId: string;
  processingRunId: string;
  processingStatus: string;
  completedStepStatus?: StepLifecycleStatus;
  completedAt?: Date;
  error?: string | null;
}

interface FinishRunInput {
  paperId: string;
  processingRunId: string;
  processingStatus: string;
  runStatus: Exclude<RunLifecycleStatus, "RUNNING">;
  activeStepStatus?: StepLifecycleStatus;
  completedAt?: Date;
  error?: string | null;
  reconciled?: boolean;
}

function serializeMetadata(metadata?: Record<string, unknown>): string | null {
  return metadata ? JSON.stringify(metadata) : null;
}

function getDb(tx?: DbClient): DbClient {
  return tx ?? prisma;
}

async function projectPaperProcessingState(
  tx: DbClient,
  paperId: string,
  state: ProjectionState,
) {
  await tx.paper.update({
    where: { id: paperId },
    data: {
      processingStatus: state.processingStatus,
      processingStep: state.processingStep,
      processingStartedAt: state.processingStartedAt,
    },
  });
  await syncPaperReferenceState(paperId, tx);
}

async function closeActiveSteps(
  tx: DbClient,
  processingRunId: string,
  stepStatus: StepLifecycleStatus,
  completedAt: Date,
  error?: string | null,
) {
  await tx.processingStepRun.updateMany({
    where: {
      processingRunId,
      status: PROCESSING_RUN_ACTIVE_STATUS,
    },
    data: {
      status: stepStatus,
      completedAt,
      error: error ?? null,
    },
  });
}

export async function createProcessingRun(
  input: CreateRunInput,
  tx?: DbClient,
) {
  const db = getDb(tx);
  const startedAt = input.startedAt ?? new Date();
  const run = await db.processingRun.create({
    data: {
      paperId: input.paperId,
      trigger: input.trigger,
      status: PROCESSING_RUN_ACTIVE_STATUS,
      metadata: serializeMetadata(input.metadata),
      startedAt,
    },
  });

  if (input.processingStep) {
    await db.processingStepRun.create({
      data: {
        processingRunId: run.id,
        paperId: input.paperId,
        step: input.processingStep,
        status: PROCESSING_RUN_ACTIVE_STATUS,
        metadata: serializeMetadata(input.metadata),
        startedAt,
      },
    });
  }

  await projectPaperProcessingState(db, input.paperId, {
    processingStatus: input.processingStatus,
    processingStep: input.processingStep ?? null,
    processingStartedAt: input.processingStep ? startedAt : null,
  });

  return run;
}

export async function startProcessingStep(
  input: StartStepInput,
  tx?: DbClient,
) {
  const db = getDb(tx);
  const startedAt = input.startedAt ?? new Date();

  await closeActiveSteps(db, input.processingRunId, "COMPLETED", startedAt);

  await db.processingStepRun.create({
    data: {
      processingRunId: input.processingRunId,
      paperId: input.paperId,
      step: input.step,
      status: PROCESSING_RUN_ACTIVE_STATUS,
      metadata: serializeMetadata(input.metadata),
      startedAt,
    },
  });

  await db.processingRun.update({
    where: { id: input.processingRunId },
    data: {
      status: PROCESSING_RUN_ACTIVE_STATUS,
      completedAt: null,
      error: null,
      reconciledAt: null,
    },
  });

  await projectPaperProcessingState(db, input.paperId, {
    processingStatus: input.processingStatus,
    processingStep: input.step,
    processingStartedAt: startedAt,
  });
}

export async function clearProcessingStep(
  input: ClearStepInput,
  tx?: DbClient,
) {
  const db = getDb(tx);
  const completedAt = input.completedAt ?? new Date();

  await closeActiveSteps(
    db,
    input.processingRunId,
    input.completedStepStatus ?? "COMPLETED",
    completedAt,
    input.error,
  );

  await projectPaperProcessingState(db, input.paperId, {
    processingStatus: input.processingStatus,
    processingStep: null,
    processingStartedAt: null,
  });
}

export async function finishProcessingRun(
  input: FinishRunInput,
  tx?: DbClient,
) {
  const db = getDb(tx);
  const completedAt = input.completedAt ?? new Date();
  const activeStepStatus =
    input.activeStepStatus ??
    (input.runStatus === "COMPLETED"
      ? "COMPLETED"
      : input.runStatus === "CANCELLED"
        ? "CANCELLED"
        : "FAILED");

  await closeActiveSteps(
    db,
    input.processingRunId,
    activeStepStatus,
    completedAt,
    input.error,
  );

  await db.processingRun.update({
    where: { id: input.processingRunId },
    data: {
      status: input.runStatus,
      completedAt,
      error: input.error ?? null,
      reconciledAt: input.reconciled ? completedAt : null,
    },
  });

  await projectPaperProcessingState(db, input.paperId, {
    processingStatus: input.processingStatus,
    processingStep: null,
    processingStartedAt: null,
  });
}

export async function setProcessingProjection(
  paperId: string,
  state: ProjectionState,
  tx?: DbClient,
) {
  await projectPaperProcessingState(getDb(tx), paperId, state);
}

export async function getLatestActiveRunForPaper(
  paperId: string,
  tx?: DbClient,
) {
  return getDb(tx).processingRun.findFirst({
    where: {
      paperId,
      status: PROCESSING_RUN_ACTIVE_STATUS,
    },
    orderBy: { startedAt: "desc" },
  });
}

export async function getLatestActiveRunsForPapers(
  paperIds: string[],
  tx?: DbClient,
) {
  if (paperIds.length === 0) return new Map<string, string>();

  const runs = await getDb(tx).processingRun.findMany({
    where: {
      paperId: { in: paperIds },
      status: PROCESSING_RUN_ACTIVE_STATUS,
    },
    orderBy: [{ paperId: "asc" }, { startedAt: "desc" }],
    select: { id: true, paperId: true },
  });

  const byPaperId = new Map<string, string>();
  for (const run of runs) {
    if (!byPaperId.has(run.paperId)) {
      byPaperId.set(run.paperId, run.id);
    }
  }
  return byPaperId;
}

export async function createBatchProcessingRuns(
  paperIds: string[],
  args: {
    groupId: string;
    phase: number;
    modelId: string;
  },
  tx?: DbClient,
) {
  const db = getDb(tx);
  const created = new Map<string, string>();

  for (const paperId of paperIds) {
    const run = await createProcessingRun(
      {
        paperId,
        trigger: "batch",
        processingStatus: "BATCH_PROCESSING",
        processingStep: `batch-phase-${args.phase}`,
        metadata: {
          source: "batch",
          batchGroupId: args.groupId,
          batchPhase: args.phase,
          modelId: args.modelId,
        },
      },
      db,
    );
    created.set(paperId, run.id);
  }

  return created;
}

export async function advanceBatchPhase(
  paperIds: string[],
  args: {
    groupId: string;
    phase: number;
    modelId: string;
  },
  tx?: DbClient,
) {
  const db = getDb(tx);
  const activeRuns = await getLatestActiveRunsForPapers(paperIds, db);

  for (const paperId of paperIds) {
    const processingRunId = activeRuns.get(paperId);
    if (!processingRunId) continue;
    await startProcessingStep(
      {
        paperId,
        processingRunId,
        step: `batch-phase-${args.phase}`,
        processingStatus: "BATCH_PROCESSING",
        metadata: {
          source: "batch",
          batchGroupId: args.groupId,
          batchPhase: args.phase,
          modelId: args.modelId,
        },
      },
      db,
    );
  }
}

export async function completeBatchRuns(
  paperIds: string[],
  tx?: DbClient,
) {
  const db = getDb(tx);
  const activeRuns = await getLatestActiveRunsForPapers(paperIds, db);

  for (const paperId of paperIds) {
    const processingRunId = activeRuns.get(paperId);
    if (!processingRunId) continue;
    await finishProcessingRun(
      {
        paperId,
        processingRunId,
        processingStatus: "COMPLETED",
        runStatus: "COMPLETED",
      },
      db,
    );
  }
}

export async function reconcileProcessingRuntime(options?: {
  stallThresholdMs?: number;
  dryRun?: boolean;
}) {
  const stallThresholdMs = options?.stallThresholdMs ?? 5 * 60 * 1000;
  const dryRun = options?.dryRun ?? false;
  const stallCutoff = new Date(Date.now() - stallThresholdMs);

  const stalledPapers = await prisma.paper.findMany({
    where: {
      processingStatus: {
        notIn: Array.from(PROCESSING_TERMINAL_STATUSES),
      },
      processingStartedAt: {
        lt: stallCutoff,
      },
    },
    select: { id: true, processingStatus: true },
  });

  const legacyStuckPapers = await prisma.paper.findMany({
    where: {
      processingStatus: {
        notIn: Array.from(PROCESSING_TERMINAL_STATUSES),
      },
      processingStartedAt: null,
    },
    select: { id: true, processingStatus: true },
  });

  const abandonedPending = await prisma.paper.findMany({
    where: {
      processingStatus: "PENDING",
      abstract: { not: null },
    },
    select: { id: true },
    take: 200,
  });

  const recovered = new Map<string, string>();
  for (const paper of [...stalledPapers, ...legacyStuckPapers]) {
    if (!recovered.has(paper.id)) {
      recovered.set(paper.id, paper.processingStatus);
    }
  }

  if (!dryRun) {
    for (const [paperId, processingStatus] of Array.from(recovered.entries())) {
      await prisma.$transaction(async (tx) => {
        const activeRun = await getLatestActiveRunForPaper(paperId, tx);
        if (activeRun) {
          await finishProcessingRun(
            {
              paperId,
              processingRunId: activeRun.id,
              processingStatus,
              runStatus: "FAILED",
              activeStepStatus: "FAILED",
              error: PROCESSING_RECONCILED_ERROR,
              reconciled: true,
            },
            tx,
          );
          await setProcessingProjection(
            paperId,
            {
              processingStatus,
              processingStep: null,
              processingStartedAt: null,
            },
            tx,
          );
          return;
        }

        await setProcessingProjection(
          paperId,
          {
            processingStatus,
            processingStep: null,
            processingStartedAt: null,
          },
          tx,
        );
      });
    }
  }

  return {
    stallCutoff,
    stalledPaperIds: stalledPapers.map((paper) => paper.id),
    legacyStuckPaperIds: legacyStuckPapers.map((paper) => paper.id),
    recoveredPaperIds: Array.from(recovered.keys()),
    abandonedPendingIds: abandonedPending.map((paper) => paper.id),
  };
}

export async function readPersistedProcessingStatus() {
  const [activeRuns, activeBatches] = await Promise.all([
    prisma.processingRun.findMany({
      where: { status: PROCESSING_RUN_ACTIVE_STATUS },
      orderBy: { startedAt: "asc" },
      select: {
        id: true,
        paperId: true,
        trigger: true,
        status: true,
        startedAt: true,
        paper: {
          select: {
            title: true,
            processingStatus: true,
            processingStep: true,
            processingStartedAt: true,
          },
        },
      },
    }),
    prisma.processingBatch.findMany({
      where: { status: { in: ["SUBMITTED", "PROCESSING", "BUILDING"] } },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        groupId: true,
        phase: true,
        status: true,
        requestCount: true,
        completedCount: true,
        failedCount: true,
        createdAt: true,
      },
    }),
  ]);

  return {
    source: "persisted" as const,
    processing: activeRuns[0]?.paperId ?? null,
    queue: [] as string[],
    queueLength: 0,
    activeCount: activeRuns.length,
    batchPending: activeBatches.length,
    activeRuns: activeRuns.map((run) => ({
      runId: run.id,
      paperId: run.paperId,
      title: run.paper.title,
      trigger: run.trigger,
      status: run.paper.processingStatus,
      step: run.paper.processingStep,
      processingStartedAt: run.paper.processingStartedAt,
      startedAt: run.startedAt,
    })),
    activeBatches,
  };
}
