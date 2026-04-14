import type { CompletionCriterion } from "./enums";

interface ExistingRun {
  id: string;
  state: string;
  runKey: string | null;
  seed: number | null;
  condition: string | null;
  resultId: string | null;
}

type MaterializationResult =
  | { action: "create"; runKey: string; seed?: number; condition?: string }
  | { action: "reopen"; existingRunId: string; runKey: string }
  | { action: "reject"; reason: string };

const TERMINAL = new Set(["DONE", "FAILED", "CANCELLED"]);
const REOPENABLE = new Set(["FAILED", "CANCELLED"]);

function findByRunKey(runs: ExistingRun[], key: string): ExistingRun | null {
  return runs.find((r) => r.runKey === key) || null;
}

export function determineNextRun(
  criterion: CompletionCriterion,
  existingRuns: ExistingRun[],
): MaterializationResult {
  switch (criterion.type) {
    case "single_successful_run":
      return materializeSingle(existingRuns, "default");
    case "min_runs":
      return materializeMinRuns(criterion.count, existingRuns);
    case "all_seeds_complete":
      return materializeSeeds(criterion.seeds, existingRuns);
    case "all_conditions_complete":
      return materializeConditions(criterion.conditions, existingRuns);
    case "comparison_against":
      if (criterion.matchBy === "seed") {
        return materializeSeeds(criterion.seeds, existingRuns);
      }
      return materializeSingle(existingRuns, "default");
    default:
      return { action: "reject", reason: "Unknown criterion type" };
  }
}

function materializeSingle(runs: ExistingRun[], key: string): MaterializationResult {
  const existing = findByRunKey(runs, key);
  if (!existing) return { action: "create", runKey: key };
  if (existing.state === "DONE" && existing.resultId) return { action: "reject", reason: "Intent is already satisfied." };
  if (REOPENABLE.has(existing.state)) return { action: "reopen", existingRunId: existing.id, runKey: key };
  return { action: "reject", reason: `Run already in progress (state: ${existing.state}).` };
}

function materializeMinRuns(count: number, runs: ExistingRun[]): MaterializationResult {
  const doneCount = runs.filter((r) => r.state === "DONE" && r.resultId).length;
  if (doneCount >= count) return { action: "reject", reason: `Intent is already satisfied (${doneCount}/${count} DONE).` };

  const reopenable = runs.find((r) => REOPENABLE.has(r.state));
  if (reopenable) return { action: "reopen", existingRunId: reopenable.id, runKey: reopenable.runKey || `run_${runs.length + 1}` };

  const inFlight = runs.filter((r) => !TERMINAL.has(r.state));
  if (inFlight.length > 0) return { action: "reject", reason: `Run already in progress (${inFlight.length} in-flight).` };

  return { action: "create", runKey: `run_${runs.length + 1}` };
}

function materializeSeeds(seeds: number[], runs: ExistingRun[]): MaterializationResult {
  const doneSeedSet = new Set(
    runs.filter((r) => r.state === "DONE" && r.resultId).map((r) => r.seed).filter((s): s is number => s !== null),
  );
  if (seeds.every((s) => doneSeedSet.has(s))) return { action: "reject", reason: "All seeds are already covered." };

  for (const seed of seeds) {
    if (doneSeedSet.has(seed)) continue;
    const key = `seed=${seed}`;
    const existing = findByRunKey(runs, key);
    if (!existing) return { action: "create", runKey: key, seed };
    if (REOPENABLE.has(existing.state)) return { action: "reopen", existingRunId: existing.id, runKey: key };
    if (!TERMINAL.has(existing.state)) continue;
  }

  return { action: "reject", reason: "All uncovered seeds have runs in progress." };
}

function materializeConditions(conditions: string[], runs: ExistingRun[]): MaterializationResult {
  const doneCondSet = new Set(
    runs.filter((r) => r.state === "DONE" && r.resultId).map((r) => r.condition).filter((c): c is string => c !== null),
  );
  if (conditions.every((c) => doneCondSet.has(c))) return { action: "reject", reason: "All conditions are already covered." };

  for (const condition of conditions) {
    if (doneCondSet.has(condition)) continue;
    const key = `condition=${condition}`;
    const existing = findByRunKey(runs, key);
    if (!existing) return { action: "create", runKey: key, condition };
    if (REOPENABLE.has(existing.state)) return { action: "reopen", existingRunId: existing.id, runKey: key };
    if (!TERMINAL.has(existing.state)) continue;
  }

  return { action: "reject", reason: "All uncovered conditions have runs in progress." };
}

export type { ExistingRun, MaterializationResult };
