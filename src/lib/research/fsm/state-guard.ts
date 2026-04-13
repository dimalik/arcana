/**
 * Runtime enforcement: all currentPhase writes MUST go through the FSM transition engine.
 *
 * This module provides:
 * 1. A Prisma middleware that blocks direct currentPhase mutations
 * 2. A bypass token for the transition engine to use
 *
 * Any code that tries to update currentPhase without the bypass token
 * will get a loud error instead of silently corrupting state.
 */

/** Bypass token — only the transition engine should use this */
let fsmBypassActive = false;

export function withFsmBypass<T>(fn: () => T): T {
  fsmBypassActive = true;
  try {
    return fn();
  } finally {
    fsmBypassActive = false;
  }
}

export async function withFsmBypassAsync<T>(fn: () => Promise<T>): Promise<T> {
  fsmBypassActive = true;
  try {
    return await fn();
  } finally {
    fsmBypassActive = false;
  }
}

/**
 * Check if a Prisma update payload is trying to write currentPhase
 * without the FSM bypass. Call this from Prisma middleware.
 */
export function assertNoDirectPhaseWrite(
  model: string,
  action: string,
  args: Record<string, unknown>,
): void {
  if (model !== "ResearchProject") return;
  if (action !== "update" && action !== "updateMany") return;
  if (fsmBypassActive) return;

  const data = args.data as Record<string, unknown> | undefined;
  if (!data || !("currentPhase" in data)) return;

  const error = new Error(
    `INVARIANT VIOLATION: Direct write to ResearchProject.currentPhase detected. ` +
    `All state transitions must go through the FSM transition engine. ` +
    `Attempted to set currentPhase = "${data.currentPhase}". ` +
    `Use attemptAutoTransition() or wrap in withFsmBypassAsync() if this is intentional.`
  );
  console.error(error.message);
  throw error;
}
