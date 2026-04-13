export interface CollectResultsTaskSnapshot {
  id: string;
  role: string;
  goal: string;
  status: string;
  createdAt: Date;
  completedAt: Date | null;
  updatedAt: Date;
  lastCollectedAt: Date | null;
}

export interface CollectResultsCooldown {
  blocked: boolean;
  nextAllowedAt: Date | null;
  remainingMs: number;
  taskIds: string[];
  reason: string;
}

export function collectResultsCooldownMs(role: string): number {
  switch (role) {
    case "scout":
      return 3 * 60 * 1000;
    case "reviewer":
    case "reproducer":
      return 4 * 60 * 1000;
    case "synthesizer":
    case "architect":
    case "provocateur":
      return 5 * 60 * 1000;
    case "experimenter":
      return 10 * 60 * 1000;
    default:
      return 4 * 60 * 1000;
  }
}

function humanizeWait(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  return `${minutes} min`;
}

export function evaluateCollectResultsCooldown(
  tasks: CollectResultsTaskSnapshot[],
  now = new Date(),
): CollectResultsCooldown | null {
  const pending = tasks.filter((task) => task.status === "PENDING" || task.status === "RUNNING");
  if (pending.length === 0) return null;

  const unchangedPending = pending.filter((task) => {
    if (!task.lastCollectedAt) return false;
    return task.updatedAt.getTime() <= task.lastCollectedAt.getTime() + 1000;
  });
  if (unchangedPending.length !== pending.length) return null;

  const nextAllowedTimes = unchangedPending.map((task) => {
    const lastCollectedAt = task.lastCollectedAt!;
    return lastCollectedAt.getTime() + collectResultsCooldownMs(task.role);
  });
  const earliestNextAllowed = Math.min(...nextAllowedTimes);
  if (now.getTime() >= earliestNextAllowed) return null;

  const remainingMs = earliestNextAllowed - now.getTime();
  const taskSummary = unchangedPending
    .slice(0, 3)
    .map((task) => `${task.role} "${task.goal}"`)
    .join(", ");

  return {
    blocked: true,
    nextAllowedAt: new Date(earliestNextAllowed),
    remainingMs,
    taskIds: unchangedPending.map((task) => task.id),
    reason: [
      `collect_results was already called for the same still-running task set and nothing has changed yet.`,
      `Wait about ${humanizeWait(remainingMs)} before polling again.`,
      `Affected tasks: ${taskSummary}${unchangedPending.length > 3 ? ` (+${unchangedPending.length - 3} more)` : ""}.`,
    ].join(" "),
  };
}
