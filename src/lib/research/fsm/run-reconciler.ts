// src/lib/research/fsm/run-reconciler.ts
import { prisma } from "@/lib/prisma";
import { withFsmBypassAsync } from "./state-guard";
import type { RunLifecycleState, CompletionCriterion } from "./enums";
import { RUN_TERMINAL_STATES } from "./enums";
import { evaluateCompletionCriterion, deriveIntentState } from "./intent-lifecycle";

/**
 * Reconcile a single run's state from its latest attempt/job data.
 * Called by the remote executor after job status changes.
 * This is the ONLY code path that writes to ExperimentRun.state.
 */
export async function reconcileRunState(runId: string): Promise<{
  previousState: string;
  newState: string;
  changed: boolean;
}> {
  const run = await prisma.experimentRun.findUnique({
    where: { id: runId },
    select: {
      id: true,
      state: true,
      intentId: true,
      projectId: true,
      attempts: {
        orderBy: { attemptNumber: "desc" },
        take: 1,
        select: {
          id: true,
          completedAt: true,
          exitCode: true,
          failureClass: true,
          remoteJob: {
            select: { status: true },
          },
        },
      },
    },
  });

  if (!run) return { previousState: "unknown", newState: "unknown", changed: false };

  const previousState = run.state;
  const latestAttempt = run.attempts[0];

  // Already terminal — no changes
  if ((RUN_TERMINAL_STATES as readonly string[]).includes(previousState)) {
    return { previousState, newState: previousState, changed: false };
  }

  let newState: RunLifecycleState = previousState as RunLifecycleState;

  if (latestAttempt) {
    const adapterStatus = latestAttempt.remoteJob?.status;

    if (latestAttempt.completedAt) {
      if (latestAttempt.exitCode === 0 && !latestAttempt.failureClass) {
        newState = "IMPORTING";
      } else {
        newState = "FAILED";
      }
    } else if (adapterStatus === "POLLING") {
      newState = "RUNNING";
    } else if (adapterStatus === "SYNCING") {
      newState = "QUEUED";
    }
  }

  if (newState !== previousState) {
    await withFsmBypassAsync(async () => {
      await prisma.experimentRun.update({
        where: { id: runId },
        data: {
          state: newState,
          lastErrorClass: newState === "FAILED" ? latestAttempt?.failureClass : undefined,
          overlay: (RUN_TERMINAL_STATES as readonly string[]).includes(newState) ? null : "ACTIVE",
        },
      });
    });

    // If run became terminal, evaluate parent intent
    if (run.intentId && (RUN_TERMINAL_STATES as readonly string[]).includes(newState)) {
      await reconcileIntentState(run.intentId);
    }
  }

  return { previousState, newState, changed: newState !== previousState };
}

/**
 * Re-evaluate an intent's state based on its child runs.
 */
export async function reconcileIntentState(intentId: string): Promise<void> {
  const intent = await prisma.experimentIntent.findUnique({
    where: { id: intentId },
    select: {
      id: true,
      status: true,
      completionCriterion: true,
      runs: {
        select: {
          state: true,
          runKey: true,
          seed: true,
          condition: true,
        },
      },
    },
  });

  if (!intent) return;

  let criterion: CompletionCriterion;
  try {
    criterion = JSON.parse(intent.completionCriterion) as CompletionCriterion;
  } catch {
    return;
  }

  // Map runs to RunSummary shape expected by deriveIntentState.
  // ExperimentRun doesn't have resultId; approximate by treating DONE runs
  // as having produced a result (non-null resultId).
  const runSummaries = intent.runs.map((r) => ({
    state: r.state,
    runKey: r.runKey,
    resultId: r.state === "DONE" ? r.runKey ?? r.state : null,
    seed: r.seed,
    condition: r.condition,
  }));

  const newState = deriveIntentState(
    intent.status as any,
    criterion,
    runSummaries,
  );

  if (newState !== intent.status) {
    await prisma.experimentIntent.update({
      where: { id: intentId },
      data: { status: newState },
    });
  }
}
