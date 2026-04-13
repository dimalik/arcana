import { randomUUID } from "crypto";
import { prisma } from "@/lib/prisma";

export type ExperimentRunState =
  | "QUEUED"
  | "STARTING"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "BLOCKED";

const TERMINAL_RUN_STATES = new Set<ExperimentRunState>(["SUCCEEDED", "FAILED", "CANCELLED", "BLOCKED"]);
// Lease TTL must exceed the maximum SSH blackout window tolerated by the
// remote poller, otherwise a still-live run can lose its workspace lock.
export const EXECUTOR_LEASE_TTL_MS = 45 * 60 * 1000;

function runStateSet(...states: ExperimentRunState[]): Set<ExperimentRunState> {
  return new Set<ExperimentRunState>(states);
}

const ALLOWED_RUN_STATE_TRANSITIONS: Record<ExperimentRunState, Set<ExperimentRunState>> = {
  QUEUED: runStateSet("STARTING", "CANCELLED", "BLOCKED"),
  STARTING: runStateSet("RUNNING", "FAILED", "CANCELLED", "BLOCKED"),
  RUNNING: runStateSet("SUCCEEDED", "FAILED", "CANCELLED", "BLOCKED"),
  SUCCEEDED: runStateSet(),
  FAILED: runStateSet("QUEUED", "BLOCKED", "CANCELLED"),
  CANCELLED: runStateSet("QUEUED"),
  BLOCKED: runStateSet("QUEUED", "CANCELLED"),
};

function stateToRemoteJobStatus(state: ExperimentRunState): "QUEUED" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED" {
  switch (state) {
    case "QUEUED":
    case "STARTING":
      return "QUEUED";
    case "RUNNING":
      return "RUNNING";
    case "SUCCEEDED":
      return "COMPLETED";
    case "FAILED":
    case "BLOCKED":
      return "FAILED";
    case "CANCELLED":
      return "CANCELLED";
  }
}

function safeJson(data: unknown): string | null {
  if (data === undefined || data === null) return null;
  try {
    return JSON.stringify(data);
  } catch {
    return JSON.stringify({ note: "unserializable payload" });
  }
}

function assertTransitionAllowed(fromState: ExperimentRunState, toState: ExperimentRunState): void {
  const allowed = ALLOWED_RUN_STATE_TRANSITIONS[fromState];
  if (fromState !== toState && !allowed.has(toState)) {
    throw new Error(`Invalid run state transition: ${fromState} -> ${toState}`);
  }
}

export function isTerminalRunState(state: ExperimentRunState): boolean {
  return TERMINAL_RUN_STATES.has(state);
}

export function buildWorkspaceLeaseKey(hostId: string, remoteDir: string): string {
  return `workspace:${hostId}:${remoteDir}`;
}

export interface ExecutorLeaseOwner {
  ownerId: string;
  scope: string;
  runId?: string | null;
  attemptId?: string | null;
  hostId?: string | null;
  projectId?: string | null;
  metadata?: unknown;
}

export async function loadExecutorLease(leaseKey: string) {
  return prisma.executorLease.findUnique({
    where: { leaseKey },
  });
}

export async function acquireExecutorLease(params: {
  leaseKey: string;
  ttlMs?: number;
  owner: ExecutorLeaseOwner;
}) {
  const ttlMs = params.ttlMs ?? EXECUTOR_LEASE_TTL_MS;
  const now = new Date();
  const nextExpiry = new Date(now.getTime() + ttlMs);
  const requestedToken = randomUUID();

  const result = await prisma.$transaction(async (tx) => {
    const existing = await tx.executorLease.findUnique({
      where: { leaseKey: params.leaseKey },
    });

    if (!existing) {
      const lease = await tx.executorLease.create({
        data: {
          leaseKey: params.leaseKey,
          leaseToken: requestedToken,
          ownerId: params.owner.ownerId,
          scope: params.owner.scope,
          runId: params.owner.runId || null,
          attemptId: params.owner.attemptId || null,
          hostId: params.owner.hostId || null,
          projectId: params.owner.projectId || null,
          leaseVersion: 1,
          leaseAcquiredAt: now,
          lastHeartbeatAt: now,
          leaseExpiresAt: nextExpiry,
          metadata: safeJson(params.owner.metadata),
        },
      });
      return { acquired: true as const, lease };
    }

    if (existing.leaseExpiresAt <= now) {
      const lease = await tx.executorLease.update({
        where: { leaseKey: params.leaseKey },
        data: {
          leaseToken: requestedToken,
          ownerId: params.owner.ownerId,
          scope: params.owner.scope,
          runId: params.owner.runId || null,
          attemptId: params.owner.attemptId || null,
          hostId: params.owner.hostId || null,
          projectId: params.owner.projectId || null,
          leaseVersion: existing.leaseVersion + 1,
          leaseAcquiredAt: now,
          lastHeartbeatAt: now,
          leaseExpiresAt: nextExpiry,
          metadata: safeJson(params.owner.metadata),
        },
      });
      return { acquired: true as const, lease, replacedExpired: true as const };
    }

    return { acquired: false as const, blockingLease: existing };
  });

  if (result.acquired && result.lease.runId) {
    await appendRunEvent({
      runId: result.lease.runId,
      attemptId: result.lease.attemptId || null,
      type: "LEASE_ACQUIRED",
      message: `Lease acquired for ${params.leaseKey}`,
      payload: {
        leaseKey: params.leaseKey,
        leaseVersion: result.lease.leaseVersion,
        leaseExpiresAt: result.lease.leaseExpiresAt,
      },
    }).catch(() => {});
  }

  return result;
}

export async function heartbeatExecutorLease(params: {
  leaseKey: string;
  leaseToken: string;
  ttlMs?: number;
}) {
  const now = new Date();
  const nextExpiry = new Date(now.getTime() + (params.ttlMs ?? EXECUTOR_LEASE_TTL_MS));
  const updated = await prisma.executorLease.updateMany({
    where: {
      leaseKey: params.leaseKey,
      leaseToken: params.leaseToken,
    },
    data: {
      lastHeartbeatAt: now,
      leaseExpiresAt: nextExpiry,
    },
  });
  return updated.count > 0;
}

export async function heartbeatAttemptExecutorLeases(params: {
  attemptId: string;
  ttlMs?: number;
}) {
  const now = new Date();
  const nextExpiry = new Date(now.getTime() + (params.ttlMs ?? EXECUTOR_LEASE_TTL_MS));
  const updated = await prisma.executorLease.updateMany({
    where: {
      attemptId: params.attemptId,
    },
    data: {
      lastHeartbeatAt: now,
      leaseExpiresAt: nextExpiry,
    },
  });
  return updated.count;
}

export async function releaseExecutorLease(params: {
  leaseKey: string;
  leaseToken?: string;
  reason?: string;
  payload?: unknown;
}) {
  const lease = await prisma.executorLease.findUnique({
    where: { leaseKey: params.leaseKey },
  });
  if (!lease) return false;
  if (params.leaseToken && lease.leaseToken !== params.leaseToken) return false;

  await prisma.executorLease.delete({
    where: { leaseKey: params.leaseKey },
  });

  if (lease.runId) {
    await appendRunEvent({
      runId: lease.runId,
      attemptId: lease.attemptId || null,
      type: "LEASE_RELEASED",
      message: params.reason || `Lease released for ${params.leaseKey}`,
      payload: {
        leaseKey: params.leaseKey,
        ...(params.payload ? { payload: params.payload } : {}),
      },
    }).catch(() => {});
  }

  return true;
}

export async function releaseAttemptExecutorLeases(params: {
  attemptId: string;
  reason?: string;
  payload?: unknown;
}) {
  const leases = await prisma.executorLease.findMany({
    where: { attemptId: params.attemptId },
    select: { leaseKey: true, leaseToken: true },
  });
  if (leases.length === 0) return 0;
  let released = 0;
  for (const lease of leases) {
    const ok = await releaseExecutorLease({
      leaseKey: lease.leaseKey,
      leaseToken: lease.leaseToken,
      reason: params.reason,
      payload: params.payload,
    });
    if (ok) released += 1;
  }
  return released;
}

export async function appendRunEvent(params: {
  runId: string;
  attemptId?: string | null;
  type: string;
  stateFrom?: string | null;
  stateTo?: string | null;
  message?: string | null;
  payload?: unknown;
}): Promise<void> {
  await prisma.experimentEvent.create({
    data: {
      runId: params.runId,
      attemptId: params.attemptId || null,
      type: params.type,
      stateFrom: params.stateFrom || null,
      stateTo: params.stateTo || null,
      message: params.message || null,
      payload: safeJson(params.payload),
    },
  });
}

export async function createRunForSubmission(params: {
  projectId: string;
  hypothesisId?: string | null;
  experimentPurpose?: string | null;
  grounding?: string | null;
  claimEligibility?: string | null;
  promotionPolicy?: string | null;
  evidenceClass?: string | null;
  requestedHostId?: string | null;
  command: string;
  scriptName?: string | null;
  scriptHash?: string | null;
  priority?: number;
  maxAttempts?: number;
  maxAutoFixAttempts?: number;
  idempotencyKey?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<{ runId: string; reused: boolean }> {
  const idempotencyKey = params.idempotencyKey?.trim();
  if (idempotencyKey) {
    const existing = await prisma.experimentRun.findFirst({
      where: {
        projectId: params.projectId,
        metadata: { contains: `"idempotencyKey":"${idempotencyKey}"` },
      },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    });
    if (existing) {
      return { runId: existing.id, reused: true };
    }
  }

  const metadata = {
    ...(params.metadata || {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
  };

  const run = await prisma.experimentRun.create({
    data: {
      projectId: params.projectId,
      hypothesisId: params.hypothesisId || null,
      experimentPurpose: params.experimentPurpose || null,
      grounding: params.grounding || null,
      claimEligibility: params.claimEligibility || null,
      promotionPolicy: params.promotionPolicy || null,
      evidenceClass: params.evidenceClass || null,
      requestedHostId: params.requestedHostId || null,
      command: params.command,
      scriptName: params.scriptName || null,
      scriptHash: params.scriptHash || null,
      state: "QUEUED",
      priority: params.priority ?? 0,
      maxAttempts: params.maxAttempts ?? 3,
      maxAutoFixAttempts: params.maxAutoFixAttempts ?? 2,
      metadata: safeJson(metadata),
    },
    select: { id: true },
  });

  await appendRunEvent({
    runId: run.id,
    type: "RUN_CREATED",
    stateTo: "QUEUED",
    message: "Run created from submitRemoteJob",
    payload: {
      hypothesisId: params.hypothesisId || null,
      experimentPurpose: params.experimentPurpose || null,
      grounding: params.grounding || null,
      claimEligibility: params.claimEligibility || null,
      promotionPolicy: params.promotionPolicy || null,
      evidenceClass: params.evidenceClass || null,
      requestedHostId: params.requestedHostId || null,
      idempotencyKey: idempotencyKey || null,
    },
  });

  return { runId: run.id, reused: false };
}

export async function createAttemptRecord(params: {
  runId: string;
  attemptNumber: number;
  hostId?: string | null;
  localDir?: string | null;
  remoteDir?: string | null;
  runDir?: string | null;
  helperVersion?: string | null;
}): Promise<string> {
  const attempt = await prisma.experimentAttempt.create({
    data: {
      runId: params.runId,
      attemptNumber: params.attemptNumber,
      hostId: params.hostId || null,
      localDir: params.localDir || null,
      remoteDir: params.remoteDir || null,
      runDir: params.runDir || null,
      helperVersion: params.helperVersion || null,
      state: "STARTING",
      startedAt: new Date(),
    },
    select: { id: true },
  });

  await appendRunEvent({
    runId: params.runId,
    attemptId: attempt.id,
    type: "ATTEMPT_CREATED",
    message: `Attempt #${params.attemptNumber} created`,
    payload: {
      hostId: params.hostId || null,
      localDir: params.localDir || null,
      remoteDir: params.remoteDir || null,
      runDir: params.runDir || null,
    },
  });

  return attempt.id;
}

export async function reserveNextAttemptNumber(runId: string): Promise<number> {
  return prisma.$transaction(async (tx) => {
    const run = await tx.experimentRun.findUnique({
      where: { id: runId },
      select: { attemptCount: true },
    });
    if (!run) {
      throw new Error(`ExperimentRun not found: ${runId}`);
    }
    const nextAttempt = run.attemptCount + 1;
    await tx.experimentRun.update({
      where: { id: runId },
      data: { attemptCount: nextAttempt },
    });
    return nextAttempt;
  });
}

export async function transitionRunState(params: {
  runId: string;
  toState: ExperimentRunState;
  reason?: string;
  attemptId?: string | null;
  payload?: unknown;
  requireFrom?: ExperimentRunState[];
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const current = await tx.experimentRun.findUnique({
      where: { id: params.runId },
      select: { state: true, startedAt: true, completedAt: true },
    });
    if (!current) {
      throw new Error(`ExperimentRun not found: ${params.runId}`);
    }

    const fromState = current.state as ExperimentRunState;
    if (params.requireFrom && params.requireFrom.length > 0 && !params.requireFrom.includes(fromState)) {
      throw new Error(
        `Run ${params.runId} is in ${fromState}, expected one of: ${params.requireFrom.join(", ")}`,
      );
    }

    assertTransitionAllowed(fromState, params.toState);
    if (fromState === params.toState) return;

    const now = new Date();
    await tx.experimentRun.update({
      where: { id: params.runId },
      data: {
        state: params.toState,
        startedAt: !current.startedAt && (params.toState === "RUNNING" || params.toState === "STARTING")
          ? now
          : undefined,
        completedAt: isTerminalRunState(params.toState)
          ? now
          : (current.completedAt ? current.completedAt : null),
      },
    });

    await tx.experimentEvent.create({
      data: {
        runId: params.runId,
        attemptId: params.attemptId || null,
        type: "RUN_STATE_TRANSITION",
        stateFrom: fromState,
        stateTo: params.toState,
        message: params.reason || null,
        payload: safeJson(params.payload),
      },
    });
  });
}

export async function setAttemptRunning(params: {
  attemptId: string;
  remotePid?: number | null;
  remotePgid?: number | null;
}): Promise<void> {
  await prisma.experimentAttempt.update({
    where: { id: params.attemptId },
    data: {
      state: "RUNNING",
      remotePid: params.remotePid ?? null,
      remotePgid: params.remotePgid ?? null,
      heartbeatAt: new Date(),
    },
  });
}

export async function finalizeAttempt(params: {
  attemptId: string;
  exitCode?: number | null;
  stdoutTail?: string | null;
  stderrTail?: string | null;
  diagnostics?: unknown;
  errorClass?: string | null;
  errorReason?: string | null;
}): Promise<void> {
  await prisma.experimentAttempt.update({
    where: { id: params.attemptId },
    data: {
      state: "TERMINAL",
      exitCode: params.exitCode ?? null,
      stdoutTail: params.stdoutTail ?? null,
      stderrTail: params.stderrTail ?? null,
      diagnostics: safeJson(params.diagnostics),
      errorClass: params.errorClass ?? null,
      errorReason: params.errorReason ?? null,
      heartbeatAt: new Date(),
      completedAt: new Date(),
    },
  });
}

export async function linkRunToRemoteJob(runId: string, remoteJobId: string): Promise<void> {
  await prisma.remoteJob.update({
    where: { id: remoteJobId },
    data: { runId },
  });
}

export async function syncLegacyRemoteJobProjection(params: {
  runId: string;
  remoteJobId: string;
}): Promise<void> {
  const run = await prisma.experimentRun.findUnique({
    where: { id: params.runId },
    select: {
      state: true,
      attempts: {
        orderBy: [{ attemptNumber: "desc" }, { createdAt: "desc" }],
        take: 1,
        select: { exitCode: true, stdoutTail: true, stderrTail: true, errorClass: true },
      },
    },
  });
  if (!run) return;

  const latestAttempt = run.attempts[0];
  await prisma.remoteJob.update({
    where: { id: params.remoteJobId },
    data: {
      runId: params.runId,
      status: stateToRemoteJobStatus(run.state as ExperimentRunState),
      exitCode: latestAttempt?.exitCode ?? undefined,
      stdout: latestAttempt?.stdoutTail ?? undefined,
      stderr: latestAttempt?.stderrTail ?? undefined,
      errorClass: latestAttempt?.errorClass ?? undefined,
    },
  });
}
