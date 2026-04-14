# FSM v2 Plan B: Intent & Run Lifecycle

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the ExperimentIntent lifecycle (`create_intent` / `run_experiment({ intent_id })` tools), the ExperimentRun-as-authority model with reconciler, and the run materialization rules — so experiments flow through intent→run→attempt→result with no ad-hoc argument passing.

**Architecture:** ExperimentIntent is the design artifact created in DESIGN state. `run_experiment({ intent_id })` materializes runs per the intent's completion criterion. The reconciler bridges RemoteJob adapter state to ExperimentRun lifecycle state. All state flows upward: RemoteJob → ExperimentAttempt → ExperimentRun → ExperimentIntent → Project FSM.

**Tech Stack:** TypeScript, Prisma (SQLite), Vitest, Zod

**Spec:** `docs/superpowers/specs/2026-04-13-research-lifecycle-fsm-v2.md` — Sections 1 (Intent), 2 (Run/Attempt/Job hierarchy)

**Depends on:** Plan A (vocabulary freeze + schema additions)

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/lib/research/fsm/intent-lifecycle.ts` | ExperimentIntent FSM: create, validate (DRAFT→READY), evaluate completion criterion, transition states |
| `src/lib/research/fsm/run-materializer.ts` | Materialization rules: given an intent + criterion, determine the next runKey, create or reopen a run |
| `src/lib/research/fsm/run-reconciler.ts` | Bridge adapter state to lifecycle: read RemoteJob/ExperimentAttempt, transition ExperimentRun, evaluate intent completion |
| `src/lib/research/fsm/__tests__/intent-lifecycle.test.ts` | Tests for intent creation, validation, completion evaluation |
| `src/lib/research/fsm/__tests__/run-materializer.test.ts` | Tests for materialization rules, retry logic, runKey generation |

### Modified Files

| File | Changes |
|------|---------|
| `src/lib/research/agent.ts` | Replace `run_experiment` free-form args with `{ intent_id }`. Add `create_intent` tool in DESIGN. Add `run_infrastructure` as cross-cutting. |
| `src/lib/research/fsm/tool-sets.ts` | Add `create_intent` to DESIGN. Replace `run_experiment` args. Add `run_infrastructure` to cross-cutting. |
| `src/lib/research/fsm/project-fsm.ts` | Update DESIGN→EXECUTION guard to check for READY intents. Update EXECUTION→ANALYSIS guard to check for SATISFIED intents. |
| `src/lib/research/fsm/transition-engine.ts` | Update guard context fetching for new intent-based guards. |

---

## Task 1: Intent Lifecycle Module

**Files:**
- Create: `src/lib/research/fsm/intent-lifecycle.ts`
- Create: `src/lib/research/fsm/__tests__/intent-lifecycle.test.ts`

- [ ] **Step 1: Write failing tests for intent creation and validation**

```typescript
// src/lib/research/fsm/__tests__/intent-lifecycle.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    experimentIntent: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    researchHypothesis: { findUnique: vi.fn() },
    approachBranch: { findUnique: vi.fn() },
    researchProject: { findUnique: vi.fn() },
    researchLogEntry: { findFirst: vi.fn() },
  },
}));

import { validateIntentToReady, evaluateCompletionCriterion } from "../intent-lifecycle";
import type { CompletionCriterion } from "../enums";

describe("validateIntentToReady", () => {
  it("fails if hypothesis does not exist", async () => {
    const { prisma } = await import("@/lib/prisma");
    (prisma.researchHypothesis.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await validateIntentToReady({
      hypothesisId: "hyp_missing",
      approachId: "app_1",
      projectId: "proj_1",
      scriptName: "exp_001.py",
      scriptContent: "print('hello')",
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("hypothesis");
  });
});

describe("evaluateCompletionCriterion", () => {
  it("single_successful_run: satisfied with 1 DONE run", () => {
    const criterion: CompletionCriterion = { type: "single_successful_run" };
    const runs = [{ state: "DONE", runKey: "default", resultId: "r1" }];
    const result = evaluateCompletionCriterion(criterion, runs);
    expect(result.satisfied).toBe(true);
  });

  it("single_successful_run: not satisfied with 0 DONE runs", () => {
    const criterion: CompletionCriterion = { type: "single_successful_run" };
    const runs = [{ state: "FAILED", runKey: "default", resultId: null }];
    const result = evaluateCompletionCriterion(criterion, runs);
    expect(result.satisfied).toBe(false);
  });

  it("all_seeds_complete: satisfied when all seeds have DONE runs", () => {
    const criterion: CompletionCriterion = { type: "all_seeds_complete", seeds: [42, 123] };
    const runs = [
      { state: "DONE", runKey: "seed=42", resultId: "r1", seed: 42 },
      { state: "DONE", runKey: "seed=123", resultId: "r2", seed: 123 },
    ];
    const result = evaluateCompletionCriterion(criterion, runs);
    expect(result.satisfied).toBe(true);
  });

  it("all_seeds_complete: not satisfied with missing seed", () => {
    const criterion: CompletionCriterion = { type: "all_seeds_complete", seeds: [42, 123, 456] };
    const runs = [
      { state: "DONE", runKey: "seed=42", resultId: "r1", seed: 42 },
      { state: "FAILED", runKey: "seed=123", resultId: null, seed: 123 },
    ];
    const result = evaluateCompletionCriterion(criterion, runs);
    expect(result.satisfied).toBe(false);
  });

  it("min_runs: satisfied when enough DONE runs exist", () => {
    const criterion: CompletionCriterion = { type: "min_runs", count: 3 };
    const runs = [
      { state: "DONE", runKey: "run_1", resultId: "r1" },
      { state: "DONE", runKey: "run_2", resultId: "r2" },
      { state: "DONE", runKey: "run_3", resultId: "r3" },
    ];
    const result = evaluateCompletionCriterion(criterion, runs);
    expect(result.satisfied).toBe(true);
  });

  it("min_runs: not satisfied with insufficient DONE runs", () => {
    const criterion: CompletionCriterion = { type: "min_runs", count: 3 };
    const runs = [
      { state: "DONE", runKey: "run_1", resultId: "r1" },
      { state: "FAILED", runKey: "run_2", resultId: null },
    ];
    const result = evaluateCompletionCriterion(criterion, runs);
    expect(result.satisfied).toBe(false);
  });

  it("reports all_terminal when every run is in a terminal state", () => {
    const criterion: CompletionCriterion = { type: "min_runs", count: 3 };
    const runs = [
      { state: "DONE", runKey: "run_1", resultId: "r1" },
      { state: "FAILED", runKey: "run_2", resultId: null },
    ];
    const result = evaluateCompletionCriterion(criterion, runs);
    expect(result.allTerminal).toBe(true);
    expect(result.satisfied).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/research/fsm/__tests__/intent-lifecycle.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Implement intent-lifecycle.ts**

```typescript
// src/lib/research/fsm/intent-lifecycle.ts
import { prisma } from "@/lib/prisma";
import { createHash } from "crypto";
import {
  type CompletionCriterion,
  type IntentLifecycleState,
  INTENT_TERMINAL_STATES,
  RUN_TERMINAL_STATES,
} from "./enums";
import { getEvaluationProtocol } from "../evaluation-protocol";

// ── Validation ──────────────────────────────────────────────────

interface ValidationInput {
  hypothesisId: string;
  approachId: string;
  projectId: string;
  scriptName: string;
  scriptContent: string;
}

interface ValidationResult {
  valid: boolean;
  reason?: string;
  scriptHash?: string;
  protocolId?: string;
  protocolHash?: string;
}

export async function validateIntentToReady(input: ValidationInput): Promise<ValidationResult> {
  const [hypothesis, approach, protocol] = await Promise.all([
    prisma.researchHypothesis.findUnique({ where: { id: input.hypothesisId }, select: { id: true } }),
    prisma.approachBranch.findUnique({ where: { id: input.approachId }, select: { id: true } }),
    getEvaluationProtocol(input.projectId),
  ]);

  if (!hypothesis) return { valid: false, reason: `Hypothesis ${input.hypothesisId} does not exist.` };
  if (!approach) return { valid: false, reason: `Approach ${input.approachId} does not exist.` };
  if (!protocol) return { valid: false, reason: "No evaluation protocol defined for this project." };

  const scriptHash = createHash("sha256").update(input.scriptContent).digest("hex");
  const protocolHash = createHash("sha256")
    .update(JSON.stringify(protocol.protocol))
    .digest("hex");

  return {
    valid: true,
    scriptHash,
    protocolId: protocol.id,
    protocolHash,
  };
}

// ── Completion criterion evaluation ─────────────────────────────

interface RunSummary {
  state: string;
  runKey: string | null;
  resultId: string | null;
  seed?: number | null;
  condition?: string | null;
}

interface CriterionResult {
  satisfied: boolean;
  allTerminal: boolean;
  doneCount: number;
  totalCount: number;
  detail: string;
}

export function evaluateCompletionCriterion(
  criterion: CompletionCriterion,
  runs: RunSummary[],
): CriterionResult {
  const doneRuns = runs.filter((r) => r.state === "DONE" && r.resultId);
  const terminalRuns = runs.filter((r) =>
    (RUN_TERMINAL_STATES as readonly string[]).includes(r.state),
  );
  const allTerminal = runs.length > 0 && terminalRuns.length === runs.length;
  const doneCount = doneRuns.length;

  switch (criterion.type) {
    case "single_successful_run": {
      return {
        satisfied: doneCount >= 1,
        allTerminal,
        doneCount,
        totalCount: runs.length,
        detail: doneCount >= 1
          ? `1 DONE run (criterion met)`
          : `0 DONE runs of ${runs.length} total`,
      };
    }
    case "min_runs": {
      return {
        satisfied: doneCount >= criterion.count,
        allTerminal,
        doneCount,
        totalCount: runs.length,
        detail: `${doneCount}/${criterion.count} DONE runs`,
      };
    }
    case "all_seeds_complete": {
      const doneSeedSet = new Set(
        doneRuns
          .map((r) => r.seed ?? (r.runKey?.match(/seed=(\d+)/)?.[1] ? Number(r.runKey.match(/seed=(\d+)/)![1]) : null))
          .filter((s): s is number => s !== null),
      );
      const allSeedsCovered = criterion.seeds.every((s) => doneSeedSet.has(s));
      return {
        satisfied: allSeedsCovered,
        allTerminal,
        doneCount,
        totalCount: runs.length,
        detail: allSeedsCovered
          ? `All ${criterion.seeds.length} seeds complete`
          : `${doneSeedSet.size}/${criterion.seeds.length} seeds complete`,
      };
    }
    case "all_conditions_complete": {
      const doneConditionSet = new Set(
        doneRuns
          .map((r) => r.condition ?? r.runKey?.match(/condition=(.+)/)?.[1])
          .filter((c): c is string => c !== null && c !== undefined),
      );
      const allConditionsCovered = criterion.conditions.every((c) => doneConditionSet.has(c));
      return {
        satisfied: allConditionsCovered,
        allTerminal,
        doneCount,
        totalCount: runs.length,
        detail: allConditionsCovered
          ? `All ${criterion.conditions.length} conditions complete`
          : `${doneConditionSet.size}/${criterion.conditions.length} conditions complete`,
      };
    }
    case "comparison_against": {
      // For comparison, we just check this intent's runs are done.
      // The cross-intent pairing check happens at a higher level.
      if (criterion.matchBy === "seed") {
        const doneSeedSet = new Set(
          doneRuns
            .map((r) => r.seed ?? (r.runKey?.match(/seed=(\d+)/)?.[1] ? Number(r.runKey.match(/seed=(\d+)/)![1]) : null))
            .filter((s): s is number => s !== null),
        );
        const allSeedsCovered = criterion.seeds.every((s) => doneSeedSet.has(s));
        return {
          satisfied: allSeedsCovered,
          allTerminal,
          doneCount,
          totalCount: runs.length,
          detail: allSeedsCovered
            ? `All ${criterion.seeds.length} comparison seeds complete`
            : `${doneSeedSet.size}/${criterion.seeds.length} comparison seeds complete`,
        };
      }
      // matchBy: "runKey" — single run
      return {
        satisfied: doneCount >= 1,
        allTerminal,
        doneCount,
        totalCount: runs.length,
        detail: doneCount >= 1
          ? `Comparison run complete`
          : `No DONE comparison run yet`,
      };
    }
    default:
      return { satisfied: false, allTerminal, doneCount, totalCount: runs.length, detail: "Unknown criterion type" };
  }
}

// ── Intent state derivation ─────────────────────────────────────

export function deriveIntentState(
  currentStatus: IntentLifecycleState,
  criterion: CompletionCriterion,
  runs: RunSummary[],
): IntentLifecycleState {
  // Terminal states are sticky
  if ((INTENT_TERMINAL_STATES as readonly string[]).includes(currentStatus)) {
    return currentStatus;
  }

  // No runs yet
  if (runs.length === 0) {
    return currentStatus === "DRAFT" ? "DRAFT" : "READY";
  }

  // Has non-terminal runs → ACTIVE
  const hasNonTerminal = runs.some(
    (r) => !(RUN_TERMINAL_STATES as readonly string[]).includes(r.state),
  );
  if (hasNonTerminal) return "ACTIVE";

  // All runs terminal — evaluate criterion
  const evaluation = evaluateCompletionCriterion(criterion, runs);
  if (evaluation.satisfied) return "SATISFIED";
  return "EXHAUSTED";
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/research/fsm/__tests__/intent-lifecycle.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Stage and commit**

```bash
git add src/lib/research/fsm/intent-lifecycle.ts src/lib/research/fsm/__tests__/intent-lifecycle.test.ts
git commit -m "feat(fsm-v2): intent lifecycle — validation, completion criterion evaluation, state derivation"
```

---

## Task 2: Run Materializer

**Files:**
- Create: `src/lib/research/fsm/run-materializer.ts`
- Create: `src/lib/research/fsm/__tests__/run-materializer.test.ts`

- [ ] **Step 1: Write failing tests for materialization rules**

```typescript
// src/lib/research/fsm/__tests__/run-materializer.test.ts
import { describe, it, expect } from "vitest";
import { determineNextRun } from "../run-materializer";
import type { CompletionCriterion } from "../enums";

interface ExistingRun {
  id: string;
  state: string;
  runKey: string | null;
  seed: number | null;
  condition: string | null;
  resultId: string | null;
}

describe("determineNextRun", () => {
  it("single_successful_run: creates default run when none exists", () => {
    const criterion: CompletionCriterion = { type: "single_successful_run" };
    const result = determineNextRun(criterion, []);
    expect(result.action).toBe("create");
    expect(result.runKey).toBe("default");
  });

  it("single_successful_run: reopens FAILED run", () => {
    const criterion: CompletionCriterion = { type: "single_successful_run" };
    const existing: ExistingRun[] = [
      { id: "run_1", state: "FAILED", runKey: "default", seed: null, condition: null, resultId: null },
    ];
    const result = determineNextRun(criterion, existing);
    expect(result.action).toBe("reopen");
    expect(result.existingRunId).toBe("run_1");
  });

  it("single_successful_run: rejects when run is in-flight", () => {
    const criterion: CompletionCriterion = { type: "single_successful_run" };
    const existing: ExistingRun[] = [
      { id: "run_1", state: "RUNNING", runKey: "default", seed: null, condition: null, resultId: null },
    ];
    const result = determineNextRun(criterion, existing);
    expect(result.action).toBe("reject");
  });

  it("single_successful_run: rejects when already DONE", () => {
    const criterion: CompletionCriterion = { type: "single_successful_run" };
    const existing: ExistingRun[] = [
      { id: "run_1", state: "DONE", runKey: "default", seed: null, condition: null, resultId: "r1" },
    ];
    const result = determineNextRun(criterion, existing);
    expect(result.action).toBe("reject");
    expect(result.reason).toContain("satisfied");
  });

  it("all_seeds_complete: targets first uncovered seed", () => {
    const criterion: CompletionCriterion = { type: "all_seeds_complete", seeds: [42, 123, 456] };
    const existing: ExistingRun[] = [
      { id: "run_1", state: "DONE", runKey: "seed=42", seed: 42, condition: null, resultId: "r1" },
    ];
    const result = determineNextRun(criterion, existing);
    expect(result.action).toBe("create");
    expect(result.runKey).toBe("seed=123");
    expect(result.seed).toBe(123);
  });

  it("all_seeds_complete: reopens FAILED seed run", () => {
    const criterion: CompletionCriterion = { type: "all_seeds_complete", seeds: [42, 123] };
    const existing: ExistingRun[] = [
      { id: "run_1", state: "DONE", runKey: "seed=42", seed: 42, condition: null, resultId: "r1" },
      { id: "run_2", state: "FAILED", runKey: "seed=123", seed: 123, condition: null, resultId: null },
    ];
    const result = determineNextRun(criterion, existing);
    expect(result.action).toBe("reopen");
    expect(result.existingRunId).toBe("run_2");
  });

  it("min_runs: reopens FAILED before creating new", () => {
    const criterion: CompletionCriterion = { type: "min_runs", count: 3 };
    const existing: ExistingRun[] = [
      { id: "run_1", state: "DONE", runKey: "run_1", seed: null, condition: null, resultId: "r1" },
      { id: "run_2", state: "FAILED", runKey: "run_2", seed: null, condition: null, resultId: null },
      { id: "run_3", state: "DONE", runKey: "run_3", seed: null, condition: null, resultId: "r3" },
    ];
    const result = determineNextRun(criterion, existing);
    expect(result.action).toBe("reopen");
    expect(result.existingRunId).toBe("run_2");
  });

  it("min_runs: creates new when no FAILED exist", () => {
    const criterion: CompletionCriterion = { type: "min_runs", count: 3 };
    const existing: ExistingRun[] = [
      { id: "run_1", state: "DONE", runKey: "run_1", seed: null, condition: null, resultId: "r1" },
    ];
    const result = determineNextRun(criterion, existing);
    expect(result.action).toBe("create");
    expect(result.runKey).toBe("run_2");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/research/fsm/__tests__/run-materializer.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement run-materializer.ts**

```typescript
// src/lib/research/fsm/run-materializer.ts
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
  | { action: "create"; runKey: string; seed?: number; condition?: string; reason?: string }
  | { action: "reopen"; existingRunId: string; runKey: string; reason?: string }
  | { action: "reject"; reason: string };

const TERMINAL = new Set(["DONE", "FAILED", "CANCELLED"]);
const REOPENABLE = new Set(["FAILED", "CANCELLED"]);

function findReopenable(runs: ExistingRun[]): ExistingRun | null {
  return runs.find((r) => REOPENABLE.has(r.state)) || null;
}

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
  if (!existing) {
    return { action: "create", runKey: key };
  }
  if (existing.state === "DONE" && existing.resultId) {
    return { action: "reject", reason: "Intent is already satisfied." };
  }
  if (REOPENABLE.has(existing.state)) {
    return { action: "reopen", existingRunId: existing.id, runKey: key };
  }
  // In-flight
  return { action: "reject", reason: `Run already in progress (state: ${existing.state}).` };
}

function materializeMinRuns(count: number, runs: ExistingRun[]): MaterializationResult {
  const doneCount = runs.filter((r) => r.state === "DONE" && r.resultId).length;
  if (doneCount >= count) {
    return { action: "reject", reason: `Intent is already satisfied (${doneCount}/${count} DONE).` };
  }

  // Priority: reopen FAILED/CANCELLED before creating new
  const reopenable = findReopenable(runs);
  if (reopenable) {
    return { action: "reopen", existingRunId: reopenable.id, runKey: reopenable.runKey || `run_${runs.length + 1}` };
  }

  // Check for in-flight runs
  const inFlight = runs.filter((r) => !TERMINAL.has(r.state));
  if (inFlight.length > 0) {
    return { action: "reject", reason: `Run already in progress (${inFlight.length} in-flight).` };
  }

  return { action: "create", runKey: `run_${runs.length + 1}` };
}

function materializeSeeds(seeds: number[], runs: ExistingRun[]): MaterializationResult {
  const doneSeedSet = new Set(
    runs.filter((r) => r.state === "DONE" && r.resultId)
      .map((r) => r.seed)
      .filter((s): s is number => s !== null),
  );

  if (seeds.every((s) => doneSeedSet.has(s))) {
    return { action: "reject", reason: "All seeds are already covered." };
  }

  // Find first uncovered seed
  for (const seed of seeds) {
    if (doneSeedSet.has(seed)) continue;

    const key = `seed=${seed}`;
    const existing = findByRunKey(runs, key);

    if (!existing) {
      return { action: "create", runKey: key, seed };
    }
    if (REOPENABLE.has(existing.state)) {
      return { action: "reopen", existingRunId: existing.id, runKey: key };
    }
    if (!TERMINAL.has(existing.state)) {
      // In-flight for this seed — skip to next uncovered seed
      continue;
    }
  }

  // All uncovered seeds have in-flight runs
  return { action: "reject", reason: "All uncovered seeds have runs in progress." };
}

function materializeConditions(conditions: string[], runs: ExistingRun[]): MaterializationResult {
  const doneConditionSet = new Set(
    runs.filter((r) => r.state === "DONE" && r.resultId)
      .map((r) => r.condition)
      .filter((c): c is string => c !== null),
  );

  if (conditions.every((c) => doneConditionSet.has(c))) {
    return { action: "reject", reason: "All conditions are already covered." };
  }

  for (const condition of conditions) {
    if (doneConditionSet.has(condition)) continue;

    const key = `condition=${condition}`;
    const existing = findByRunKey(runs, key);

    if (!existing) {
      return { action: "create", runKey: key, condition };
    }
    if (REOPENABLE.has(existing.state)) {
      return { action: "reopen", existingRunId: existing.id, runKey: key };
    }
    if (!TERMINAL.has(existing.state)) {
      continue;
    }
  }

  return { action: "reject", reason: "All uncovered conditions have runs in progress." };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/research/fsm/__tests__/run-materializer.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Stage and commit**

```bash
git add src/lib/research/fsm/run-materializer.ts src/lib/research/fsm/__tests__/run-materializer.test.ts
git commit -m "feat(fsm-v2): run materializer — deterministic run creation and retry rules per criterion type"
```

---

## Task 3: Update Project FSM Guards for Intents

**Files:**
- Modify: `src/lib/research/fsm/project-fsm.ts`
- Modify: `src/lib/research/fsm/transition-engine.ts`

- [ ] **Step 1: Update DesignToExecutionContext to check intents**

In `project-fsm.ts`, update the `DesignToExecutionContext` interface:

```typescript
export interface DesignToExecutionContext {
  metricSchemaDefined: boolean;
  evaluationProtocolExists: boolean;
  activeHypothesisCount: number;
  readyIntentCount: number;  // NEW: intents in READY state
}
```

Add `ready_intents` check in the guard:

```typescript
checks["ready_intents"] = {
  passed: ctx.readyIntentCount > 0,
  detail: ctx.readyIntentCount > 0
    ? `${ctx.readyIntentCount} intents ready for execution`
    : "No intents in READY state — create intents in DESIGN first",
};
```

- [ ] **Step 2: Update ExecutionToAnalysisContext to check satisfied intents**

```typescript
export interface ExecutionToAnalysisContext {
  doneRunCount: number;
  doneNonSmokeRunCount: number;
  newDoneNonSmokeRunCount: number;
  satisfiedIntentCount: number;  // NEW
}
```

Replace or add to the guard:

```typescript
checks["satisfied_intent"] = {
  passed: ctx.satisfiedIntentCount > 0,
  detail: ctx.satisfiedIntentCount > 0
    ? `${ctx.satisfiedIntentCount} intents satisfied with results`
    : "No intents satisfied yet — experiments need to complete successfully",
};
```

- [ ] **Step 3: Update transition-engine.ts guard context fetching**

In `fetchGuardContext`, update the `DESIGN->EXECUTION` case to query intent count:

```typescript
const readyIntentCount = await prisma.experimentIntent.count({
  where: { projectId, status: "READY" },
});
```

Update the `EXECUTION->ANALYSIS` case to query satisfied intents:

```typescript
const satisfiedIntentCount = await prisma.experimentIntent.count({
  where: { projectId, status: "SATISFIED" },
});
```

- [ ] **Step 4: Run all tests**

Run: `npx vitest run src/lib/research/fsm/__tests__/`
Expected: All tests pass. Some existing tests may need updating if they used the old context shape — update them to include the new fields.

- [ ] **Step 5: Type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Stage and commit**

```bash
git add src/lib/research/fsm/project-fsm.ts src/lib/research/fsm/transition-engine.ts src/lib/research/fsm/__tests__/project-fsm.test.ts
git commit -m "feat(fsm-v2): update project FSM guards — DESIGN→EXECUTION requires READY intents, EXECUTION→ANALYSIS requires SATISFIED intents"
```

---

## Task 4: Update Tool Sets and Add create_intent / run_infrastructure

**Files:**
- Modify: `src/lib/research/fsm/tool-sets.ts`

- [ ] **Step 1: Add new tools to state-specific sets**

In `tool-sets.ts`:

Add to DESIGN:
```typescript
"create_intent",
```

Add to EXECUTION (already has `run_experiment`):
```typescript
// run_experiment stays — it now takes { intent_id }
```

Add `run_infrastructure` to CROSS_CUTTING_TOOLS:
```typescript
"run_infrastructure",
```

- [ ] **Step 2: Run invariant tests**

Run: `npx vitest run src/lib/research/fsm/__tests__/invariants.test.ts`
Expected: If `create_intent` is defined in agent.ts, the tool-set completeness test catches it. Since we haven't added the tool to agent.ts yet, this may need the tool definition added in Plan B's agent.ts integration task.

For now, just add it to tool-sets.ts and verify existing tests pass.

- [ ] **Step 3: Stage and commit**

```bash
git add src/lib/research/fsm/tool-sets.ts
git commit -m "feat(fsm-v2): add create_intent to DESIGN tools, run_infrastructure to cross-cutting"
```

---

## Task 5: Run Reconciler

**Files:**
- Create: `src/lib/research/fsm/run-reconciler.ts`

- [ ] **Step 1: Implement the reconciler**

```typescript
// src/lib/research/fsm/run-reconciler.ts
//
// Bridges adapter state (RemoteJob) to lifecycle state (ExperimentRun).
// The ONLY code that writes to ExperimentRun.state.

import { prisma } from "@/lib/prisma";
import { withFsmBypassAsync } from "./state-guard";
import type { RunLifecycleState } from "./enums";
import { RUN_TERMINAL_STATES } from "./enums";
import { evaluateCompletionCriterion, deriveIntentState } from "./intent-lifecycle";
import type { CompletionCriterion } from "./enums";

/**
 * Reconcile a single run's state from its latest attempt/job data.
 * Called by the remote executor after job status changes.
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
      // Attempt finished
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
          failureClass: newState === "FAILED" ? latestAttempt?.failureClass : undefined,
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
          resultId: true,
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

  const newState = deriveIntentState(
    intent.status as any,
    criterion,
    intent.runs,
  );

  if (newState !== intent.status) {
    await prisma.experimentIntent.update({
      where: { id: intentId },
      data: { status: newState },
    });
  }
}
```

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Stage and commit**

```bash
git add src/lib/research/fsm/run-reconciler.ts
git commit -m "feat(fsm-v2): run reconciler — bridges adapter state to lifecycle, evaluates intent completion"
```

---

## Post-Plan B Verification

After all 5 tasks:

- [ ] Run: `npx vitest run src/lib/research/fsm/__tests__/`
- [ ] Run: `npx tsc --noEmit`
- [ ] Verify: intent-lifecycle has tests for all criterion types
- [ ] Verify: run-materializer has tests for create/reopen/reject
- [ ] Verify: project-fsm guards check intents
- [ ] Verify: tool-sets include create_intent and run_infrastructure

Plan C (invariant engine, "why" layer, DECISION guards, approach ownership) will follow.
