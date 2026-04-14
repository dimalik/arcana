# FSM v2 Plan A: Foundation (Vocabulary Freeze + Schema)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freeze all state vocabularies as TypeScript enums and add the new Prisma models (ExperimentIntent, ExperimentAttempt, HypothesisApproachLink, InvariantViolation, BlockingReason, TransitionRecord v2) so that Plan B and Plan C have a stable foundation.

**Architecture:** Create a single `enums.ts` file with all frozen vocabularies as const arrays + derived types. Update the Prisma schema with new models. Write a migration script for legacy values. All existing code continues to work — this plan only adds, never removes.

**Tech Stack:** TypeScript, Prisma (SQLite), Vitest

**Spec:** `docs/superpowers/specs/2026-04-13-research-lifecycle-fsm-v2.md` — Sections 1 (Intent schema), 2 (Run/Attempt schema), 3 (Vocabulary freeze + legacy mapping), 4 (TransitionRecord v2), 5 (InvariantViolation schema), 9 (HypothesisApproachLink schema)

---

## File Structure

### New Files

| File | Responsibility |
|------|---------------|
| `src/lib/research/fsm/enums.ts` | All frozen vocabularies — the single source of truth for every state/trigger/kind enum |
| `src/lib/research/fsm/__tests__/enums.test.ts` | Invariant tests: no vocabulary collisions, all domains have complete entries |
| `scripts/migrate-vocabulary-v2.ts` | Migration script: convert legacy status values to frozen vocabulary |
| `prisma/migrations/YYYYMMDD_fsm_v2_models/migration.sql` | Schema migration |

### Modified Files

| File | Changes |
|------|---------|
| `prisma/schema.prisma` | Add ExperimentIntent, ExperimentAttempt, HypothesisApproachLink, InvariantViolation, BlockingReason. Update TransitionRecord. Add `kind`, `purpose`, `overlay` to ExperimentRun. Make ExperimentRun.intentId nullable. |
| `src/lib/research/fsm/types.ts` | Import and re-export from enums.ts for backward compat. Remove any inline state definitions that now live in enums.ts. |

---

## Task 1: Vocabulary Freeze (enums.ts)

**Files:**
- Create: `src/lib/research/fsm/enums.ts`
- Create: `src/lib/research/fsm/__tests__/enums.test.ts`

- [ ] **Step 1: Write the enums file**

```typescript
// src/lib/research/fsm/enums.ts
//
// Frozen state vocabularies for the research lifecycle FSM v2.
// This is the single source of truth. All other code imports from here.
// No raw string literals for states anywhere else in the codebase.

// ── Project Lifecycle ──────────────────────────────────────────────

export const PROJECT_LIFECYCLE_STATES = [
  "DISCOVERY",
  "HYPOTHESIS",
  "DESIGN",
  "EXECUTION",
  "ANALYSIS",
  "DECISION",
  "COMPLETE",
] as const;
export type ProjectLifecycleState = (typeof PROJECT_LIFECYCLE_STATES)[number];

export const PROJECT_OVERLAY_STATUSES = [
  "ACTIVE",
  "PAUSED",
  "BLOCKED",
  "FAILED",
  "ARCHIVED",
] as const;
export type ProjectOverlayStatus = (typeof PROJECT_OVERLAY_STATUSES)[number];

// ── Intent Lifecycle ───────────────────────────────────────────────

export const INTENT_LIFECYCLE_STATES = [
  "DRAFT",
  "READY",
  "ACTIVE",
  "SATISFIED",
  "EXHAUSTED",
  "SUPERSEDED",
  "CANCELLED",
] as const;
export type IntentLifecycleState = (typeof INTENT_LIFECYCLE_STATES)[number];

export const INTENT_TERMINAL_STATES: readonly IntentLifecycleState[] = [
  "SATISFIED",
  "EXHAUSTED",
  "SUPERSEDED",
  "CANCELLED",
];

export const INTENT_PURPOSES = [
  "BASELINE",
  "MAIN_EVAL",
  "TRAINING",
  "ANALYSIS",
] as const;
export type IntentPurpose = (typeof INTENT_PURPOSES)[number];

// ── Run Lifecycle ──────────────────────────────────────────────────

export const RUN_LIFECYCLE_STATES = [
  "DRAFT",
  "READY",
  "QUEUED",
  "RUNNING",
  "IMPORTING",
  "DONE",
  "FAILED",
  "CANCELLED",
] as const;
export type RunLifecycleState = (typeof RUN_LIFECYCLE_STATES)[number];

export const RUN_TERMINAL_STATES: readonly RunLifecycleState[] = [
  "DONE",
  "FAILED",
  "CANCELLED",
];

export const RUN_OVERLAY_STATUSES = [
  "ACTIVE",
  "BLOCKED",
] as const;
export type RunOverlayStatus = (typeof RUN_OVERLAY_STATUSES)[number];

export const RUN_KINDS = ["research", "infrastructure"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export const INFRASTRUCTURE_PURPOSES = ["SMOKE", "CALIBRATION"] as const;
export type InfrastructurePurpose = (typeof INFRASTRUCTURE_PURPOSES)[number];

export const FAILURE_CLASSES = [
  "INFRA",
  "CODE",
  "POLICY",
  "VALIDATION",
  "IMPORT",
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

// ── Hypothesis Lifecycle ───────────────────────────────────────────

export const HYPOTHESIS_LIFECYCLE_STATES = [
  "PROPOSED",
  "ACTIVE",
  "EVALUATING",
  "SUPPORTED",
  "CONTESTED",
  "REVISED",
  "RETIRED",
] as const;
export type HypothesisLifecycleState = (typeof HYPOTHESIS_LIFECYCLE_STATES)[number];

export const HYPOTHESIS_TERMINAL_STATES: readonly HypothesisLifecycleState[] = [
  "SUPPORTED",
  "CONTESTED",
  "REVISED",
  "RETIRED",
];

// ── Approach Lifecycle ─────────────────────────────────────────────

export const APPROACH_LIFECYCLE_STATES = [
  "PROPOSED",
  "COMMITTED",
  "ACTIVE",
  "COMPLETED",
  "ABANDONED",
] as const;
export type ApproachLifecycleState = (typeof APPROACH_LIFECYCLE_STATES)[number];

// ── Transition Triggers ────────────────────────────────────────────

export const TRANSITION_TRIGGERS = [
  "auto",
  "agent",
  "user",
  "system",
  "reconciler",
  "invariant_repair",
] as const;
export type TransitionTrigger = (typeof TRANSITION_TRIGGERS)[number];

// ── Transition Domains ─────────────────────────────────────────────

export const TRANSITION_DOMAINS = [
  "project",
  "intent",
  "run",
  "hypothesis",
  "approach",
] as const;
export type TransitionDomain = (typeof TRANSITION_DOMAINS)[number];

// ── Invariant Classes ──────────────────────────────────────────────

export const INVARIANT_CLASSES = ["HARD", "SOFT", "AUDIT"] as const;
export type InvariantClass = (typeof INVARIANT_CLASSES)[number];

export const INVARIANT_VIOLATION_STATUSES = [
  "OPEN",
  "ESCALATED",
  "RESOLVED",
  "SUPPRESSED",
] as const;
export type InvariantViolationStatus = (typeof INVARIANT_VIOLATION_STATUSES)[number];

// ── Approach Roles (HypothesisApproachLink) ────────────────────────

export const APPROACH_ROLES = [
  "primary",
  "control",
  "ablation",
  "comparison",
] as const;
export type ApproachRole = (typeof APPROACH_ROLES)[number];

// ── Completion Criteria ────────────────────────────────────────────

export type CompletionCriterion =
  | { type: "single_successful_run" }
  | { type: "min_runs"; count: number }
  | { type: "all_seeds_complete"; seeds: number[] }
  | { type: "comparison_against"; baselineIntentId: string; matchBy: "runKey" }
  | { type: "comparison_against"; baselineIntentId: string; matchBy: "seed"; seeds: number[] }
  | { type: "all_conditions_complete"; conditions: string[] };

// ── RemoteJob Adapter Statuses (not lifecycle) ─────────────────────

export const REMOTE_JOB_ADAPTER_STATUSES = [
  "SYNCING",
  "POLLING",
  "COMPLETED",
  "ERROR",
] as const;
export type RemoteJobAdapterStatus = (typeof REMOTE_JOB_ADAPTER_STATUSES)[number];
```

- [ ] **Step 2: Write invariant tests for the enums**

```typescript
// src/lib/research/fsm/__tests__/enums.test.ts
import { describe, it, expect } from "vitest";
import {
  PROJECT_LIFECYCLE_STATES,
  PROJECT_OVERLAY_STATUSES,
  INTENT_LIFECYCLE_STATES,
  RUN_LIFECYCLE_STATES,
  RUN_OVERLAY_STATUSES,
  HYPOTHESIS_LIFECYCLE_STATES,
  APPROACH_LIFECYCLE_STATES,
  TRANSITION_TRIGGERS,
  TRANSITION_DOMAINS,
  INVARIANT_CLASSES,
  RUN_TERMINAL_STATES,
  INTENT_TERMINAL_STATES,
  HYPOTHESIS_TERMINAL_STATES,
  FAILURE_CLASSES,
  APPROACH_ROLES,
} from "../enums";

describe("Vocabulary freeze invariants", () => {
  it("no lifecycle term appears in the same domain's overlay", () => {
    // Project
    const projectOverlap = PROJECT_LIFECYCLE_STATES.filter(
      (s) => (PROJECT_OVERLAY_STATUSES as readonly string[]).includes(s),
    );
    expect(projectOverlap).toEqual([]);

    // Run
    const runOverlap = RUN_LIFECYCLE_STATES.filter(
      (s) => (RUN_OVERLAY_STATUSES as readonly string[]).includes(s),
    );
    expect(runOverlap).toEqual([]);
  });

  it("terminal states are subsets of their lifecycle arrays", () => {
    for (const t of RUN_TERMINAL_STATES) {
      expect((RUN_LIFECYCLE_STATES as readonly string[]).includes(t)).toBe(true);
    }
    for (const t of INTENT_TERMINAL_STATES) {
      expect((INTENT_LIFECYCLE_STATES as readonly string[]).includes(t)).toBe(true);
    }
    for (const t of HYPOTHESIS_TERMINAL_STATES) {
      expect((HYPOTHESIS_LIFECYCLE_STATES as readonly string[]).includes(t)).toBe(true);
    }
  });

  it("all domains are covered in TRANSITION_DOMAINS", () => {
    expect(TRANSITION_DOMAINS).toContain("project");
    expect(TRANSITION_DOMAINS).toContain("intent");
    expect(TRANSITION_DOMAINS).toContain("run");
    expect(TRANSITION_DOMAINS).toContain("hypothesis");
    expect(TRANSITION_DOMAINS).toContain("approach");
  });

  it("invariant_repair is a legal trigger", () => {
    expect(TRANSITION_TRIGGERS).toContain("invariant_repair");
  });

  it("approach roles are defined", () => {
    expect(APPROACH_ROLES.length).toBeGreaterThanOrEqual(4);
    expect(APPROACH_ROLES).toContain("primary");
    expect(APPROACH_ROLES).toContain("control");
  });

  it("FAILURE_CLASSES has 5 classes", () => {
    expect(FAILURE_CLASSES).toEqual(["INFRA", "CODE", "POLICY", "VALIDATION", "IMPORT"]);
  });
});
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/lib/research/fsm/__tests__/enums.test.ts`
Expected: All tests PASS

- [ ] **Step 4: Update types.ts to re-export from enums.ts**

In `src/lib/research/fsm/types.ts`, add at the top:
```typescript
// Re-export frozen vocabularies from the canonical source
export {
  type ProjectLifecycleState as ProjectState,
  type RunLifecycleState as RunState,
  type HypothesisLifecycleState as HypothesisState,
  type FailureClass,
  type TransitionTrigger,
  type TransitionDomain,
  type CompletionCriterion,
  PROJECT_LIFECYCLE_STATES as PROJECT_STATES,
  RUN_LIFECYCLE_STATES as RUN_STATES,
  RUN_TERMINAL_STATES,
  HYPOTHESIS_LIFECYCLE_STATES as HYPOTHESIS_STATES,
  HYPOTHESIS_TERMINAL_STATES,
} from "./enums";
```

Remove the inline definitions of `PROJECT_STATES`, `RUN_STATES`, `HYPOTHESIS_STATES`, `FailureClass`, `RUN_TERMINAL_STATES`, `HYPOTHESIS_TERMINAL_STATES` from types.ts since they now come from enums.ts.

Keep the `PROJECT_TRANSITIONS`, `OPERATIONAL_STATUSES`, `TransitionRecord`, `DecisionRecord`, `GuardResult` definitions in types.ts — they are structural, not vocabulary.

- [ ] **Step 5: Run all existing tests to verify backward compat**

Run: `npx vitest run src/lib/research/fsm/__tests__/`
Expected: All existing tests still pass (types.ts re-exports are backward compatible)

- [ ] **Step 6: Stage and commit**

```bash
git add src/lib/research/fsm/enums.ts src/lib/research/fsm/__tests__/enums.test.ts src/lib/research/fsm/types.ts
git commit -m "feat(fsm-v2): freeze state vocabularies in enums.ts — single source of truth for all domains"
```

---

## Task 2: Schema Additions

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add ExperimentIntent model**

Add after the existing ExperimentRun model:

```prisma
model ExperimentIntent {
  id                    String   @id @default(cuid())
  projectId             String
  hypothesisId          String
  approachId            String
  protocolId            String
  scriptName            String
  scriptHash            String
  protocolHash          String
  args                  String?
  purpose               String             // BASELINE | MAIN_EVAL | TRAINING | ANALYSIS
  grounding             String?
  completionCriterion   String             // JSON: CompletionCriterion
  status                String   @default("DRAFT")
  supersedesIntentId    String?
  createdFromTransitionId String?
  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt

  project               ResearchProject    @relation(fields: [projectId], references: [id], onDelete: Cascade)
  hypothesis            ResearchHypothesis @relation(fields: [hypothesisId], references: [id])
  approach              ApproachBranch     @relation(fields: [approachId], references: [id])
  supersedes            ExperimentIntent?  @relation("IntentRevision", fields: [supersedesIntentId], references: [id])
  supersededBy          ExperimentIntent[] @relation("IntentRevision")
  runs                  ExperimentRun[]

  @@index([projectId])
  @@index([projectId, status])
  @@index([hypothesisId])
}
```

- [ ] **Step 2: Update ExperimentRun model**

Add new fields to existing ExperimentRun:

```prisma
  intentId        String?            // null for infrastructure runs
  kind            String   @default("research")  // "research" | "infrastructure"
  purpose         String?            // from intent or infrastructure purpose
  overlay         String?            // ACTIVE | BLOCKED. Null when terminal.
  seed            Int?
  condition       String?
  runKey          String?

  // Add relation
  intent          ExperimentIntent?  @relation(fields: [intentId], references: [id])

  // Add indexes
  @@index([intentId])
  @@unique([intentId, runKey])
```

- [ ] **Step 3: Add ExperimentAttempt model**

```prisma
model ExperimentAttempt {
  id                String   @id @default(cuid())
  runId             String
  attemptNumber     Int
  hostId            String?
  hostAlias         String?
  remoteJobId       String?  @unique
  isAutoFixResubmit Boolean  @default(false)
  startedAt         DateTime?
  completedAt       DateTime?
  lastHeartbeatAt   DateTime?
  exitCode          Int?
  failureClass      String?
  failureReason     String?
  createdAt         DateTime @default(now())

  run               ExperimentRun  @relation(fields: [runId], references: [id], onDelete: Cascade)
  remoteJob         RemoteJob?     @relation(fields: [remoteJobId], references: [id])

  @@index([runId])
  @@unique([runId, attemptNumber])
}
```

- [ ] **Step 4: Add HypothesisApproachLink model**

```prisma
model HypothesisApproachLink {
  id            String   @id @default(cuid())
  hypothesisId  String
  approachId    String
  role          String   // primary | control | ablation | comparison
  rationale     String?
  createdAt     DateTime @default(now())

  hypothesis    ResearchHypothesis @relation(fields: [hypothesisId], references: [id], onDelete: Cascade)
  approach      ApproachBranch     @relation(fields: [approachId], references: [id], onDelete: Cascade)

  @@unique([hypothesisId, approachId])
  @@index([hypothesisId])
  @@index([approachId])
}
```

- [ ] **Step 5: Add InvariantViolation model**

```prisma
model InvariantViolation {
  id                     String    @id @default(cuid())
  projectId              String
  invariantKey           String
  class                  String    // HARD | SOFT | AUDIT
  domain                 String    // project | intent | run | hypothesis | approach
  entityId               String
  message                String
  context                String?   // JSON
  status                 String    @default("OPEN")
  escalationPolicy       String?
  firstSeenAt            DateTime  @default(now())
  lastSeenAt             DateTime  @default(now())
  occurrenceCount        Int       @default(1)
  resolvedAt             DateTime?
  resolvedBy             String?
  repairedByTransitionId String?

  project                ResearchProject @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@index([projectId, status])
  @@index([invariantKey, entityId])
  @@unique([projectId, invariantKey, entityId, status])
}
```

- [ ] **Step 6: Add BlockingReason model**

```prisma
model BlockingReason {
  id          String    @id @default(cuid())
  projectId   String
  domain      String    // "project" | "run"
  entityId    String
  reason      String    // machine-readable
  detail      String?   // human-readable
  resolvedAt  DateTime?
  createdAt   DateTime  @default(now())

  project     ResearchProject @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@index([projectId, domain, entityId])
  @@index([entityId, resolvedAt])
}
```

- [ ] **Step 7: Update TransitionRecord model**

Replace the existing TransitionRecord with the v2 schema (add causality fields, guard context snapshot, entity version):

```prisma
model TransitionRecord {
  id                    String   @id @default(cuid())
  projectId             String
  domain                String
  entityId              String
  fromState             String
  toState               String
  trigger               String

  causedByEvent         String?
  causedByEntityType    String?
  causedByEntityId      String?
  agentSessionId        String?
  traceRunId            String?

  basis                 String
  guardsEvaluated       String?  // JSON: Record<string, { passed: boolean; detail: string }>

  entityVersion         String?
  guardContextHash      String?
  guardContextSnapshot  String?  // JSON

  createdAt             DateTime @default(now())

  project               ResearchProject @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@index([projectId])
  @@index([projectId, domain, createdAt])
  @@index([entityId])
  @@index([causedByEntityId])
}
```

- [ ] **Step 8: Add relations to existing models**

On ResearchProject, add:
```prisma
  intents             ExperimentIntent[]
  invariantViolations InvariantViolation[]
  blockingReasons     BlockingReason[]
```

On ResearchHypothesis, add:
```prisma
  intents             ExperimentIntent[]
  approachLinks       HypothesisApproachLink[]
```

On ApproachBranch, add:
```prisma
  intents             ExperimentIntent[]
  hypothesisLinks     HypothesisApproachLink[]
```

On ExperimentRun, add:
```prisma
  attempts            ExperimentAttempt[]
```

- [ ] **Step 9: Run migration**

```bash
npx prisma migrate dev --name fsm_v2_models
npx prisma generate
```

- [ ] **Step 10: Type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 11: Run all tests**

Run: `npx vitest run src/lib/research/fsm/__tests__/`
Expected: All tests pass

- [ ] **Step 12: Stage and commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "schema(fsm-v2): add ExperimentIntent, ExperimentAttempt, HypothesisApproachLink, InvariantViolation, BlockingReason, TransitionRecord v2"
```

---

## Task 3: Legacy Vocabulary Migration Script

**Files:**
- Create: `scripts/migrate-vocabulary-v2.ts`

- [ ] **Step 1: Write the migration script**

```typescript
// scripts/migrate-vocabulary-v2.ts
import { PrismaClient } from "../src/generated/prisma/client";

const prisma = new PrismaClient();

const HYPOTHESIS_STATUS_MAP: Record<string, string> = {
  PROPOSED: "PROPOSED",
  TESTING: "ACTIVE",
  SUPPORTED: "SUPPORTED",
  REFUTED: "RETIRED",
  REVISED: "REVISED",
};

const PROJECT_STATUS_MAP: Record<string, string> = {
  ACTIVE: "ACTIVE",
  PAUSED: "PAUSED",
  COMPLETED: "ARCHIVED",
  FAILED: "FAILED",
};

const APPROACH_STATUS_MAP: Record<string, string> = {
  active: "ACTIVE",
  abandoned: "ABANDONED",
  completed: "COMPLETED",
  ACTIVE: "ACTIVE",
  ABANDONED: "ABANDONED",
  COMPLETED: "COMPLETED",
};

async function migrate() {
  console.log("=== FSM v2 Vocabulary Migration ===\n");

  // 1. Hypothesis statuses
  const hypotheses = await prisma.researchHypothesis.findMany({
    select: { id: true, status: true },
  });
  let hypMigrated = 0;
  for (const h of hypotheses) {
    const newStatus = HYPOTHESIS_STATUS_MAP[h.status];
    if (newStatus && newStatus !== h.status) {
      await prisma.researchHypothesis.update({
        where: { id: h.id },
        data: { status: newStatus },
      });
      hypMigrated++;
    }
  }
  console.log(`Hypotheses: ${hypMigrated} migrated of ${hypotheses.length}`);

  // 2. Project statuses (overlay)
  const projects = await prisma.researchProject.findMany({
    select: { id: true, status: true },
  });
  let projMigrated = 0;
  for (const p of projects) {
    const newStatus = PROJECT_STATUS_MAP[p.status];
    if (newStatus && newStatus !== p.status) {
      await prisma.researchProject.update({
        where: { id: p.id },
        data: { status: newStatus },
      });
      projMigrated++;
    }
  }
  console.log(`Projects: ${projMigrated} migrated of ${projects.length}`);

  // 3. Approach statuses
  const approaches = await prisma.approachBranch.findMany({
    select: { id: true, status: true },
  });
  let appMigrated = 0;
  for (const a of approaches) {
    const newStatus = APPROACH_STATUS_MAP[a.status || "active"];
    if (newStatus && newStatus !== a.status) {
      await prisma.approachBranch.update({
        where: { id: a.id },
        data: { status: newStatus },
      });
      appMigrated++;
    }
  }
  console.log(`Approaches: ${appMigrated} migrated of ${approaches.length}`);

  console.log("\n=== Done ===");
}

migrate()
  .then(() => prisma.$disconnect())
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    prisma.$disconnect();
    process.exit(1);
  });
```

- [ ] **Step 2: Run the migration**

Run: `npx tsx scripts/migrate-vocabulary-v2.ts`
Expected: Counts of migrated rows printed

- [ ] **Step 3: Verify migration**

```bash
sqlite3 prisma/dev.db "SELECT status, COUNT(*) FROM ResearchHypothesis GROUP BY status;"
```
Expected: No TESTING or REFUTED values

```bash
sqlite3 prisma/dev.db "SELECT status, COUNT(*) FROM ResearchProject GROUP BY status;"
```
Expected: No COMPLETED values (should be ARCHIVED)

- [ ] **Step 4: Stage and commit**

```bash
git add scripts/migrate-vocabulary-v2.ts
git commit -m "chore(fsm-v2): vocabulary migration script — hypothesis, project, approach status values"
```

---

## Task 4: Invariant Test — Enums Used Consistently

**Files:**
- Modify: `src/lib/research/fsm/__tests__/invariants.test.ts`

- [ ] **Step 1: Add enum consistency tests**

Add to the existing invariants test file:

```typescript
import {
  PROJECT_LIFECYCLE_STATES,
  HYPOTHESIS_LIFECYCLE_STATES,
  APPROACH_LIFECYCLE_STATES,
  INTENT_LIFECYCLE_STATES,
  RUN_LIFECYCLE_STATES,
  TRANSITION_TRIGGERS,
} from "../enums";

describe("FSM invariant: vocabulary consistency", () => {
  it("project FSM states in types.ts match enums.ts", async () => {
    const { PROJECT_STATES } = await import("../types");
    expect([...PROJECT_STATES]).toEqual([...PROJECT_LIFECYCLE_STATES]);
  });

  it("run FSM states in types.ts match enums.ts", async () => {
    const { RUN_STATES } = await import("../types");
    expect([...RUN_STATES]).toEqual([...RUN_LIFECYCLE_STATES]);
  });

  it("hypothesis FSM states in types.ts match enums.ts", async () => {
    const { HYPOTHESIS_STATES } = await import("../types");
    expect([...HYPOTHESIS_STATES]).toEqual([...HYPOTHESIS_LIFECYCLE_STATES]);
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run src/lib/research/fsm/__tests__/`
Expected: All tests pass including new vocab consistency tests

- [ ] **Step 3: Full type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4: Stage and commit**

```bash
git add src/lib/research/fsm/__tests__/invariants.test.ts
git commit -m "test(fsm-v2): add vocabulary consistency invariant tests"
```
