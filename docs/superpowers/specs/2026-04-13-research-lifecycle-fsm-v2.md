# Research Lifecycle FSM v2

**Date:** 2026-04-13
**Status:** Draft (iterative — sections added as design decisions are finalized)
**Supersedes:** `2026-04-12-research-lifecycle-fsm.md` (v1)

## Design Authority

This spec is built from a live design conversation. Each section was reviewed and approved before the next was written. The conversation log is the authoritative source for "why" decisions were made.

## Principles

1. **Three orthogonal FSMs** — project progression, experiment lifecycle, hypothesis evidence. They do not share state vocabulary.
2. **Intent is the design artifact; Run is the execution artifact.** Intent answers "why this experiment exists." Run answers "what execution happened."
3. **Facts, intents, and transitions are the unit of truth** — not tool calls, not log entries, not agent opinions.
4. **Machine-evaluable, not agent-interpreted.** Guards, invariants, and completion criteria are boolean checks, not prose the LLM must interpret.
5. **State vocabulary is frozen per domain.** No shared terms across FSMs. No ambiguous reuse of "ACTIVE" or "COMPLETED" across domains without explicit scoping.

---

## 1. ExperimentIntent

The binding object that says: "this run exists to test hypothesis H via approach A with contract C under protocol P."

### Why it exists

Without ExperimentIntent, the connection between a hypothesis and an experiment is assembled ad-hoc from tool call arguments at submission time. The agent forgets, passes the wrong hypothesis_id, or omits the purpose. Intent eliminates this by making the binding a first-class persisted artifact created in DESIGN and consumed in EXECUTION.

### Schema

```prisma
model ExperimentIntent {
  id                   String   @id @default(cuid())
  projectId            String
  hypothesisId         String
  approachId           String             // every intent must be owned by an approach
  protocolId           String             // every intent must reference the protocol in effect
  scriptName           String             // the script this intent will execute
  scriptHash           String             // SHA-256 of the script content at intent validation time (DRAFT→READY)
  protocolHash         String             // SHA-256 of the evaluation protocol at validation time
  args                 String?            // CLI arguments
  purpose              String             // BASELINE | MAIN_EVAL | TRAINING | ANALYSIS (SMOKE and CALIBRATION use run_infrastructure, not intents)
  grounding            String?            // SYNTHETIC | EXTERNAL_DATASET | MODEL_INFERENCE | etc.
  completionCriterion  Json               // typed structure, see CompletionCriterion below
  status               String   @default("DRAFT")  // Intent FSM state
  supersedesIntentId   String?            // revision chain
  createdFromTransitionId String?         // which FSM transition created this
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt

  project              ResearchProject    @relation(fields: [projectId], references: [id], onDelete: Cascade)
  hypothesis           ResearchHypothesis @relation(fields: [hypothesisId], references: [id])
  approach             ApproachBranch     @relation(fields: [approachId], references: [id])
  supersedes           ExperimentIntent?  @relation("IntentRevision", fields: [supersedesIntentId], references: [id])
  supersededBy         ExperimentIntent[] @relation("IntentRevision")
  runs                 ExperimentRun[]

  @@index([projectId])
  @@index([projectId, status])
  @@index([hypothesisId])
}
```

### Intent FSM

```
DRAFT → READY → ACTIVE → { SATISFIED | EXHAUSTED | SUPERSEDED | CANCELLED }
```

| State | Meaning | Transition trigger |
|-------|---------|-------------------|
| **DRAFT** | Agent sketched it; references or contract may be incomplete | Agent calls `create_intent` |
| **READY** | System validated: hypothesis exists, approach exists, protocol exists, script exists, contract valid | System validation on creation or update |
| **ACTIVE** | One or more child runs exist and at least one is non-terminal | First child run created |
| **SATISFIED** | The intent's `completionCriterion` has been met | System evaluates criterion against child run outcomes |
| **EXHAUSTED** | All child runs are terminal and the criterion was not met | All runs terminal + criterion not satisfied |
| **SUPERSEDED** | Replaced by a revised intent (linked via `supersedesIntentId`) | New intent created with `supersedesIntentId = this.id` |
| **CANCELLED** | Explicitly withdrawn by agent or user | Agent/user action |

### Completion criteria

The `completionCriterion` field is a typed JSON structure (not a string mini-language). The system evaluates it mechanically. This is core engine input.

```typescript
type CompletionCriterion =
  | { type: "single_successful_run" }
  | { type: "min_runs"; count: number }
  | { type: "all_seeds_complete"; seeds: number[] }
  | { type: "comparison_against"; baselineIntentId: string; matchBy: "runKey" }
  | { type: "comparison_against"; baselineIntentId: string; matchBy: "seed"; seeds: number[] }
  | { type: "all_conditions_complete"; conditions: string[] }

// Examples:
// { type: "single_successful_run" }
// { type: "min_runs", count: 3 }
// { type: "all_seeds_complete", seeds: [42, 123, 456] }
// { type: "comparison_against", baselineIntentId: "int_001", matchBy: "runKey" }
// { type: "comparison_against", baselineIntentId: "int_001", matchBy: "seed", seeds: [42, 123, 456] }
```

**Evaluation rules:**

The system counts DONE child runs (runs with linked ExperimentResult — not just terminal runs) and checks against the criterion. SATISFIED requires the criterion to be met with result-bearing runs.

**`comparison_against` matching:**

This criterion is SATISFIED when:
1. This intent has at least 1 DONE run with a result, AND
2. The baseline intent (referenced by `baselineIntentId`) has at least 1 DONE run with a result, AND
3. A comparison has been recorded between matching run pairs.

Matching is determined by `matchBy`:
- `matchBy: "seed"` — pairs runs by `seed` field. Run with seed=42 in this intent is compared to run with seed=42 in baseline intent. Both must be DONE. If a seed exists in this intent but not in the baseline, the pair is unmatched and the criterion is NOT satisfied.
- `matchBy: "runKey"` — pairs runs by `runKey` field. Both must be DONE. If keys don't align, the criterion is NOT satisfied — no fallback, no guessing. The agent must ensure both intents use compatible `runKey` structures.

There is no "latest run" fallback. If pairing fails, the criterion fails closed. The agent can revise the intent with a different `matchBy` or ensure key alignment.

If the baseline intent has no DONE runs, this intent cannot be SATISFIED (it depends on the baseline).

### Tool API change

```
# DESIGN state:
create_intent({ hypothesis_id, approach_id, script, args, purpose, grounding, completion_criterion })
  → creates DRAFT intent
  → system auto-binds protocolId to the project's currently active evaluation protocol
  → system computes scriptHash and protocolHash
  → validates to READY if all references exist and contract is valid

# EXECUTION state:
run_experiment({ intent_id })
  → system materializes the next run (see materialization rules below)
  → submits it to remote host
  → intent transitions READY → ACTIVE on first run

# No free-form hypothesis/purpose arguments on run_experiment.
# The intent carries all context.
```

### Run materialization

When `run_experiment({ intent_id })` is called, the system materializes a concrete run. The rules depend on the intent's `completionCriterion`:

| Criterion type | Materialization rule |
|---------------|---------------------|
| `single_successful_run` | Target `runKey = "default"`. |
| `min_runs` | See min_runs rule below. |
| `all_seeds_complete` | Target `runKey = "seed=N"` for the first seed with no DONE run. |
| `all_conditions_complete` | Target `runKey = "condition=X"` for the first condition with no DONE run. |
| `comparison_against` with `matchBy: "runKey"` | Target `runKey = "default"`. Single run. Pairs against the baseline intent's `runKey = "default"` run. **Validation rule:** at intent creation, the baseline intent must have `single_successful_run` or `comparison_against` (runKey) criterion — i.e., it must also be a single-run intent. If the baseline is multi-seed/multi-condition, reject and require `matchBy: "seed"`. |
| `comparison_against` with `matchBy: "seed"` | Target `runKey = "seed=N"` for the first seed in `criterion.seeds` with no DONE run. Same logic as `all_seeds_complete`. Seeds are persisted on the criterion, not inferred from protocol or baseline. |

**`min_runs` materialization:** The system first checks for any FAILED/CANCELLED runs that can be reopened (priority: reopen before creating new). If none exist, target `runKey = "run_N"` where N = total run count + 1. This ensures failed runs are retried before new ordinals are created, so `min_runs=3` with run_1=DONE, run_2=FAILED, run_3=DONE reopens run_2 instead of creating run_4.

**The universal retry rule** (applies to all criterion types):

Once the target `runKey` is determined, the system checks whether a run with that key already exists under this intent:

| Existing run state | Action |
|-------------------|--------|
| No existing run | Create a new run in DRAFT. |
| Non-terminal (DRAFT, READY, QUEUED, RUNNING, IMPORTING) | Reject: "Run already in progress for this key." |
| DONE | Skip this key (already covered). Pick the next uncovered key, or reject if all keys are covered. |
| FAILED or CANCELLED | **Reopen the existing run:** reset state to READY, create a new ExperimentAttempt on it. No new run is created. The `@@unique([intentId, runKey])` constraint is never violated. |

This is the single deterministic rule for retries. A failed `runKey` is never permanently uncreatable — the existing run is reopened. Retries are always new attempts on the same run, not new runs.

**Other key rules:**
- Each `run_experiment` call processes at most 1 run. The agent calls it multiple times to fill multi-seed/multi-condition intents.
- The system determines `seed`, `condition`, and `runKey` — not the agent. The agent just says "run this intent."
- If the intent is already SATISFIED, `run_experiment` rejects: "Intent is already satisfied."
- `args` on the run are derived from `intent.args` plus the seed/condition override: e.g., `intent.args + " --seed 42"` for seed runs.
- New runs are created in DRAFT, validated to READY (preflight), then submitted. Reopened runs skip DRAFT and go directly to READY.

### Relationship to other FSMs

- **Project FSM:** DESIGN→EXECUTION requires at least 1 intent in READY. EXECUTION→ANALYSIS requires at least 1 intent in SATISFIED (not EXHAUSTED — exhausted intents produced no usable evidence). If all intents become EXHAUSTED/CANCELLED with none SATISFIED, the project transitions EXECUTION→DESIGN so the agent can create revised intents.
- **Hypothesis FSM:** When an intent becomes SATISFIED, the linked hypothesis can transition to EVALUATING (evidence exists). When EXHAUSTED, the hypothesis remains in its current state — the agent must create a revised intent in DESIGN.
- **Run FSM:** Runs are children of intents. Run terminal states feed into intent completion evaluation.

---

## 2. ExperimentRun as Authority, RemoteJob as Transport

### The three-layer hierarchy

| Layer | Owns | Example |
|-------|------|---------|
| **ExperimentRun** | Lifecycle truth. The FSM state. The verdict. The canonical result link. | "Run #7 is IMPORTING. It tested intent #3." |
| **ExperimentAttempt** | Retry/host-attempt truth. Which host, which attempt number, whether it was an auto-fix resubmit. | "Attempt 2 of run #7 ran on sparta-dimi-large-2, failed with CUDA OOM, auto-fixed." |
| **RemoteJob** | Adapter record. SSH command, stdout, stderr, polling state, lease. Pure transport — no lifecycle semantics. | "Job abc123 ran `python3 exp_007.py --seed 42`, exited 0, stdout is 4KB." |

### Ownership rules

1. **ExperimentRun is the only entity with an FSM.** The Run FSM (`DRAFT → READY → QUEUED → RUNNING → IMPORTING → DONE | FAILED | CANCELLED`) lives on ExperimentRun. ExperimentRun.state is the single durable authority for the lifecycle of an experiment. In-flight transitions (QUEUED→RUNNING, RUNNING→IMPORTING) are written to ExperimentRun.state by the reconciler — not inferred, not derived.

2. **ExperimentAttempt is an append-only log of execution attempts.** Each time a run is submitted (or resubmitted after auto-fix), a new attempt is created. Attempts record: host, startedAt, completedAt, exitCode, failureClass, whether it was an auto-fix resubmit. Attempts never transition — they are facts.

3. **RemoteJob is an adapter record.** It stores everything the SSH/helper layer needs: command, stdout, stderr, workspace path, lease info, polling state. The remote executor reads/writes RemoteJob. RemoteJob has an adapter-internal status (`SYNCING | POLLING | COMPLETED | ERROR`) that the remote executor manages for its own bookkeeping. This is NOT the lifecycle state.

4. **The reconciler bridges adapter state to lifecycle state.** The reconciler is the only code path that writes to ExperimentRun.state. It reads RemoteJob adapter status and ExperimentAttempt facts, evaluates the Run FSM, and persists the transition on ExperimentRun. This runs on polling ticks and on job completion events. The key guarantee: ExperimentRun.state is always durably written and is the single source of truth for "what state is this run in?" — including in-flight states like RUNNING.

5. **State flows upward, not sideways.** Remote executor → RemoteJob → reconciler → ExperimentAttempt + ExperimentRun → intent evaluation → project FSM. At no point do two layers write to each other's tables.

### Schema

```prisma
model ExperimentRun {
  id              String   @id @default(cuid())
  intentId        String?            // null for infrastructure runs
  projectId       String
  kind            String             // "research" | "infrastructure" — persisted at creation, immutable
  purpose         String?            // BASELINE | MAIN_EVAL | TRAINING | ANALYSIS (from intent) or SMOKE | CALIBRATION (infrastructure)
  state           String   @default("DRAFT")  // Run FSM: DRAFT | READY | QUEUED | RUNNING | IMPORTING | DONE | FAILED | CANCELLED
  overlay         String?  // Run overlay: ACTIVE | BLOCKED. Null when state is terminal (DONE, FAILED, CANCELLED) — terminal runs have no operational status.
  failureClass    String?  // INFRA | CODE | POLICY | VALIDATION | IMPORT (only when state = FAILED)
  verdict         String?  // better | worse | inconclusive | pending_analysis
  resultId        String?  @unique  // links to ExperimentResult when DONE

  // ── Run identity: what makes this run semantically distinct ──
  // These fields are set at run creation and are immutable.
  // The engine uses them to evaluate intent completion criteria mechanically.
  seed            Int?               // random seed for this run (for all_seeds_complete criterion)
  condition       String?            // experiment condition label (for all_conditions_complete criterion)
  runKey          String?            // unique key within the intent: e.g., "seed=42" or "condition=grpo_pure"
                                     // used for deduplication and criterion matching

  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  intent          ExperimentIntent?  @relation(fields: [intentId], references: [id])
  project         ResearchProject    @relation(fields: [projectId], references: [id], onDelete: Cascade)
  result          ExperimentResult?  @relation(fields: [resultId], references: [id])
  attempts        ExperimentAttempt[]

  @@index([projectId])
  @@index([intentId])
  @@index([projectId, state])
  @@unique([intentId, runKey])  // one run per key per intent
}

model ExperimentAttempt {
  id              String   @id @default(cuid())
  runId           String
  attemptNumber   Int
  hostId          String?
  hostAlias       String?
  remoteJobId     String?  @unique  // links to the adapter record
  isAutoFixResubmit Boolean @default(false)
  startedAt       DateTime?
  completedAt     DateTime?
  lastHeartbeatAt DateTime?          // updated by reconciler on each polling tick; used by run.running_requires_heartbeat invariant
  exitCode        Int?
  failureClass    String?  // INFRA | CODE | POLICY | VALIDATION | IMPORT
  failureReason   String?
  createdAt       DateTime @default(now())

  run             ExperimentRun  @relation(fields: [runId], references: [id], onDelete: Cascade)
  remoteJob       RemoteJob?     @relation(fields: [remoteJobId], references: [id])

  @@index([runId])
  @@unique([runId, attemptNumber])
}
```

RemoteJob keeps its existing schema but loses all lifecycle semantics. Its `status` field becomes an adapter-internal field (`SYNCING | POLLING | COMPLETED | ERROR`) that the remote executor manages.

**Who reads what — the strict rule:**

| Component | Reads | Writes |
|-----------|-------|--------|
| **Remote executor** | RemoteJob | RemoteJob (stdout, stderr, adapter status) |
| **Reconciler** | RemoteJob.adapter status + ExperimentAttempt | ExperimentAttempt (heartbeat, exitCode, failureClass) + ExperimentRun.state (FSM transitions) + ExperimentRun.overlay (BLOCKED when host unreachable/lease expired; ACTIVE when cleared) + BlockingReason (create/resolve) |
| **FSM guards / invariants** | ExperimentRun.state + ExperimentRun.overlay + ExperimentAttempt fields | Never — guards are read-only evaluators |
| **Transition engine** | ExperimentRun.state (via guards) | ExperimentRun.state (via transitions) |
| **Invariant engine** | ExperimentRun.overlay + BlockingReason | InvariantViolation (create) + ExperimentRun.overlay (repair: clear stale BLOCKED) |

The reconciler is the **only bridge** between adapter state and lifecycle state. It reads RemoteJob adapter status to know "the SSH job reported running" and writes ExperimentRun.state to record "the run is now RUNNING." This is not the FSM reading RemoteJob — it is the reconciler translating adapter facts into lifecycle transitions. The FSM guards and invariants never touch RemoteJob directly.

### Reconciliation flow

```
Remote executor finishes a job:
  1. Updates RemoteJob (stdout, stderr, exit code)
  2. Creates/updates ExperimentAttempt (completedAt, exitCode, failureClass)
  3. Calls reconcileRunState(runId)

reconcileRunState:
  1. Reads all attempts for the run
  2. Evaluates: did any attempt succeed? Are all attempts terminal?
  3. Transitions ExperimentRun via the Run FSM
  4. If DONE: triggers result import, links ExperimentResult
  5. If FAILED: checks if auto-fix is eligible, creates new attempt if so
  6. Evaluates intent completion criterion (may transition intent to SATISFIED/EXHAUSTED)
```

### What gets removed

- ExperimentRun no longer duplicates RemoteJob fields (command, hypothesis, host info)
- RemoteJob no longer drives lifecycle decisions
- The `recoverProjectRemoteResults` / `cleanupStaleJobs` reconciliation path is replaced by the structured reconciler
- No more "check RemoteJob.status and also check ExperimentRun.state and hope they agree"

## 3. State Vocabulary Freeze

### Rule

> Overlay vocabularies are domain-scoped subsets drawn from a shared semantic lexicon. A term may only appear in a domain overlay if it is not already represented as a lifecycle state in that domain.

This section is a prerequisite for implementation. No code changes until these enums are locked.

### Project Lifecycle

| State | Meaning |
|-------|---------|
| `DISCOVERY` | Literature search, paper processing, cross-paper synthesis |
| `HYPOTHESIS` | Formulate testable hypotheses, register approaches |
| `DESIGN` | Define metrics, evaluation protocol, create experiment intents |
| `EXECUTION` | Run experiments against intents |
| `ANALYSIS` | Interpret results, update hypotheses, record claims |
| `DECISION` | Gated adjudication: iterate, pivot, or conclude |
| `COMPLETE` | Research concluded |

Legal forward transitions: DISCOVERY→HYPOTHESIS→DESIGN→EXECUTION→ANALYSIS→DECISION→{DESIGN,HYPOTHESIS,COMPLETE}. Additional: EXECUTION→DESIGN (when all intents exhausted/cancelled — auto). Backward transitions (DESIGN→HYPOTHESIS, HYPOTHESIS→DISCOVERY) require explicit decision, never auto.

### Project Overlay

| Status | Meaning |
|--------|---------|
| `ACTIVE` | Normal operation |
| `PAUSED` | Intentionally suspended (user action or stagnation detection) |
| `BLOCKED` | Cannot proceed; waiting on external resolution. Requires a `BlockingReason` record (see below). |
| `FAILED` | Control-plane failure (not a research failure — those are hypothesis outcomes) |
| `ARCHIVED` | Completed and archived for reference |

### Blocking Reason (durable model for BLOCKED overlay)

When an entity's overlay is set to BLOCKED, a `BlockingReason` record must be created in the same transaction. When the overlay is cleared, the reason is resolved. The invariant `project.blocked_requires_reason` enforces this.

```prisma
model BlockingReason {
  id              String   @id @default(cuid())
  projectId       String
  domain          String   // "project" | "run"
  entityId        String
  reason          String   // machine-readable: "host_offline" | "workspace_locked" | "lease_expired" | "dependency_unavailable"
  detail          String?  // human-readable context
  resolvedAt      DateTime?
  createdAt       DateTime @default(now())

  project         ResearchProject @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@index([projectId, domain, entityId])
  @@index([entityId, resolvedAt])
}
```

Rules:
- Setting overlay to BLOCKED without creating a BlockingReason is a hard invariant violation.
- Clearing BLOCKED overlay must resolve all open BlockingReasons for that entity in the same transaction.
- `getStateReport` surfaces open BlockingReasons as part of the current-state summary.

### Intent Lifecycle

| State | Meaning |
|-------|---------|
| `DRAFT` | Agent sketched it; references or contract may be incomplete |
| `READY` | System validated: all references exist, contract valid |
| `ACTIVE` | One or more child runs exist, at least one non-terminal |
| `SATISFIED` | Completion criterion met |
| `EXHAUSTED` | All child runs terminal, criterion not met |
| `SUPERSEDED` | Replaced by a revised intent |
| `CANCELLED` | Explicitly withdrawn |

No overlay for intents. Intent state is always lifecycle state.

### Run Lifecycle

| State | Meaning |
|-------|---------|
| `DRAFT` | Run record created, prerequisites not yet checked |
| `READY` | Preflight passed, host resolved |
| `QUEUED` | Submitted to remote host, waiting for slot |
| `RUNNING` | Actively executing |
| `IMPORTING` | Execution complete, importing results/artifacts |
| `DONE` | Results imported, metrics recorded |
| `FAILED` | Terminal failure (cause in `failureClass`) |
| `CANCELLED` | Explicitly cancelled |

`failureClass` (data, not state): `INFRA | CODE | POLICY | VALIDATION | IMPORT`

### Run Overlay

| Status | Meaning |
|--------|---------|
| `ACTIVE` | Normal execution in progress |
| `BLOCKED` | Waiting on external resolution (host down, workspace locked, etc.) |

No `PAUSED` (resumable execution is not a real capability). No `FAILED` (failure is lifecycle, not overlay). No `ARCHIVED`.

### Hypothesis Lifecycle

| State | Meaning |
|-------|---------|
| `PROPOSED` | Formulated, not yet under test |
| `ACTIVE` | Linked to at least one non-terminal intent or run |
| `EVALUATING` | All linked experiments terminal, adjudication in progress |
| `SUPPORTED` | Evidence supports the hypothesis |
| `CONTESTED` | Evidence is mixed or contradictory |
| `REVISED` | Modified based on evidence, new version exists |
| `RETIRED` | Abandoned (refuted, superseded, or out of scope) |

No overlay for hypotheses. Hypothesis state is always lifecycle state.

### Approach Lifecycle

| State | Meaning |
|-------|---------|
| `PROPOSED` | Registered, not yet committed to |
| `COMMITTED` | Agent has committed to pursue this approach |
| `ACTIVE` | At least one linked intent exists |
| `COMPLETED` | All linked intents are SATISFIED or EXHAUSTED; approach has produced results |
| `ABANDONED` | Explicitly abandoned by agent or user |

No overlay for approaches. Approach state is always lifecycle state.

### Transition Trigger Vocabulary

| Trigger | Meaning |
|---------|---------|
| `auto` | Guard-satisfied auto-transition at session boundary |
| `agent` | Agent explicitly invoked a tool that caused the transition |
| `user` | User action (UI button, manual reset) |
| `system` | System initialization or migration |
| `reconciler` | Reconciler bridging adapter state to lifecycle state (run FSM) |
| `invariant_repair` | Invariant engine detected impossible state and repaired it |

This enum applies to `TransitionRecord.trigger` across all domains. No other values are legal.

### Legacy Mapping

| Current schema field | Current values | New domain | New values | Migration |
|---------------------|----------------|------------|------------|-----------|
| `ResearchProject.currentPhase` | DISCOVERY, HYPOTHESIS, DESIGN, EXECUTION, ANALYSIS, DECISION, COMPLETE | Project Lifecycle | Same | Already migrated in v1 |
| `ResearchProject.status` | ACTIVE, PAUSED, COMPLETED, FAILED | Project Overlay | ACTIVE, PAUSED, ARCHIVED, FAILED | Rename COMPLETED→ARCHIVED |
| `ResearchHypothesis.status` | PROPOSED, TESTING, SUPPORTED, REFUTED, REVISED | Hypothesis Lifecycle | PROPOSED, ACTIVE, EVALUATING, SUPPORTED, CONTESTED, REVISED, RETIRED | TESTING→ACTIVE, REFUTED→RETIRED, add EVALUATING and CONTESTED |
| `ExperimentRun.state` | QUEUED, STARTING, RUNNING, SUCCEEDED, FAILED, CANCELLED, BLOCKED | Run Lifecycle | DRAFT, READY, QUEUED, RUNNING, IMPORTING, DONE, FAILED, CANCELLED | STARTING→READY, SUCCEEDED→DONE, BLOCKED removed (becomes overlay), add DRAFT and IMPORTING |
| `RemoteJob.status` | SYNCING, QUEUED, RUNNING, COMPLETED, FAILED, CANCELLED | Adapter-internal | SYNCING, POLLING, COMPLETED, ERROR | Drop lifecycle semantics; adapter-only field |
| `ApproachBranch.status` | active, abandoned, completed (lowercase, informal) | Approach Lifecycle | PROPOSED, COMMITTED, ACTIVE, COMPLETED, ABANDONED | active→ACTIVE, abandoned→ABANDONED, completed→COMPLETED, add PROPOSED and COMMITTED |

### Deprecation plan

1. Freeze the enums above in a shared `src/lib/research/fsm/enums.ts` file
2. Add TypeScript string literal types for each domain
3. Migration script converts all existing rows to the new vocabulary
4. Remove all raw string comparisons against old values (`=== "TESTING"`, `=== "REFUTED"`, etc.)
5. Old values remain readable in TransitionRecord history but are never written after migration

## 4. Causality Model for Transitions

### Principle

> A transition should be attributable to the canonicalized guard context, not just to the entity row being transitioned.

Every transition records three levels of provenance:

1. **What triggered it** — the event or action that caused the guard to be evaluated
2. **What the system believed** — the full guard context at decision time
3. **What entity was transitioned** — the row version for optimistic concurrency

### TransitionRecord (revised)

```prisma
model TransitionRecord {
  id                    String   @id @default(cuid())
  projectId             String
  domain                String   // "project" | "intent" | "run" | "hypothesis" | "approach"
  entityId              String   // the ID of the entity that transitioned

  fromState             String
  toState               String
  trigger               String   // "auto" | "agent" | "user" | "system" | "reconciler" | "invariant_repair"

  // ── Causality ──
  causedByEvent         String?  // what happened: "run_completed" | "intent_created" | "metrics_defined" | "session_boundary" | etc.
  causedByEntityType    String?  // which entity caused it: "ExperimentRun" | "ExperimentIntent" | "AgentSession" | etc.
  causedByEntityId      String?  // the specific entity ID
  agentSessionId        String?  // which agent session was active when this fired
  traceRunId            String?  // links to the run-level trace for debugging

  // ── Guard evaluation ──
  basis                 String   // human-readable summary of why
  guardsEvaluated       String?  // JSON: Record<string, { passed: boolean; detail: string }>
                                 // Must match the structure returned by guard evaluators and consumed by explainTransition.
                                 // Persisted at transition time with full detail, not reconstructed later.

  // ── State hashes ──
  entityVersion         String?  // hash of the transitioned entity's canonical fields at decision time
  guardContextHash      String?  // hash of the full normalized guard context
  guardContextSnapshot  String?  // JSON: the full facts the guard evaluated (for high-value transitions)

  createdAt             DateTime @default(now())

  project               ResearchProject @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@index([projectId])
  @@index([projectId, domain, createdAt])
  @@index([entityId])
  @@index([causedByEntityId])
}
```

### Guard context snapshot

The `guardContextSnapshot` is a canonicalized JSON of all facts the guard used to make its decision. It must be deterministic — same logical state always produces the same snapshot.

**Canonicalization rules:**
- Arrays sorted by ID (stable order)
- Object keys sorted alphabetically
- Timestamps normalized to epoch milliseconds
- Only structurally relevant fields included (not updatedAt, not metadata blobs)

**Example** for EXECUTION→ANALYSIS:

```json
{
  "doneRunCount": 3,
  "doneNonSmokeRunCount": 2,
  "newDoneNonSmokeRunCount": 1,
  "doneRunIds": ["abc123", "def456"],
  "lastEnteredExecutionAt": 1744520000000,
  "activeIntentIds": ["int_001"],
  "satisfiedIntentCount": 1
}
```

**When to persist the full snapshot vs. just the hash:**

| Transition type | Persist snapshot? |
|----------------|-------------------|
| Project FSM transitions | Always — these are rare and high-value |
| Intent state changes | For SATISFIED, EXHAUSTED, SUPERSEDED — decision points |
| Run state changes | Hash only — too frequent for full snapshots |
| Hypothesis state changes | For terminal states (SUPPORTED, CONTESTED, RETIRED) |

### DecisionRecord

For DECISION state transitions specifically, the TransitionRecord is extended with typed metadata in `guardContextSnapshot`:

```json
{
  "decisionType": "iterate",
  "hypothesesConsidered": ["hyp_001", "hyp_002"],
  "hypothesisStates": { "hyp_001": "SUPPORTED", "hyp_002": "EVALUATING" },
  "satisfiedIntents": ["int_003"],
  "exhaustedIntents": ["int_001"],
  "openObligations": 0,
  "evidenceSummary": "1 supported, 1 still evaluating. Coordinator has no open obligations.",
  "chosenTransition": "DECISION->DESIGN",
  "alternativesConsidered": ["DECISION->COMPLETE (blocked: hyp_002 still evaluating)"]
}
```

This is not a separate model — it's structured content within the existing TransitionRecord. The `domain = "project"` and `fromState = "DECISION"` fields identify it.

## 5. Invariant Engine

### Principle

> Guards tell you whether you may move forward. Invariants tell you whether the whole system is currently sane.

> Soft invariants are time-bounded tolerances. Each soft invariant defines an escalation policy based on persistence duration and/or repeated re-observation, after which it becomes either hard-failing or transition-blocking.

### Invariant classes

| Class | Meaning | On violation |
|-------|---------|-------------|
| **HARD** | Impossible state. The world is broken. | Block transitions. Attempt repair via a formal transition (see below). If repair fails, escalation is domain-specific: projects → set overlay to FAILED; runs → mark state FAILED with failureClass=INFRA; intents/hypotheses/approaches → log unresolvable violation and surface via getStateReport. |
| **SOFT** | Suspicious but tolerated briefly. | Track with `firstSeenAt`, `lastSeenAt`, `occurrenceCount`. Escalate per policy. |
| **AUDIT** | Worth logging. Not actionable. | Write to invariant log. No enforcement. |

### Invariant repairs are formal transitions

> Every invariant repair that changes entity state must emit a TransitionRecord with `trigger = "invariant_repair"` and `causedByEvent` referencing the invariant key. There are no hidden state changes.

This means:
- `run.done_requires_result` repair (revert DONE → FAILED) emits a TransitionRecord: `{ domain: "run", from: "DONE", to: "FAILED", trigger: "invariant_repair", causedByEvent: "run.done_requires_result", ... }`
- `project.analysis_requires_done_runs` repair (revert ANALYSIS → EXECUTION) emits a TransitionRecord on the project
- The InvariantViolation record links to the repair TransitionRecord via a `repairedByTransitionId` field

This ensures the audit trail has no gaps — every state change, whether triggered by the agent, the auto-transition engine, or the invariant repair system, is a first-class recorded transition.

### Soft invariant escalation

Soft invariants persist as tracked violations, not transient checks. Each defines an escalation policy:

| Escalation mode | Meaning |
|----------------|---------|
| **SOFT → HARD** | Indicates corruption if it persists. Triggers repair-or-fail. |
| **SOFT → BLOCKING_SOFT** | Not corruption, but stops forward progress until resolved. Transitions blocked, overlay not changed. |

TTL is policy-based per invariant, not a global timeout.

### Schema

```prisma
model InvariantViolation {
  id                String   @id @default(cuid())
  projectId         String
  invariantKey      String   // unique key: "project.analysis_requires_done_runs"
  class             String   // HARD | SOFT | AUDIT
  domain            String   // project | intent | run | hypothesis | approach
  entityId          String
  message           String
  context           String?  // JSON: the facts that triggered the violation
  status            String   @default("OPEN")  // OPEN | ESCALATED | RESOLVED | SUPPRESSED
  escalationPolicy  String?  // e.g., "hard_after_300s" | "blocking_after_session_end"
  firstSeenAt       DateTime @default(now())
  lastSeenAt        DateTime @default(now())
  occurrenceCount   Int      @default(1)
  resolvedAt        DateTime?
  resolvedBy         String?  // "invariant_repair" | "transition" | "user" | "suppressed"
  repairedByTransitionId String?  // links to the TransitionRecord emitted by the repair

  project           ResearchProject @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@index([projectId, status])
  @@index([invariantKey, entityId])
  @@unique([projectId, invariantKey, entityId, status])
}
```

### Invariant catalog

#### Hard invariants

| Key | Domain | Rule | Repair |
|-----|--------|------|--------|
| `project.analysis_requires_done_runs` | project | Project in ANALYSIS with zero DONE runs is impossible | Revert to EXECUTION |
| `project.execution_requires_live_intent` | project | Project in EXECUTION with zero intents in READY, ACTIVE, or SATISFIED is impossible (all cancelled/exhausted/superseded with nothing live) | Transition EXECUTION→DESIGN (legal transition — agent creates revised intents) |
| `run.done_requires_result` | run | Run in DONE with no linked ExperimentResult is impossible | Trigger result import; if import fails, revert run to FAILED with failureClass=IMPORT. Never fabricate a placeholder result — that masks the failure and pollutes downstream analysis/claims. |
| `intent.active_requires_runs` | intent | Intent in ACTIVE with zero child runs is impossible | Revert to READY |
| `intent.satisfied_requires_criterion` | intent | Intent in SATISFIED where completionCriterion is not actually met | Re-evaluate criterion; revert to ACTIVE if wrong |

#### Soft invariants (with escalation policy)

| Key | Domain | Rule | TTL | Escalation |
|-----|--------|------|-----|-----------|
| `hypothesis.active_requires_intent` | hypothesis | Hypothesis in ACTIVE with no linked intent | 60s | → BLOCKING_SOFT (don't advance project until resolved) |
| `hypothesis.active_all_terminal` | hypothesis | Hypothesis in ACTIVE but all linked intents are terminal (SATISFIED/EXHAUSTED/CANCELLED) | 30s | → HARD (transition hypothesis to EVALUATING — all evidence is in, adjudication needed) |
| `hypothesis.evaluating_has_nonterminal` | hypothesis | Hypothesis in EVALUATING but at least one linked intent is non-terminal (READY/ACTIVE) | 30s | → HARD (revert hypothesis to ACTIVE — new evidence is still being produced) |
| `run.running_requires_heartbeat` | run | Run in RUNNING with no attempt heartbeat for 10+ minutes | 600s | → HARD (mark run FAILED with INFRA) |
| `project.blocked_requires_reason` | project | Project overlay BLOCKED with no active blocking reason | 120s | → HARD (clear overlay to ACTIVE) |
| `run.blocked_requires_reason` | run | Run overlay BLOCKED with no active BlockingReason record | 60s | → HARD (clear overlay to ACTIVE) |
| `intent.active_stale` | intent | Intent in ACTIVE for 4+ hours with no run progress | 14400s | → BLOCKING_SOFT (surface to agent/user) |

#### Audit invariants

| Key | Domain | Rule |
|-----|--------|------|
| `project.many_intents_no_satisfied` | project | 5+ intents, zero SATISFIED — possible design problem |
| `hypothesis.many_revised` | hypothesis | Same hypothesis revised 3+ times — possible scope problem |
| `run.many_failures_same_script` | run | Same script failed 3+ times — possible code/environment problem |
| `approach.orphan_no_hypothesis` | approach | Approach with zero HypothesisApproachLink entries — orphan approach |

### Execution model

Invariants run on **relevant writes**, not on a timer. Each write operation that modifies FSM-relevant state triggers the invariant checker for the affected entity:

- ExperimentRun state change → check `run.*` invariants for that run + `intent.*` for parent intent + `project.*` for parent project
- ExperimentIntent state change → check `intent.*` invariants for that intent + `project.*` for parent project + `hypothesis.*` for linked hypothesis
- Project state change → check `project.*` invariants
- Hypothesis state change → check `hypothesis.*` invariants
- ApproachBranch or HypothesisApproachLink change → check `approach.*` invariants for that approach

The checker runs **in the same transaction** as the write. This is not optional — "immediately after" permits transient impossible states and unaudited repair windows. Concretely:

- The state change, the invariant check, the violation record (if any), and the repair transition (if any) are all in one `$transaction` call.
- If the invariant check fails and repair is needed, the repair transition is written in the same transaction.
- If the transaction fails, the state change is rolled back — the impossible state never persists.

Hard violations block the triggering operation by aborting the transaction. Soft violations are recorded in the same transaction and checked for escalation at session boundaries.

### Escalation checker

A lightweight background check runs periodically (or at session boundaries) to evaluate soft violation TTLs:

```
for each OPEN soft violation:
  if now - firstSeenAt > ttl:
    escalate per policy (HARD or BLOCKING_SOFT)
    update status to ESCALATED
```

This does not need to be real-time. Session boundary evaluation (the same place auto-transitions fire) is sufficient.

## 6. Deterministic "Why" Layer

### Principle

> The FSM must have a formal API surface for explaining its decisions — not richer logs, but importable functions that the UI, CLI, agent system prompt, and debugging scripts all consume.

Three functions, each answering a different debugging question:

### 6.1 `explainTransition(transitionId)`

**Question:** "Why did the system do that?"

**Retrospective.** Explains a past transition from the persisted TransitionRecord.

```typescript
interface TransitionExplanation {
  transitionId: string;
  domain: string;
  entityId: string;
  from: string;
  to: string;
  trigger: string;
  
  // Causality
  causedByEvent: string | null;
  causedByEntity: { type: string; id: string } | null;
  agentSessionId: string | null;
  
  // Guard evaluation at decision time
  guardsEvaluated: Record<string, { passed: boolean; detail: string }>;
  guardContextSnapshot: Record<string, unknown> | null;
  guardContextHash: string | null;
  entityVersion: string | null;
  
  // Human-readable
  summary: string;  // "Auto-transition fired because 2 new non-SMOKE experiments completed since entering EXECUTION"
  timestamp: Date;
}

function explainTransition(transitionId: string): Promise<TransitionExplanation>
```

Source of truth: the `TransitionRecord` row + its `guardContextSnapshot`.

### 6.2 `explainBlocker(entityType, entityId, targetState)`

**Question:** "Why won't the system do this?"

**Prospective.** Evaluates the current guard for a specific transition and reports what's failing and what would satisfy it.

```typescript
interface BlockerExplanation {
  entityType: string;  // "project" | "intent" | "run" | "hypothesis" | "approach"
  entityId: string;
  currentState: string;
  targetState: string;
  isValidTransition: boolean;
  
  // What's failing
  failingChecks: Array<{
    check: string;       // "real_experiment_done"
    detail: string;      // "No new non-SMOKE experiments since entering EXECUTION (1 total historical)"
    whatWouldSatisfy: string;  // "Complete at least 1 non-SMOKE experiment"
  }>;
  
  // What's passing
  passingChecks: Array<{
    check: string;
    detail: string;
  }>;
  
  // Active invariant violations that may be related
  relatedViolations: Array<{
    invariantKey: string;
    class: string;
    message: string;
  }>;
}

function explainBlocker(
  entityType: string,
  entityId: string,
  targetState: string,
): Promise<BlockerExplanation>
```

Source of truth: current guard evaluation against live DB state.

### 6.3 `getStateReport(entityType, entityId)`

**Question:** "What's the full picture right now?"

**Current-state summary.** The common surface for UI, CLI, agent directives, and debug scripts.

```typescript
interface StateReport {
  entityType: string;
  entityId: string;
  
  // Current state
  lifecycleState: string;
  operationalOverlay: string | null;  // only for domains that have overlays
  
  // What can happen next
  possibleTransitions: Array<{
    targetState: string;
    isAutoEligible: boolean;
    guardSatisfied: boolean;
    blockerSummary: string | null;  // null if guard is satisfied
  }>;
  
  // Active invariant violations
  openViolations: Array<{
    invariantKey: string;
    class: string;
    message: string;
    firstSeenAt: Date;
    escalationPolicy: string | null;
  }>;
  
  // Recent transitions (last 5)
  recentTransitions: Array<{
    id: string;
    from: string;
    to: string;
    trigger: string;
    summary: string;
    timestamp: Date;
  }>;
  
  // Domain-specific context
  context: Record<string, unknown>;
  // For projects: { intentsSummary, runsSummary, hypothesesSummary }
  // For intents: { childRunsSummary, completionCriterion, criterionMet }
  // For runs: { attemptCount, currentAttempt, hostAlias, overlay }
  // For hypotheses: { linkedIntents, linkedClaims, evidenceSummary }
  // For approaches: { linkedHypotheses, linkedIntents, orphanStatus }
}

function getStateReport(
  entityType: string,
  entityId: string,
): Promise<StateReport>
```

### Consumers

| Consumer | Uses | Purpose |
|----------|------|---------|
| **UI (research dashboard)** | `getStateReport` | Show state, blockers, recent transitions in the right panel |
| **Agent system prompt** | `getStateReport` for project | "YOUR IMMEDIATE TASK" directive derived from current state + blockers |
| **RESEARCH_STATE.md** | `getStateReport` for project | Auto-generated state file the agent reads |
| **CLI trace tool** | `explainTransition` | `npm run trace <project> --explain-transition <id>` |
| **CLI debug** | `explainBlocker` | `npm run debug <project> --why-not <target-state>` |
| **Invariant checker** | `getStateReport` internally | Reads state to evaluate invariants |
| **Transition engine** | `explainBlocker` internally | Guards are evaluated through the same path |

### Implementation note

`explainBlocker` and the transition engine's guard evaluation should use the **same code path**. The guard evaluator returns structured results (not just boolean), and `explainBlocker` wraps that with the `whatWouldSatisfy` layer. This prevents divergence between "what the engine checks" and "what the explanation says."

## 7. Sandbox / Replay

### Principle

> Store the data needed for replay now. Build the replay tools later. This is cheap now and expensive later if omitted.

### What to store now (v2 implementation)

All three are already specified in other sections. This section makes the commitment explicit:

| Data | Source section | Purpose for future replay |
|------|---------------|--------------------------|
| `TransitionRecord.guardContextSnapshot` | Section 4 | Reconstruct what the engine believed at each decision point |
| `TransitionRecord.guardContextHash` | Section 4 | Detect whether replaying the same context would produce the same decision |
| `TransitionRecord.causedBy*` fields | Section 4 | Reconstruct the causal chain of events |
| `InvariantViolation` history | Section 5 | Understand when the system was inconsistent and how it recovered |
| `ExperimentAttempt` log | Section 2 | Reconstruct retry/failure history per run |
| `AGENT_TRACE.jsonl` per workspace | Existing | Full agent reasoning + tool calls per session |

### What to build later (not in v2)

| Capability | Description | Prerequisite |
|-----------|-------------|--------------|
| **ProjectSnapshot** | Freeze full project state at a checkpoint (all entities, counts, relationships) | Stable schema + vocabulary freeze |
| **FSMReplay** | Given a TransitionRecord chain, replay guard evaluations and verify each transition would still fire | `explainTransition` API (section 6) |
| **GuardSimulation** | "What if" mode: manually inject a guard context and see which transitions would fire | Guard evaluators already pure functions (v1) |
| **ProjectClone** | Clone a project at a checkpoint for debugging in isolation | ProjectSnapshot + stable schema |

### Design constraint for v2

All transition-relevant data must be written to durable storage (not just console.log or in-memory). If a transition fires and the process crashes before the TransitionRecord is written, the transition is unauditable. Therefore:

> TransitionRecord writes must be in the same transaction as the state change they record.

## 8. Coordinator Outputs in DECISION

### Principle

> DECISION consumes project facts plus downstream governance obligations. COMPLETE is only reachable if both research progression and credibility closure are satisfied.

The project FSM remains authoritative. The coordinator does not drive transitions — it provides facts that the DECISION guard evaluates.

### DECISION guard (revised)

DECISION evaluates two independent axes before choosing a transition:

**Axis 1: Research progression**
- Are all hypotheses adjudicated? (SUPPORTED, CONTESTED, REVISED, or RETIRED — not ACTIVE or EVALUATING)
- Is there at least one hypothesis with a conclusive outcome? (SUPPORTED or RETIRED)
- Are there viable hypotheses that warrant further testing? (ACTIVE or REVISED)

**Axis 2: Credibility closure**
- Are there open coordinator obligations? (required reviews, reproductions, evidence gaps)
- Has a grounded summary been compiled?
- Have memory promotion candidates been adjudicated or explicitly deferred?

### DECISION transition table (revised)

| Transition | Condition | Auto? |
|-----------|-----------|-------|
| DECISION → COMPLETE | All hypotheses adjudicated AND no open coordinator obligations AND grounded summary compiled AND at least 1 conclusive hypothesis | Yes |
| DECISION → DESIGN | At least 1 viable hypothesis AND (coordinator-required experiments exist OR explicit decision to iterate) | Yes when coordinator-required experiments exist; explicit otherwise |
| DECISION → HYPOTHESIS | Analysis invalidated current hypothesis set OR explicit decision to pivot | Never auto |

### Guard context for DECISION

```typescript
interface DecisionGuardContext {
  // Research progression
  activeOrEvaluatingHypothesisCount: number;
  conclusiveHypothesisCount: number;        // SUPPORTED or RETIRED
  viableHypothesisCount: number;            // ACTIVE or REVISED
  satisfiedIntentCount: number;
  exhaustedIntentCount: number;

  // Credibility closure
  openCoordinatorObligations: number;       // required reviews, reproductions, evidence gaps
  unresolvedCredibilityQueueItems: number;
  groundedSummaryCompiled: boolean;
  memoryPromotionsPending: number;          // candidates not yet adjudicated or deferred
}
```

### What this prevents

Without credibility closure in the DECISION guard, a project could reach COMPLETE with:
- 5 unresolved coordinator queue items (reviews never done)
- No grounded summary (findings not compiled)
- Memory candidates sitting unadjudicated (insights not promoted or deferred)

The guard ensures that "complete" means complete — not just "the agent decided to stop."

## 9. Approach Ownership

### Problem

`ApproachBranch` currently floats alongside hypotheses without explicit binding. The agent registers 17 approaches because nothing ties them to hypotheses, and no one can answer "which approaches serve which hypotheses." ExperimentIntent references both `hypothesisId` and `approachId`, but the relationship between hypothesis and approach is implicit.

### Design

Many-to-many with a join model. One approach can support multiple hypotheses. One hypothesis can be tested through multiple approaches. The binding carries role and rationale.

```prisma
model HypothesisApproachLink {
  id            String   @id @default(cuid())
  hypothesisId  String
  approachId    String
  role          String   // "primary" | "control" | "ablation" | "comparison"
  rationale     String?  // why this approach is relevant to this hypothesis
  createdAt     DateTime @default(now())

  hypothesis    ResearchHypothesis @relation(fields: [hypothesisId], references: [id], onDelete: Cascade)
  approach      ApproachBranch     @relation(fields: [approachId], references: [id], onDelete: Cascade)

  @@unique([hypothesisId, approachId])
  @@index([hypothesisId])
  @@index([approachId])
}
```

### Roles

| Role | Meaning |
|------|---------|
| `primary` | This approach directly tests the hypothesis |
| `control` | This approach serves as the control/baseline for comparison |
| `ablation` | This approach removes a component to test its necessity |
| `comparison` | This approach exists to compare against, not to test the hypothesis directly |

### Integration with ExperimentIntent

ExperimentIntent already has `hypothesisId` and `approachId`. With HypothesisApproachLink, the system can validate at intent creation time that the approach is actually linked to the hypothesis — not a random pairing the agent invented.

### Constraints on approach registration

With explicit ownership, the system can enforce:
- In HYPOTHESIS state, `register_approach` should require linking to at least one hypothesis
- An approach with zero hypothesis links is an orphan — soft invariant (audit class)
- The agent cannot reference an approach in `create_intent` unless it's linked to the intent's hypothesis

### What this does NOT change

- ApproachBranch keeps its existing parent/child tree structure (sub-approaches)
- ApproachBranch.status uses the frozen approach lifecycle vocabulary: PROPOSED, COMMITTED, ACTIVE, COMPLETED, ABANDONED (see Section 3)
- The approach tree visualization remains the same — it just gains hypothesis annotations

---

## Summary

This spec adds or revises nine architectural components:

| # | Component | Key decision |
|---|-----------|-------------|
| 1 | **ExperimentIntent** | Design artifact binding hypothesis→approach→script→protocol. Sole input to EXECUTION. |
| 2 | **Run/Attempt/Job hierarchy** | ExperimentRun owns lifecycle. ExperimentAttempt owns retry history. RemoteJob is transport. State flows upward. |
| 3 | **Vocabulary freeze** | Five domain-scoped enum sets. No shared lifecycle terms across domains. Legacy migration table. |
| 4 | **Causality model** | TransitionRecord with full guard context snapshot, entity version hash, and causal chain fields. |
| 5 | **Invariant engine** | HARD/SOFT/AUDIT classes. Soft invariants have TTL-based escalation. Runs on relevant writes. |
| 6 | **"Why" layer** | Three APIs: `explainTransition` (retrospective), `explainBlocker` (prospective), `getStateReport` (current summary). |
| 7 | **Replay readiness** | Store transition snapshots, causality links, invariant violations now. Build replay tools later. |
| 8 | **Coordinator in DECISION** | COMPLETE requires both research progression AND credibility closure. |
| 9 | **Approach ownership** | Many-to-many HypothesisApproachLink with role and rationale. |

### Implementation order

1. Vocabulary freeze (prerequisite — must be done first)
2. Schema additions (ExperimentIntent, ExperimentAttempt, HypothesisApproachLink, InvariantViolation, TransitionRecord v2)
3. ExperimentIntent lifecycle + `create_intent` / `run_experiment({ intent_id })` tool API
4. ExperimentRun as authority + reconciler
5. Invariant engine
6. "Why" layer APIs
7. DECISION guard revision (coordinator integration)
8. Approach ownership enforcement
9. Replay data verification (confirm all snapshots are being stored correctly)

---

## Clarifications (from review findings)

**Q: Does DONE mean "remote exit code was 0" or "result imported and linked"?**
A: DONE means "result imported and linked." A run with exit code 0 but failed import is not DONE — it is FAILED with `failureClass=IMPORT`. The invariant `run.done_requires_result` enforces this. The EXECUTION→ANALYSIS guard requires SATISFIED intents, which in turn require DONE runs with results. There is no path to ANALYSIS without actual evidence.

**Q: Can one intent span multiple runs? What is a Run vs. an Attempt?**
A: Yes, one intent can have many runs. The boundary is:

- **New ExperimentRun** = new seed, new condition, new baseline comparison, or any semantically distinct execution. Each run has its own FSM lifecycle and produces its own result.
- **New ExperimentAttempt** = retry of the same run (same seed, same condition) due to infrastructure failure, host failover, or auto-fix resubmit. Attempts are append-only facts on the same run. The run's FSM state reflects the aggregate outcome of its attempts.

Examples:
- Intent with `{ type: "all_seeds_complete", seeds: [42, 123, 456] }` → 3 runs (one per seed)
- Run for seed 42 fails with OOM on host A, retried on host B → 2 attempts on the same run
- Run for seed 42 fails with a code error, auto-fix rewrites and resubmits → 2 attempts on the same run (attempt 2 has `isAutoFixResubmit = true`)
- Agent wants to compare GRPO vs DPO → 2 separate intents, each with their own runs

**Q: What happens when a run completes but result import fails?**
A: The run is marked FAILED with `failureClass=IMPORT`. No placeholder result is created. The intent evaluates its criterion against remaining runs. If all runs are terminal and the criterion is not met, the intent becomes EXHAUSTED. The project stays in EXECUTION (EXHAUSTED intents do not trigger EXECUTION→ANALYSIS). The agent must create a revised intent or fix the import issue.

**Q: What prevents the script from changing between DESIGN and EXECUTION?**
A: `ExperimentIntent.scriptHash` and `ExperimentIntent.protocolHash` are both computed at DRAFT→READY validation time. Both are non-null (hypothesis, approach, and protocol are all required on every intent). At `run_experiment({ intent_id })` time, the system re-hashes both the script and the protocol and compares. If either hash differs, the run is blocked: "Script or protocol has changed since intent was validated. Update the intent or create a new one." This ensures DESIGN approved the same artifacts that EXECUTION runs.

Note: SMOKE and CALIBRATION runs that don't test a hypothesis do not use ExperimentIntent, but they DO use the same ExperimentRun/ExperimentAttempt/RemoteJob model. `run_infrastructure({ script, args, purpose })` creates an ExperimentRun with `kind = "infrastructure"`, `intentId = null`, and `purpose = "SMOKE" | "CALIBRATION"`. The run goes through the same FSM lifecycle (DRAFT→READY→QUEUED→RUNNING→IMPORTING→DONE) and shares the same lease/workspace/reconciler machinery.

Key rules for infrastructure runs:
- **Legal in any project state** — DISCOVERY, HYPOTHESIS, DESIGN, EXECUTION, ANALYSIS, DECISION. Infrastructure is not gated by project lifecycle. The tool `run_infrastructure` is cross-cutting.
- **Do not count toward research guards** — the EXECUTION→ANALYSIS guard filters on `kind = "research"`, not on `intentId != null`. Guards are evaluated from persisted facts, not inferred from tool paths.
- **Appear in the same audit trail** — TransitionRecords, InvariantViolations, and getStateReport include infrastructure runs.

**Q: How is the "currently active evaluation protocol" selected when create_intent auto-binds protocolId?**
A: The project has at most one active protocol at a time. `getEvaluationProtocol(projectId)` returns the most recent protocol entry by `createdAt`. If the agent calls `define_evaluation_protocol` again, it creates a new entry which becomes the active one. Existing intents keep their original `protocolId` and `protocolHash` — they were validated against the protocol at their creation time. Only new intents bind to the new protocol. There is no explicit "protocol version" model; the protocol entries are ordered by creation time and the latest is active.
