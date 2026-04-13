# Research Lifecycle FSM Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the reactive phase-gate system with three orthogonal FSMs (Project, Run, Hypothesis) that proactively drive research progression, eliminating the 95% agent failure rate caused by gate-discovery loops.

**Architecture:** Three independent state machines with a shared transition engine. The Project FSM owns research progression (DISCOVERY -> HYPOTHESIS -> DESIGN -> EXECUTION -> ANALYSIS -> DECISION). Guards are evaluated on relevant DB writes; auto-transitions fire when guards are satisfied. Tool availability is derived from FSM state, not a global restriction map.

**Tech Stack:** TypeScript, Prisma (SQLite), Zod for schemas, Vitest for tests

**Spec:** `docs/superpowers/specs/2026-04-12-research-lifecycle-fsm.md`

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/lib/research/fsm/types.ts` | Shared FSM type definitions (states, transitions, guards, overlays) |
| `src/lib/research/fsm/project-fsm.ts` | Project FSM: state definitions, guard evaluators, transition table |
| `src/lib/research/fsm/run-fsm.ts` | Run FSM: per-experiment lifecycle states, failure classification |
| `src/lib/research/fsm/hypothesis-fsm.ts` | Hypothesis FSM: evidence progression states and transitions |
| `src/lib/research/fsm/transition-engine.ts` | Evaluates guards, fires auto-transitions, persists TransitionRecords |
| `src/lib/research/fsm/tool-sets.ts` | Maps each project state to its available tool subset |
| `src/lib/research/fsm/design-auto-resolve.ts` | Auto-creates evaluation protocol from defined metrics in DESIGN state |
| `src/lib/research/fsm/__tests__/project-fsm.test.ts` | Tests for project FSM guards and transitions |
| `src/lib/research/fsm/__tests__/transition-engine.test.ts` | Tests for auto-transition logic |
| `src/lib/research/fsm/__tests__/tool-sets.test.ts` | Tests for tool filtering by state |
| `prisma/migrations/YYYYMMDD_fsm_transition_records/migration.sql` | Schema migration |

### Modified Files

| File | Changes |
|------|---------|
| `prisma/schema.prisma` | Add `TransitionRecord` model, add `failureClass` to `RemoteJob`, update `currentPhase` comment |
| `src/lib/research/agent.ts` | Remove `checkPhaseGate`, `PHASE_RESTRICTED_TOOLS`, `advance_phase` tool, `autoAdvanceExperimentPhaseIfNeeded`. Replace tool filtering in `createTools`. Update system prompt. |
| `src/lib/research/submission-readiness.ts` | Simplify to Run FSM guard (remove phase checks, evaluation protocol gate). Keep workspace-busy and hypothesis-resolution logic. |
| `src/lib/research/research-state.ts` | Generate from FSM state name instead of legacy phase |
| `src/lib/research/evaluation-protocol.ts` | Export `deriveDefaultProtocol` for DESIGN auto-resolution |
| `src/lib/research/context-builder.ts` | Read FSM state instead of `currentPhase` string |

### Deleted Files / Dead Code

| Location | What |
|----------|------|
| `agent.ts:163-166` | `PHASE_RESTRICTED_TOOLS` map |
| `agent.ts:168-294` | `checkPhaseGate` function |
| `agent.ts:2941-2960` | `autoAdvanceExperimentPhaseIfNeeded` function |
| `agent.ts:3200-3228` | `advance_phase` tool |
| `agent.ts:2336-2350` | Phase-Gated Workflow system prompt section |
| `agent.ts:1511-1519` | Phase gate enforcement in tool wrapper |
| `submission-readiness.ts:235-239` | `EVALUATION_PROTOCOL` issue code and check |
| `submission-readiness.ts:287-299` | Phase-based blocking and auto-advance eligibility |

---

## Task 1: FSM Type Definitions

**Files:**
- Create: `src/lib/research/fsm/types.ts`
- Test: `src/lib/research/fsm/__tests__/project-fsm.test.ts` (initial structure)

- [ ] **Step 1: Write type definition file**

```typescript
// src/lib/research/fsm/types.ts

// ── Project FSM ─────────────────────────────────────────────────

export const PROJECT_STATES = [
  "DISCOVERY",
  "HYPOTHESIS",
  "DESIGN",
  "EXECUTION",
  "ANALYSIS",
  "DECISION",
  "COMPLETE",
] as const;

export type ProjectState = (typeof PROJECT_STATES)[number];

export const PROJECT_TRANSITIONS: Record<ProjectState, readonly ProjectState[]> = {
  DISCOVERY: ["HYPOTHESIS"],
  HYPOTHESIS: ["DESIGN", "DISCOVERY"],
  DESIGN: ["EXECUTION", "HYPOTHESIS"],
  EXECUTION: ["ANALYSIS"],
  ANALYSIS: ["DECISION"],
  DECISION: ["DESIGN", "HYPOTHESIS", "COMPLETE"],
  COMPLETE: [],
};

// ── Run FSM ─────────────────────────────────────────────────────

export const RUN_STATES = [
  "DRAFT",
  "READY",
  "QUEUED",
  "RUNNING",
  "IMPORTING",
  "DONE",
  "FAILED",
  "CANCELLED",
] as const;

export type RunState = (typeof RUN_STATES)[number];

export type FailureClass = "INFRA" | "CODE" | "POLICY" | "VALIDATION" | "IMPORT";

export const RUN_TERMINAL_STATES: readonly RunState[] = ["DONE", "FAILED", "CANCELLED"];

// ── Hypothesis FSM ──────────────────────────────────────────────

export const HYPOTHESIS_STATES = [
  "PROPOSED",
  "ACTIVE",
  "EVALUATING",
  "SUPPORTED",
  "CONTESTED",
  "REVISED",
  "RETIRED",
] as const;

export type HypothesisState = (typeof HYPOTHESIS_STATES)[number];

export const HYPOTHESIS_TERMINAL_STATES: readonly HypothesisState[] = [
  "SUPPORTED",
  "CONTESTED",
  "REVISED",
  "RETIRED",
];

// ── Operational Overlays ────────────────────────────────────────

export const OPERATIONAL_STATUSES = [
  "ACTIVE",
  "PAUSED",
  "BLOCKED",
  "FAILED",
  "ARCHIVED",
] as const;

export type OperationalStatus = (typeof OPERATIONAL_STATUSES)[number];

// ── Transition Records ──────────────────────────────────────────

export interface TransitionRecord {
  projectId: string;
  domain: "project" | "run" | "hypothesis";
  entityId: string;          // projectId, runId, or hypothesisId
  from: string;
  to: string;
  trigger: "auto" | "agent" | "user" | "system";
  basis: string;
  guardsEvaluated: Record<string, boolean>;
}

export interface DecisionRecord extends TransitionRecord {
  decisionType: "iterate" | "pivot" | "conclude";
  hypothesesConsidered: string[];
  evidenceSummary: string;
}

// ── Guard Result ────────────────────────────────────────────────

export interface GuardResult {
  satisfied: boolean;
  checks: Record<string, { passed: boolean; detail: string }>;
}
```

- [ ] **Step 2: Write smoke test for type consistency**

```typescript
// src/lib/research/fsm/__tests__/project-fsm.test.ts
import { describe, it, expect } from "vitest";
import {
  PROJECT_STATES,
  PROJECT_TRANSITIONS,
  RUN_STATES,
  RUN_TERMINAL_STATES,
  HYPOTHESIS_STATES,
  HYPOTHESIS_TERMINAL_STATES,
} from "../types";

describe("FSM type definitions", () => {
  it("every project state has a transition entry", () => {
    for (const state of PROJECT_STATES) {
      expect(PROJECT_TRANSITIONS).toHaveProperty(state);
    }
  });

  it("all transition targets are valid project states", () => {
    const stateSet = new Set<string>(PROJECT_STATES);
    for (const targets of Object.values(PROJECT_TRANSITIONS)) {
      for (const target of targets) {
        expect(stateSet.has(target)).toBe(true);
      }
    }
  });

  it("COMPLETE has no outgoing transitions", () => {
    expect(PROJECT_TRANSITIONS.COMPLETE).toEqual([]);
  });

  it("run terminal states are a subset of run states", () => {
    const stateSet = new Set<string>(RUN_STATES);
    for (const terminal of RUN_TERMINAL_STATES) {
      expect(stateSet.has(terminal)).toBe(true);
    }
  });

  it("hypothesis terminal states are a subset of hypothesis states", () => {
    const stateSet = new Set<string>(HYPOTHESIS_STATES);
    for (const terminal of HYPOTHESIS_TERMINAL_STATES) {
      expect(stateSet.has(terminal)).toBe(true);
    }
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/lib/research/fsm/__tests__/project-fsm.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 4: Commit**

```bash
git add src/lib/research/fsm/types.ts src/lib/research/fsm/__tests__/project-fsm.test.ts
git commit -m "feat(fsm): add type definitions for project, run, and hypothesis state machines"
```

---

## Task 2: Project FSM Guard Evaluators

**Files:**
- Create: `src/lib/research/fsm/project-fsm.ts`
- Test: `src/lib/research/fsm/__tests__/project-fsm.test.ts` (extend)

- [ ] **Step 1: Write failing tests for guard evaluators**

```typescript
// Add to src/lib/research/fsm/__tests__/project-fsm.test.ts
import { evaluateTransitionGuard } from "../project-fsm";
import type { GuardResult } from "../types";

// These tests use a mock DB context — see step 3 for the mock setup

describe("evaluateTransitionGuard", () => {
  it("DISCOVERY -> HYPOTHESIS: fails when paper count < 3 and no scout", async () => {
    const result = await evaluateTransitionGuard("test-project", "DISCOVERY", "HYPOTHESIS", {
      paperCount: 1,
      unprocessedPaperCount: 0,
      completedSynthesisCount: 0,
      scoutCount: 0,
    });
    expect(result.satisfied).toBe(false);
    expect(result.checks["papers_or_scout"].passed).toBe(false);
  });

  it("DISCOVERY -> HYPOTHESIS: passes with 3 papers + synthesis", async () => {
    const result = await evaluateTransitionGuard("test-project", "DISCOVERY", "HYPOTHESIS", {
      paperCount: 5,
      unprocessedPaperCount: 0,
      completedSynthesisCount: 1,
      scoutCount: 0,
    });
    expect(result.satisfied).toBe(true);
  });

  it("DESIGN -> EXECUTION: fails without evaluation protocol", async () => {
    const result = await evaluateTransitionGuard("test-project", "DESIGN", "EXECUTION", {
      metricSchemaDefined: true,
      evaluationProtocolExists: false,
      activeHypothesisCount: 1,
    });
    expect(result.satisfied).toBe(false);
    expect(result.checks["evaluation_protocol"].passed).toBe(false);
  });

  it("DESIGN -> EXECUTION: passes with metrics + protocol + active hypothesis", async () => {
    const result = await evaluateTransitionGuard("test-project", "DESIGN", "EXECUTION", {
      metricSchemaDefined: true,
      evaluationProtocolExists: true,
      activeHypothesisCount: 1,
    });
    expect(result.satisfied).toBe(true);
  });

  it("rejects transitions not in the transition table", async () => {
    const result = await evaluateTransitionGuard("test-project", "DISCOVERY", "EXECUTION", {});
    expect(result.satisfied).toBe(false);
    expect(result.checks["valid_transition"].passed).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/research/fsm/__tests__/project-fsm.test.ts`
Expected: FAIL — `evaluateTransitionGuard` not found

- [ ] **Step 3: Implement guard evaluators**

```typescript
// src/lib/research/fsm/project-fsm.ts
import type { ProjectState, GuardResult } from "./types";
import { PROJECT_TRANSITIONS } from "./types";

// ── Guard context types ─────────────────────────────────────────
// Each transition declares what data it needs. The caller fetches
// this from the DB and passes it in — guards are pure functions
// over the context, not DB-aware.

export interface DiscoveryToHypothesisContext {
  paperCount: number;
  unprocessedPaperCount: number;
  completedSynthesisCount: number;
  scoutCount: number;
}

export interface HypothesisToDesignContext {
  hypothesisCount: number;
  approachCount: number;
}

export interface DesignToExecutionContext {
  metricSchemaDefined: boolean;
  evaluationProtocolExists: boolean;
  activeHypothesisCount: number;
}

export interface ExecutionToAnalysisContext {
  doneRunCount: number;
}

export interface AnalysisToDecisionContext {
  updatedHypothesisCount: number;  // not PROPOSED, not ACTIVE
  claimCount: number;
  terminalHypothesisCount: number; // SUPPORTED | CONTESTED | REVISED | RETIRED
}

export interface DecisionToCompleteContext {
  activeOrEvaluatingHypothesisCount: number;
  openCoordinatorObligations: number;
  supportedOrRetiredCount: number;
}

export interface DecisionToDesignContext {
  viableHypothesisCount: number;        // ACTIVE or REVISED
  coordinatorRequiredExperiments: number;
}

export type GuardContext =
  | DiscoveryToHypothesisContext
  | HypothesisToDesignContext
  | DesignToExecutionContext
  | ExecutionToAnalysisContext
  | AnalysisToDecisionContext
  | DecisionToCompleteContext
  | DecisionToDesignContext
  | Record<string, unknown>;  // fallback for invalid transitions

// ── Guard evaluator ─────────────────────────────────────────────

export async function evaluateTransitionGuard(
  projectId: string,
  from: ProjectState,
  to: ProjectState,
  context: GuardContext,
): Promise<GuardResult> {
  const checks: Record<string, { passed: boolean; detail: string }> = {};

  // Check transition is valid in the transition table
  const validTargets = PROJECT_TRANSITIONS[from];
  if (!validTargets.includes(to)) {
    checks["valid_transition"] = {
      passed: false,
      detail: `${from} -> ${to} is not a valid transition. Valid targets: ${validTargets.join(", ") || "none"}`,
    };
    return { satisfied: false, checks };
  }
  checks["valid_transition"] = { passed: true, detail: `${from} -> ${to} is valid` };

  const key = `${from}->${to}`;
  switch (key) {
    case "DISCOVERY->HYPOTHESIS": {
      const ctx = context as DiscoveryToHypothesisContext;
      checks["papers_or_scout"] = {
        passed: ctx.paperCount >= 3 || ctx.scoutCount > 0,
        detail: `${ctx.paperCount} papers, ${ctx.scoutCount} scouts (need 3+ papers or 1+ scout)`,
      };
      checks["papers_processed"] = {
        passed: ctx.unprocessedPaperCount === 0,
        detail: ctx.unprocessedPaperCount === 0
          ? "All papers processed"
          : `${ctx.unprocessedPaperCount} papers still processing`,
      };
      checks["synthesis_completed"] = {
        passed: ctx.completedSynthesisCount > 0,
        detail: `${ctx.completedSynthesisCount} syntheses completed (need 1+)`,
      };
      break;
    }
    case "HYPOTHESIS->DESIGN": {
      const ctx = context as HypothesisToDesignContext;
      checks["has_hypothesis"] = {
        passed: ctx.hypothesisCount > 0,
        detail: `${ctx.hypothesisCount} hypotheses (need 1+)`,
      };
      checks["has_approach"] = {
        passed: ctx.approachCount > 0,
        detail: `${ctx.approachCount} approaches (need 1+)`,
      };
      break;
    }
    case "DESIGN->EXECUTION": {
      const ctx = context as DesignToExecutionContext;
      checks["metrics_defined"] = {
        passed: ctx.metricSchemaDefined,
        detail: ctx.metricSchemaDefined ? "Metrics defined" : "No metrics defined",
      };
      checks["evaluation_protocol"] = {
        passed: ctx.evaluationProtocolExists,
        detail: ctx.evaluationProtocolExists ? "Protocol exists" : "No evaluation protocol",
      };
      checks["active_hypothesis"] = {
        passed: ctx.activeHypothesisCount > 0,
        detail: `${ctx.activeHypothesisCount} active hypotheses (need 1+)`,
      };
      break;
    }
    case "EXECUTION->ANALYSIS": {
      const ctx = context as ExecutionToAnalysisContext;
      checks["done_runs"] = {
        passed: ctx.doneRunCount > 0,
        detail: `${ctx.doneRunCount} completed runs (need 1+)`,
      };
      break;
    }
    case "ANALYSIS->DECISION": {
      const ctx = context as AnalysisToDecisionContext;
      checks["hypothesis_updated"] = {
        passed: ctx.updatedHypothesisCount > 0 || ctx.terminalHypothesisCount > 0,
        detail: `${ctx.updatedHypothesisCount} updated, ${ctx.terminalHypothesisCount} terminal`,
      };
      checks["evidence_recorded"] = {
        passed: ctx.claimCount > 0 || ctx.terminalHypothesisCount > 0,
        detail: `${ctx.claimCount} claims, ${ctx.terminalHypothesisCount} terminal hypotheses`,
      };
      break;
    }
    case "DECISION->COMPLETE": {
      const ctx = context as DecisionToCompleteContext;
      checks["all_adjudicated"] = {
        passed: ctx.activeOrEvaluatingHypothesisCount === 0,
        detail: ctx.activeOrEvaluatingHypothesisCount === 0
          ? "All hypotheses adjudicated"
          : `${ctx.activeOrEvaluatingHypothesisCount} hypotheses still active/evaluating`,
      };
      checks["no_open_obligations"] = {
        passed: ctx.openCoordinatorObligations === 0,
        detail: ctx.openCoordinatorObligations === 0
          ? "No open obligations"
          : `${ctx.openCoordinatorObligations} open obligations`,
      };
      checks["has_conclusion"] = {
        passed: ctx.supportedOrRetiredCount > 0,
        detail: `${ctx.supportedOrRetiredCount} hypotheses with conclusions (need 1+)`,
      };
      break;
    }
    case "DECISION->DESIGN": {
      const ctx = context as DecisionToDesignContext;
      checks["viable_hypothesis"] = {
        passed: ctx.viableHypothesisCount > 0,
        detail: `${ctx.viableHypothesisCount} viable hypotheses`,
      };
      // Auto-resolve: coordinator has work OR viable hypothesis exists
      checks["has_work"] = {
        passed: ctx.viableHypothesisCount > 0 || ctx.coordinatorRequiredExperiments > 0,
        detail: `${ctx.coordinatorRequiredExperiments} coordinator-required experiments`,
      };
      break;
    }
    // Backward transitions (HYPOTHESIS->DISCOVERY, DESIGN->HYPOTHESIS) have no guards
    case "HYPOTHESIS->DISCOVERY":
    case "DESIGN->HYPOTHESIS":
      break;
    default:
      checks["unhandled"] = { passed: false, detail: `No guard defined for ${key}` };
  }

  const satisfied = Object.values(checks).every((c) => c.passed);
  return { satisfied, checks };
}

// ── Auto-transition eligibility ─────────────────────────────────

/** Which forward transitions can auto-fire (no agent input needed)? */
export const AUTO_TRANSITIONS: Partial<Record<string, boolean>> = {
  "DISCOVERY->HYPOTHESIS": true,
  "HYPOTHESIS->DESIGN": true,
  "DESIGN->EXECUTION": true,
  "EXECUTION->ANALYSIS": true,
  // ANALYSIS->DECISION: false — agent must record analysis
  "DECISION->COMPLETE": true,   // when unambiguous
  "DECISION->DESIGN": true,     // when unambiguous
  // DECISION->HYPOTHESIS: false — requires explicit decision
};
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/research/fsm/__tests__/project-fsm.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/research/fsm/project-fsm.ts src/lib/research/fsm/__tests__/project-fsm.test.ts
git commit -m "feat(fsm): implement project FSM guard evaluators with pure-function guards"
```

---

## Task 3: Transition Engine

**Files:**
- Create: `src/lib/research/fsm/transition-engine.ts`
- Test: `src/lib/research/fsm/__tests__/transition-engine.test.ts`

- [ ] **Step 1: Write failing tests for transition engine**

```typescript
// src/lib/research/fsm/__tests__/transition-engine.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// We test the context-fetching and transition-firing logic.
// DB calls are mocked via vi.mock.

vi.mock("@/lib/prisma", () => ({
  prisma: {
    researchProject: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    paper: { count: vi.fn() },
    agentTask: { count: vi.fn() },
    researchHypothesis: { count: vi.fn(), findMany: vi.fn() },
    approachBranch: { count: vi.fn() },
    remoteJob: { count: vi.fn() },
    researchClaim: { count: vi.fn() },
    researchStep: { count: vi.fn() },
    researchLogEntry: { create: vi.fn(), findFirst: vi.fn() },
    $transaction: vi.fn((fn: (tx: unknown) => Promise<unknown>) => fn({
      researchProject: { update: vi.fn() },
      researchLogEntry: { create: vi.fn() },
    })),
  },
}));

import { fetchGuardContext, attemptAutoTransition } from "../transition-engine";
import { prisma } from "@/lib/prisma";
import type { ProjectState } from "../types";

describe("fetchGuardContext", () => {
  it("fetches DISCOVERY->HYPOTHESIS context from DB", async () => {
    const mockCount = vi.fn().mockResolvedValue(5);
    (prisma.paper.count as ReturnType<typeof vi.fn>).mockResolvedValue(5);
    (prisma.agentTask.count as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(1)  // scouts
      .mockResolvedValueOnce(2); // synthesis
    
    const ctx = await fetchGuardContext("proj-1", "DISCOVERY", "HYPOTHESIS");
    expect(ctx).toHaveProperty("paperCount");
    expect(ctx).toHaveProperty("scoutCount");
    expect(ctx).toHaveProperty("completedSynthesisCount");
  });
});

describe("attemptAutoTransition", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when project is in COMPLETE", async () => {
    (prisma.researchProject.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "proj-1",
      currentPhase: "COMPLETE",
      status: "ACTIVE",
    });
    const result = await attemptAutoTransition("proj-1");
    expect(result).toBeNull();
  });

  it("returns null when no auto-transition guard is satisfied", async () => {
    (prisma.researchProject.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "proj-1",
      currentPhase: "DISCOVERY",
      status: "ACTIVE",
    });
    // Paper count too low
    (prisma.paper.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);
    (prisma.agentTask.count as ReturnType<typeof vi.fn>).mockResolvedValue(0);

    const result = await attemptAutoTransition("proj-1");
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/research/fsm/__tests__/transition-engine.test.ts`
Expected: FAIL — `fetchGuardContext` and `attemptAutoTransition` not found

- [ ] **Step 3: Implement transition engine**

```typescript
// src/lib/research/fsm/transition-engine.ts
import { prisma } from "@/lib/prisma";
import type { ProjectState, GuardContext, GuardResult, TransitionRecord } from "./types";
import { PROJECT_TRANSITIONS } from "./types";
import { evaluateTransitionGuard, AUTO_TRANSITIONS } from "./project-fsm";
import type {
  DiscoveryToHypothesisContext,
  HypothesisToDesignContext,
  DesignToExecutionContext,
  ExecutionToAnalysisContext,
  AnalysisToDecisionContext,
  DecisionToCompleteContext,
  DecisionToDesignContext,
} from "./project-fsm";
import { getEvaluationProtocol } from "../evaluation-protocol";

/**
 * Fetch the guard context for a specific transition from the database.
 * Guards themselves are pure functions; this bridges DB -> guard input.
 */
export async function fetchGuardContext(
  projectId: string,
  from: ProjectState,
  to: ProjectState,
): Promise<GuardContext> {
  const key = `${from}->${to}`;
  switch (key) {
    case "DISCOVERY->HYPOTHESIS": {
      const [paperCount, unprocessedPaperCount, scoutCount, completedSynthesisCount] = await Promise.all([
        prisma.paper.count({
          where: { collections: { some: { collection: { researchProject: { id: projectId } } } } },
        }),
        prisma.paper.count({
          where: {
            collections: { some: { collection: { researchProject: { id: projectId } } } },
            processingStatus: { notIn: ["COMPLETED", "FAILED", "NEEDS_DEFERRED", "NO_PDF"] },
          },
        }),
        prisma.agentTask.count({ where: { projectId, role: "scout" } }),
        prisma.agentTask.count({ where: { projectId, role: "synthesizer", status: "COMPLETED" } }),
      ]);
      return { paperCount, unprocessedPaperCount, scoutCount, completedSynthesisCount } satisfies DiscoveryToHypothesisContext;
    }
    case "HYPOTHESIS->DESIGN": {
      const [hypothesisCount, approachCount] = await Promise.all([
        prisma.researchHypothesis.count({ where: { projectId } }),
        prisma.approachBranch.count({ where: { projectId } }),
      ]);
      return { hypothesisCount, approachCount } satisfies HypothesisToDesignContext;
    }
    case "DESIGN->EXECUTION": {
      const [project, protocol, activeHypothesisCount] = await Promise.all([
        prisma.researchProject.findUnique({
          where: { id: projectId },
          select: { metricSchema: true },
        }),
        getEvaluationProtocol(projectId),
        prisma.researchHypothesis.count({
          where: { projectId, status: { in: ["ACTIVE", "TESTING", "PROPOSED"] } },
        }),
      ]);
      return {
        metricSchemaDefined: !!project?.metricSchema,
        evaluationProtocolExists: !!protocol,
        activeHypothesisCount,
      } satisfies DesignToExecutionContext;
    }
    case "EXECUTION->ANALYSIS": {
      const doneRunCount = await prisma.remoteJob.count({
        where: { projectId, status: "COMPLETED" },
      });
      return { doneRunCount } satisfies ExecutionToAnalysisContext;
    }
    case "ANALYSIS->DECISION": {
      const [updatedHypothesisCount, terminalHypothesisCount, claimCount] = await Promise.all([
        prisma.researchHypothesis.count({
          where: { projectId, status: { notIn: ["PROPOSED", "ACTIVE", "TESTING"] } },
        }),
        prisma.researchHypothesis.count({
          where: { projectId, status: { in: ["SUPPORTED", "REFUTED", "REVISED"] } },
        }),
        prisma.researchClaim.count({ where: { projectId } }),
      ]);
      return { updatedHypothesisCount, terminalHypothesisCount, claimCount } satisfies AnalysisToDecisionContext;
    }
    case "DECISION->COMPLETE": {
      const [activeOrEvaluatingHypothesisCount, supportedOrRetiredCount] = await Promise.all([
        prisma.researchHypothesis.count({
          where: { projectId, status: { in: ["ACTIVE", "TESTING", "PROPOSED"] } },
        }),
        prisma.researchHypothesis.count({
          where: { projectId, status: { in: ["SUPPORTED", "REFUTED"] } },
        }),
      ]);
      // TODO: count coordinator obligations from credibility queue
      return {
        activeOrEvaluatingHypothesisCount,
        openCoordinatorObligations: 0,
        supportedOrRetiredCount,
      } satisfies DecisionToCompleteContext;
    }
    case "DECISION->DESIGN": {
      const viableHypothesisCount = await prisma.researchHypothesis.count({
        where: { projectId, status: { in: ["ACTIVE", "TESTING", "REVISED"] } },
      });
      return {
        viableHypothesisCount,
        coordinatorRequiredExperiments: 0, // TODO: count from credibility queue
      } satisfies DecisionToDesignContext;
    }
    // Backward transitions have no guard context
    default:
      return {};
  }
}

/**
 * Attempt to auto-transition a project forward.
 * Called after any relevant DB write (experiment completion, hypothesis update, etc.)
 * Returns the new state if a transition fired, null otherwise.
 */
export async function attemptAutoTransition(
  projectId: string,
): Promise<{ from: ProjectState; to: ProjectState; record: TransitionRecord } | null> {
  const project = await prisma.researchProject.findUnique({
    where: { id: projectId },
    select: { currentPhase: true, status: true },
  });
  if (!project) return null;

  const from = project.currentPhase as ProjectState;
  const status = project.status;

  // Don't auto-transition if project is paused/blocked/failed/archived
  if (status !== "ACTIVE") return null;

  // Don't auto-transition from terminal state
  if (from === "COMPLETE") return null;

  // Check each valid forward transition
  const targets = PROJECT_TRANSITIONS[from];
  for (const to of targets) {
    const transitionKey = `${from}->${to}`;
    if (!AUTO_TRANSITIONS[transitionKey]) continue;

    const context = await fetchGuardContext(projectId, from, to);
    const result = await evaluateTransitionGuard(projectId, from, to, context);

    if (result.satisfied) {
      // Fire the transition
      const record: TransitionRecord = {
        projectId,
        domain: "project",
        entityId: projectId,
        from,
        to,
        trigger: "auto",
        basis: Object.entries(result.checks)
          .map(([k, v]) => `${k}: ${v.detail}`)
          .join("; "),
        guardsEvaluated: Object.fromEntries(
          Object.entries(result.checks).map(([k, v]) => [k, v.passed]),
        ),
      };

      await prisma.$transaction(async (tx) => {
        await tx.researchProject.update({
          where: { id: projectId },
          data: { currentPhase: to },
        });
        await tx.researchLogEntry.create({
          data: {
            projectId,
            type: "decision",
            content: `Auto-transition: ${from} -> ${to}`,
            metadata: JSON.stringify({
              kind: "fsm_transition",
              ...record,
            }),
          },
        });
      });

      return { from, to, record };
    }
  }

  return null;
}

/**
 * Get the current project state and check what guards are blocking
 * the next forward transition. Used for diagnostics and the agent's
 * state-awareness.
 */
export async function getProjectStateReport(projectId: string): Promise<{
  state: ProjectState;
  nextStates: ProjectState[];
  guardResults: Record<string, GuardResult>;
}> {
  const project = await prisma.researchProject.findUnique({
    where: { id: projectId },
    select: { currentPhase: true },
  });
  const state = (project?.currentPhase || "DISCOVERY") as ProjectState;
  const nextStates = [...PROJECT_TRANSITIONS[state]];
  const guardResults: Record<string, GuardResult> = {};

  for (const to of nextStates) {
    const context = await fetchGuardContext(projectId, state, to);
    guardResults[`${state}->${to}`] = await evaluateTransitionGuard(projectId, state, to, context);
  }

  return { state, nextStates, guardResults };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/research/fsm/__tests__/transition-engine.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/research/fsm/transition-engine.ts src/lib/research/fsm/__tests__/transition-engine.test.ts
git commit -m "feat(fsm): implement transition engine with auto-transition and guard context fetching"
```

---

## Task 4: Tool Sets Per State

**Files:**
- Create: `src/lib/research/fsm/tool-sets.ts`
- Test: `src/lib/research/fsm/__tests__/tool-sets.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/lib/research/fsm/__tests__/tool-sets.test.ts
import { describe, it, expect } from "vitest";
import { getToolsForState, CROSS_CUTTING_TOOLS } from "../tool-sets";

describe("getToolsForState", () => {
  it("DISCOVERY includes search_papers but not run_experiment", () => {
    const tools = getToolsForState("DISCOVERY");
    expect(tools).toContain("search_papers");
    expect(tools).toContain("dispatch_scouts");
    expect(tools).not.toContain("run_experiment");
    expect(tools).not.toContain("record_result");
  });

  it("EXECUTION includes run_experiment but not define_metrics", () => {
    const tools = getToolsForState("EXECUTION");
    expect(tools).toContain("run_experiment");
    expect(tools).toContain("execute_remote");
    expect(tools).not.toContain("define_metrics");
    expect(tools).not.toContain("search_papers");
  });

  it("DESIGN includes define_metrics and define_evaluation_protocol", () => {
    const tools = getToolsForState("DESIGN");
    expect(tools).toContain("define_metrics");
    expect(tools).toContain("define_evaluation_protocol");
    expect(tools).not.toContain("run_experiment");
  });

  it("all states include cross-cutting tools", () => {
    const states = ["DISCOVERY", "HYPOTHESIS", "DESIGN", "EXECUTION", "ANALYSIS", "DECISION"] as const;
    for (const state of states) {
      const tools = getToolsForState(state);
      for (const crossCutting of CROSS_CUTTING_TOOLS) {
        expect(tools).toContain(crossCutting);
      }
    }
  });

  it("COMPLETE has only archive/read tools", () => {
    const tools = getToolsForState("COMPLETE");
    expect(tools).not.toContain("run_experiment");
    expect(tools).not.toContain("search_papers");
    expect(tools).toContain("read_file");
    expect(tools).toContain("list_files");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/research/fsm/__tests__/tool-sets.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement tool sets**

```typescript
// src/lib/research/fsm/tool-sets.ts
import type { ProjectState } from "./types";

/**
 * Tools available in all states. These are observational or
 * cross-cutting and never need gating.
 */
export const CROSS_CUTTING_TOOLS = [
  "read_file",
  "list_files",
  "get_workspace",
  "write_file",
  "delete_file",
  "request_help",
  "save_lesson",
  "query_insights",
  "query_skills",
  "search_library",
  "log_finding",
  "view_approach_tree",
] as const;

/**
 * State-specific tool sets. Each state gets exactly the tools
 * relevant to the work in that state, plus cross-cutting tools.
 */
const STATE_TOOLS: Record<ProjectState, readonly string[]> = {
  DISCOVERY: [
    "search_papers",
    "dispatch_scouts",
    "dispatch_synthesizer",
    "collect_results",
  ],
  HYPOTHESIS: [
    "register_approach",
    "dispatch_architect",
    "collect_results",
  ],
  DESIGN: [
    "define_metrics",
    "define_evaluation_protocol",
    "show_evaluation_protocol",
    "register_approach",
  ],
  EXECUTION: [
    "run_experiment",
    "execute_remote",
    "run_experiment_sweep",
    "check_job",
    "monitor_experiment",
    "validate_environment",
    "diagnose_remote_host",
    "show_evaluation_protocol",
  ],
  ANALYSIS: [
    "record_result",
    "query_results",
    "record_claim",
    "update_hypothesis",
    "reflect_on_failure",
    "adversarial_review",
    "show_evaluation_protocol",
    "collect_results",
  ],
  DECISION: [
    "query_results",
    "show_evaluation_protocol",
    "record_claim",
    "update_hypothesis",
  ],
  COMPLETE: [],
};

/**
 * Get the full tool set for a given project state.
 * Returns state-specific tools + cross-cutting tools, deduplicated.
 */
export function getToolsForState(state: ProjectState): string[] {
  const stateTools = STATE_TOOLS[state] || [];
  const all = new Set<string>([...CROSS_CUTTING_TOOLS, ...stateTools]);
  return Array.from(all);
}

/**
 * Check if a specific tool is available in a given state.
 */
export function isToolAvailable(tool: string, state: ProjectState): boolean {
  return getToolsForState(state).includes(tool);
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/lib/research/fsm/__tests__/tool-sets.test.ts`
Expected: All tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/research/fsm/tool-sets.ts src/lib/research/fsm/__tests__/tool-sets.test.ts
git commit -m "feat(fsm): implement state-based tool filtering — each state gets exactly its relevant tools"
```

---

## Task 5: DESIGN State Auto-Resolution

**Files:**
- Create: `src/lib/research/fsm/design-auto-resolve.ts`
- Modify: `src/lib/research/evaluation-protocol.ts` (export `deriveDefaultProtocol`)

- [ ] **Step 1: Write failing test**

```typescript
// src/lib/research/fsm/__tests__/design-auto-resolve.test.ts
import { describe, it, expect } from "vitest";
import { deriveDefaultProtocol } from "../../evaluation-protocol";

describe("deriveDefaultProtocol", () => {
  it("derives protocol from metric schema", () => {
    const metrics = [
      { name: "f1", direction: "higher" },
      { name: "loss", direction: "lower" },
      { name: "accuracy", direction: "higher" },
    ];
    const protocol = deriveDefaultProtocol(metrics);
    expect(protocol.primaryMetric).toBe("f1");
    expect(protocol.secondaryMetrics).toEqual(["loss", "accuracy"]);
    expect(protocol.seeds).toEqual([42, 123, 456]);
    expect(protocol.minRuns).toBe(1);
    expect(protocol.statisticalTest).toBe("bootstrap 95% CI");
  });

  it("returns null for empty metrics", () => {
    const protocol = deriveDefaultProtocol([]);
    expect(protocol).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/research/fsm/__tests__/design-auto-resolve.test.ts`
Expected: FAIL

- [ ] **Step 3: Add `deriveDefaultProtocol` to evaluation-protocol.ts**

Add at end of `src/lib/research/evaluation-protocol.ts`:

```typescript
/**
 * Derive a sensible default evaluation protocol from a metric schema.
 * Used by the DESIGN state auto-resolver to proactively create the
 * protocol when metrics are defined, without waiting for the agent.
 */
export function deriveDefaultProtocol(
  metrics: Array<{ name: string; direction?: string }>,
): EvaluationProtocol | null {
  if (metrics.length === 0) return null;
  const primary = metrics[0];
  const secondary = metrics.slice(1).map((m) => m.name);
  return {
    primaryMetric: primary.name,
    secondaryMetrics: secondary,
    datasets: [],
    seeds: [42, 123, 456],
    minRuns: 1,
    statisticalTest: "bootstrap 95% CI",
    acceptanceCriteria: `Consistent ${primary.direction === "lower" ? "decrease" : "improvement"} in ${primary.name} across seeds`,
    requiredBaselines: [],
    notes: "Auto-derived from project metrics. Refine with define_evaluation_protocol if needed.",
  };
}
```

- [ ] **Step 4: Implement DESIGN auto-resolver**

```typescript
// src/lib/research/fsm/design-auto-resolve.ts
import { prisma } from "@/lib/prisma";
import {
  getEvaluationProtocol,
  saveEvaluationProtocol,
  deriveDefaultProtocol,
} from "../evaluation-protocol";

/**
 * Proactively resolve DESIGN prerequisites.
 * Called when the project enters DESIGN or when metrics are defined.
 *
 * Auto-creates evaluation protocol from metrics if:
 * - Metrics are defined
 * - No protocol exists yet
 *
 * Returns what was resolved for logging.
 */
export async function resolveDesignPrerequisites(
  projectId: string,
): Promise<string[]> {
  const resolved: string[] = [];

  const project = await prisma.researchProject.findUnique({
    where: { id: projectId },
    select: { metricSchema: true },
  });

  if (!project?.metricSchema) return resolved;

  // Check if protocol already exists
  const existing = await getEvaluationProtocol(projectId);
  if (existing) return resolved;

  // Derive protocol from metrics
  let metrics: Array<{ name: string; direction?: string }>;
  try {
    metrics = JSON.parse(project.metricSchema);
  } catch {
    return resolved;
  }

  const protocol = deriveDefaultProtocol(metrics);
  if (!protocol) return resolved;

  await saveEvaluationProtocol(projectId, protocol);
  resolved.push(
    `Auto-created evaluation protocol: primary=${protocol.primaryMetric}, ` +
    `seeds=[${protocol.seeds.join(", ")}], minRuns=${protocol.minRuns}`,
  );

  return resolved;
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run src/lib/research/fsm/__tests__/design-auto-resolve.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/lib/research/fsm/design-auto-resolve.ts src/lib/research/evaluation-protocol.ts src/lib/research/fsm/__tests__/design-auto-resolve.test.ts
git commit -m "feat(fsm): auto-derive evaluation protocol from metrics in DESIGN state"
```

---

## Task 6: Schema Migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: migration via `npx prisma migrate dev`

- [ ] **Step 1: Update schema**

In `prisma/schema.prisma`, add after the `ResearchLogEntry` model:

```prisma
model TransitionRecord {
  id          String   @id @default(cuid())
  projectId   String
  domain      String   // "project" | "run" | "hypothesis"
  entityId    String   // projectId, runId, or hypothesisId
  fromState   String
  toState     String
  trigger     String   // "auto" | "agent" | "user" | "system"
  basis       String
  guards      String?  // JSON of guard evaluation results
  createdAt   DateTime @default(now())

  project ResearchProject @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@index([projectId])
  @@index([projectId, domain, createdAt])
  @@index([entityId])
}
```

Update `ResearchProject` model — add relation:

```prisma
  transitions TransitionRecord[]
```

Update `RemoteJob` model — add `failureClass` field (after existing `errorClass` field):

```prisma
  failureClass String?  // INFRA | CODE | POLICY | VALIDATION | IMPORT
```

Update `currentPhase` comment in `ResearchProject`:

```prisma
  currentPhase    String   @default("DISCOVERY")  // FSM state: DISCOVERY | HYPOTHESIS | DESIGN | EXECUTION | ANALYSIS | DECISION | COMPLETE
```

- [ ] **Step 2: Generate and apply migration**

Run: `npx prisma migrate dev --name fsm_transition_records`
Expected: Migration created and applied

- [ ] **Step 3: Regenerate Prisma client**

Run: `npx prisma generate`
Expected: Client regenerated

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "schema: add TransitionRecord model, failureClass on RemoteJob, update currentPhase to FSM states"
```

---

## Task 7: Wire FSM Into Agent — Replace Phase Gates

**Files:**
- Modify: `src/lib/research/agent.ts`

This is the largest integration task. It replaces the core of the phase system.

- [ ] **Step 1: Add FSM imports to agent.ts**

At the top of `agent.ts`, add:

```typescript
import { getToolsForState } from "./fsm/tool-sets";
import { attemptAutoTransition, getProjectStateReport } from "./fsm/transition-engine";
import { resolveDesignPrerequisites } from "./fsm/design-auto-resolve";
import type { ProjectState } from "./fsm/types";
```

- [ ] **Step 2: Remove `PHASE_RESTRICTED_TOOLS` map**

Delete lines 162-166 (the `PHASE_RESTRICTED_TOOLS` constant).

- [ ] **Step 3: Remove `checkPhaseGate` function**

Delete lines 168-294 (the entire `checkPhaseGate` function).

- [ ] **Step 4: Remove `autoAdvanceExperimentPhaseIfNeeded` function**

Delete lines 2941-2960.

- [ ] **Step 5: Remove `advance_phase` tool**

Delete the `advance_phase` tool definition (lines 3200-3228). The system now drives transitions; the agent doesn't call advance_phase.

- [ ] **Step 6: Remove phase gate enforcement from tool wrapper**

In the tool execution wrapper (around line 1511-1519), delete the `PHASE_RESTRICTED_TOOLS` check:

```typescript
// DELETE THIS BLOCK:
if (!isBenchmarkProject && PHASE_RESTRICTED_TOOLS[name]) {
  const proj = await prisma.researchProject.findUnique({
    where: { id: projectId }, select: { currentPhase: true },
  });
  if (proj && !PHASE_RESTRICTED_TOOLS[name].includes(proj.currentPhase)) {
    const allowed = PHASE_RESTRICTED_TOOLS[name].join(" or ");
    return `BLOCKED — ${name} is only available in the ${allowed} phase. Current phase: ${proj.currentPhase}. Use advance_phase to transition.`;
  }
}
```

- [ ] **Step 7: Replace tool filtering in `createTools`**

Replace the full tools object with a filtered version based on FSM state. After `createTools` builds `rawTools`, add filtering:

```typescript
// After rawTools is built, filter to only tools available in current state
const currentProject = await prisma.researchProject.findUnique({
  where: { id: projectId },
  select: { currentPhase: true },
});
const projectState = (currentProject?.currentPhase || "DISCOVERY") as ProjectState;
const allowedTools = new Set(getToolsForState(projectState));

// Filter rawTools to only include allowed tools
const filteredTools = Object.fromEntries(
  Object.entries(rawTools).filter(([name]) => allowedTools.has(name))
) as typeof rawTools;
```

Use `filteredTools` instead of `rawTools` when passing to `streamText`.

- [ ] **Step 8: Hook auto-transitions into key tool completions**

After tools that produce durable state changes (define_metrics, record_result, update_hypothesis, etc.), call `attemptAutoTransition`:

```typescript
// Add to the end of define_metrics tool execute:
await attemptAutoTransition(projectId).catch(() => {});

// Add to the end of record_result tool execute:
await attemptAutoTransition(projectId).catch(() => {});

// Add to the end of update_hypothesis tool execute:
await attemptAutoTransition(projectId).catch(() => {});

// Add to the end of record_claim tool execute:
await attemptAutoTransition(projectId).catch(() => {});
```

Also hook into `resolveDesignPrerequisites` when entering DESIGN state. In `define_metrics`:

```typescript
// After saving metrics, auto-resolve DESIGN prerequisites
await resolveDesignPrerequisites(projectId).catch(() => {});
await attemptAutoTransition(projectId).catch(() => {});
```

- [ ] **Step 9: Commit**

```bash
git add src/lib/research/agent.ts
git commit -m "feat(fsm): wire project FSM into agent — replace phase gates with state-driven tool filtering and auto-transitions"
```

---

## Task 8: Update System Prompt

**Files:**
- Modify: `src/lib/research/agent.ts` (system prompt section)

- [ ] **Step 1: Replace the Phase-Gated Workflow section**

Find the "Phase-Gated Workflow" section (around line 2336-2350) and replace with:

```typescript
## Research State Machine

Your research operates in a structured state machine. The system drives transitions automatically — you do not need to call advance_phase or navigate between states.

**Current state: shown in RESEARCH_STATE.md**

**States and your role in each:**

- **DISCOVERY** — Search literature, dispatch scouts, synthesize findings. The system advances to HYPOTHESIS when 3+ papers are processed and synthesis is complete.
- **HYPOTHESIS** — Formulate testable hypotheses and register approaches. The system advances to DESIGN when hypotheses and approaches exist.
- **DESIGN** — Define metrics and evaluation protocol. The system auto-creates a default protocol from your metrics. Advances to EXECUTION when all prerequisites are satisfied.
- **EXECUTION** — Run experiments. All prerequisites are already met. Focus on submitting and monitoring experiments.
- **ANALYSIS** — Interpret results, update hypotheses with evidence, record claims. You must explicitly record analysis before the system advances to DECISION.
- **DECISION** — The system evaluates whether to iterate (back to DESIGN), pivot (back to HYPOTHESIS), or conclude (COMPLETE). Auto-resolves when the outcome is unambiguous.

**Key behavior:** You only see tools relevant to your current state. If you need a tool you don't see, it means you're in the wrong state and need to complete the current state's work first.

**You never need to:** call advance_phase, check which phase you're in, or figure out prerequisites. The system handles all of this.
```

- [ ] **Step 2: Remove the detailed gate conditions prose**

Delete the lines explaining specific gate conditions (literature -> hypothesis: 3+ papers, etc.) since these are now code-enforced, not agent-interpreted.

- [ ] **Step 3: Commit**

```bash
git add src/lib/research/agent.ts
git commit -m "feat(fsm): replace phase-gated workflow prompt with state machine description"
```

---

## Task 9: Update Research State Generation

**Files:**
- Modify: `src/lib/research/research-state.ts`

- [ ] **Step 1: Update state display**

In `generateResearchState` (around line 100), replace the phase display:

```typescript
// Replace:
// **Phase:** ${phase}
// With:
const stateReport = await getProjectStateReport(projectId);
const guardSummary = Object.entries(stateReport.guardResults)
  .map(([transition, result]) => {
    const status = result.satisfied ? "ready" : "blocked";
    const blockers = Object.entries(result.checks)
      .filter(([, v]) => !v.passed)
      .map(([k, v]) => `${k}: ${v.detail}`)
      .join(", ");
    return `  ${transition}: ${status}${blockers ? ` (${blockers})` : ""}`;
  })
  .join("\n");

// In the markdown output:
`**State:** ${stateReport.state}\n**Next transitions:**\n${guardSummary}`
```

- [ ] **Step 2: Commit**

```bash
git add src/lib/research/research-state.ts
git commit -m "feat(fsm): show FSM state and transition readiness in RESEARCH_STATE.md"
```

---

## Task 10: Simplify Submission Readiness

**Files:**
- Modify: `src/lib/research/submission-readiness.ts`

- [ ] **Step 1: Remove phase and evaluation protocol checks**

In `computeExperimentSubmissionReadiness`:
- Remove the `EVALUATION_PROTOCOL` issue check (lines 235-239) — the FSM guarantees protocol exists in EXECUTION
- Remove the phase-based blocking (lines 287-292) — the FSM only shows run_experiment in EXECUTION
- Remove `canAutoAdvanceToExperiment` logic (lines 294-299) — the FSM handles phase advancement

Keep:
- Hypothesis resolution (still needed for multi-hypothesis disambiguation)
- Workspace busy guard (still needed for host-level deconfliction)
- POC requirement check (still a valid EXECUTION-internal constraint)
- Metrics check can also be removed (FSM guarantees metrics exist in EXECUTION)

- [ ] **Step 2: Remove auto-advance from `assessExperimentSubmission` in agent.ts**

In `assessExperimentSubmission` (around line 3024-3026), remove the `autoAdvanceExperimentPhaseIfNeeded` call since the FSM handles this.

- [ ] **Step 3: Commit**

```bash
git add src/lib/research/submission-readiness.ts src/lib/research/agent.ts
git commit -m "refactor(fsm): simplify submission readiness — FSM guarantees phase and protocol prerequisites"
```

---

## Task 11: Migrate Existing Projects

**Files:**
- Create: `scripts/migrate-projects-to-fsm.ts`

- [ ] **Step 1: Write migration script**

```typescript
// scripts/migrate-projects-to-fsm.ts
import { prisma } from "../src/lib/prisma";

const PHASE_TO_STATE: Record<string, string> = {
  literature: "DISCOVERY",
  hypothesis: "HYPOTHESIS",
  experiment: "EXECUTION",  // DESIGN is new; existing projects in experiment have already passed design
  analysis: "ANALYSIS",
  reflection: "DECISION",
};

async function migrate() {
  const projects = await prisma.researchProject.findMany({
    select: { id: true, currentPhase: true, status: true },
  });

  let migrated = 0;
  for (const project of projects) {
    const oldPhase = project.currentPhase;
    const newState = PHASE_TO_STATE[oldPhase] || oldPhase;

    // Skip if already migrated (value is already an FSM state)
    if (["DISCOVERY", "HYPOTHESIS", "DESIGN", "EXECUTION", "ANALYSIS", "DECISION", "COMPLETE"].includes(oldPhase)) {
      continue;
    }

    await prisma.researchProject.update({
      where: { id: project.id },
      data: { currentPhase: newState },
    });

    console.log(`  ${project.id}: ${oldPhase} -> ${newState}`);
    migrated++;
  }

  console.log(`Migrated ${migrated} projects`);
}

migrate()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
```

- [ ] **Step 2: Run migration**

Run: `npx tsx scripts/migrate-projects-to-fsm.ts`
Expected: All projects migrated to FSM state names

- [ ] **Step 3: Commit**

```bash
git add scripts/migrate-projects-to-fsm.ts
git commit -m "chore: add migration script for existing projects to FSM state names"
```

---

## Task 12: Clean Up Legacy References

**Files:**
- Modify: Various files that reference `currentPhase` with old values

- [ ] **Step 1: Update context-builder.ts**

In `src/lib/research/context-builder.ts`, update any references from old phase names to FSM state names. The `currentPhase` field now stores FSM states.

- [ ] **Step 2: Update research-summary.ts**

In `src/lib/research/research-summary.ts`, update references to phase names.

- [ ] **Step 3: Update UI components**

In `src/components/research/research-dashboard.tsx`, update the phase dots in the header to use FSM state names: DISCOVERY, HYPOTHESIS, DESIGN, EXECUTION, ANALYSIS, DECISION, COMPLETE.

- [ ] **Step 4: Full grep for old phase names**

Run: `grep -rn '"literature"\|"hypothesis"\|"experiment"\|"analysis"\|"reflection"' src/lib/research/ --include='*.ts' | grep -v node_modules | grep -v '.test.'`

Update each remaining reference to use FSM state names.

- [ ] **Step 5: Type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor(fsm): update all legacy phase references to FSM state names"
```

---

## Task 13: Run Full Test Suite

- [ ] **Step 1: Run all tests**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Manual smoke test**

Start dev server, open a research project, verify:
- State shows correctly in the UI
- Claims and Lineage tabs work (left panel)
- Tools are filtered by state (check browser network tab for agent tool list)
- Auto-transition fires when prerequisites are met

- [ ] **Step 4: Final commit**

```bash
git commit --allow-empty -m "chore: FSM lifecycle implementation complete — all tests pass"
```
