# Experiment Lifecycle Reliability — Design Spec

## Problem

Experiment execution currently works, but it is not principled end-to-end. The lifecycle is split across:

- DB state (`RemoteJob.status`, `errorClass`, `fixAttempts`)
- helper file state (`.arcana/status.json`, `.arcana/exit_code`)
- in-memory process state (`runAndPoll` promise + `activeJobIds`)

This creates avoidable failure modes:

1. **Split-brain job state**: DB can say `RUNNING` while helper status points to a different run.
2. **Hidden single-run semantics**: helper `cmd_run` auto-kills existing process in the same workspace, while agent tools advertise background parallel execution.
3. **Non-durable orchestrator**: `runAndPoll` is process-local; restarts require best-effort stale cleanup.
4. **Attempt history loss**: retries/auto-fix behavior mutates job status instead of producing immutable attempts with explicit causality.
5. **Ambiguous ownership of truth**: status derivation mixes logs, exit code files, and ad-hoc fallbacks.

The result is patchy behavior under load, host instability, or multi-experiment workflows.

## Goals

1. Make experiment execution **deterministic and replayable**.
2. Establish a **single source of truth** for lifecycle state.
3. Support **true multi-run concurrency** per host/workspace with explicit limits.
4. Make retries and fixes **policy-driven** and auditable.
5. Recover automatically from process restarts and transient SSH issues without manual intervention.

## Non-Goals

1. Replacing SSH backend with Ray/K8s in this phase.
2. Perfect zero-failure infrastructure; the goal is bounded failure with deterministic recovery.
3. Full UI redesign; API and data model correctness comes first.

---

## 1. Core Design Principles

### 1.1 Single source of truth

`ExperimentRun` state in Prisma is authoritative. Helper files are execution telemetry only.

### 1.2 Immutable attempts

A run can have multiple attempts. Attempts are append-only records, never overwritten.

### 1.3 Explicit state machine

Only legal transitions are allowed by code; no implicit status mutation from log parsing.

### 1.4 Idempotent commands

Every start/cancel/poll action is idempotent with request IDs and fencing tokens.

### 1.5 Isolation by construction

Each attempt gets its own directory and status/log files. No shared `.arcana/status.json` for active runs.

### 1.6 Policy over hidden behavior

No implicit “kill previous run in workspace.” Concurrency, preemption, and retries are explicit policy decisions.

---

## 2. Proposed Data Model

Introduce dedicated run lifecycle models (new, additive):

### 2.1 `ExperimentRun`

- Logical run requested by agent/user.
- Linked to project, hypothesis, script snapshot hash, resource routing decision.
- State: `QUEUED | STARTING | RUNNING | SUCCEEDED | FAILED | CANCELLED | BLOCKED`.

### 2.2 `ExperimentAttempt`

- One concrete execution attempt of a run.
- Contains host binding, remote workspace path, remote PID/PGID, exit code, diagnostics snapshot.
- State: `STARTING | RUNNING | TERMINAL`.

### 2.3 `ExperimentEvent`

- Append-only event log with typed events:
  - `RUN_CREATED`, `ATTEMPT_STARTED`, `ATTEMPT_HEARTBEAT`, `ATTEMPT_EXITED`,
  - `SYNC_UP_OK`, `SYNC_DOWN_OK`, `CLASSIFIED`, `RETRY_SCHEDULED`,
  - `AUTO_FIX_PROPOSED`, `AUTO_FIX_APPLIED`, `RUN_FINALIZED`.
- Used for recovery and audit.

### 2.4 `ExecutorLease`

- Durable worker lease table for host/project scheduler ownership.
- Prevents duplicate coordinators processing the same run.

### 2.5 Legacy mapping

`RemoteJob` remains during migration but becomes a projection of `ExperimentRun` + latest `ExperimentAttempt`.

---

## 3. Lifecycle State Machine

```
QUEUED
  -> STARTING
  -> RUNNING
  -> SUCCEEDED
  -> FAILED
  -> CANCELLED
  -> BLOCKED
```

Allowed transitions:

1. `QUEUED -> STARTING` (coordinator lease acquired)
2. `STARTING -> RUNNING` (helper acknowledged pid + heartbeat)
3. `STARTING -> FAILED` (setup/sync failed)
4. `RUNNING -> SUCCEEDED` (exit 0 + sync-down complete)
5. `RUNNING -> FAILED` (non-zero exit, hard infra failure, timeout)
6. `RUNNING -> CANCELLED` (explicit user/system cancellation)
7. `FAILED -> QUEUED` (retry policy schedules new attempt)
8. `FAILED -> BLOCKED` (needs explicit user resolution)

No direct state writes outside a transition helper (`transitionRunState()`).

---

## 4. Helper Protocol v10

Replace workspace-global status semantics with run-scoped semantics.

### 4.1 Directory layout

```
<workdir>/
  runs/
    <run_id>/
      attempt_001/
        stdout.log
        stderr.log
        status.json
        exit_code
        metadata.json
```

### 4.2 Command changes

1. `run <workdir> --run-id <id> --attempt <n> -- <command>`
2. `status <workdir> --run-id <id> --attempt <n>`
3. `logs <workdir> --run-id <id> --attempt <n> [--stdout-lines N] [--stderr-lines N]`
4. `kill <workdir> --run-id <id> --attempt <n>`
5. `manifest <workdir> --run-id <id>` (optional run-scoped manifest)

### 4.3 Removed behavior

- No auto-kill of prior run in `cmd_run`.
- No shared `.arcana/exit_code` for all runs.
- No ambiguity between “last run” vs “requested run.”

---

## 5. Durable Coordinator

Replace process-local `runAndPoll()` with a DB-driven coordinator loop:

1. Claim leased runs in `QUEUED`/`STARTING`/`RUNNING`.
2. Execute deterministic phase handlers:
  - `handleStart`, `handleHeartbeat`, `handleTerminal`, `handleRetry`.
3. Persist every significant step as `ExperimentEvent`.
4. Release lease heartbeat every interval; recover abandoned leases.

Coordinator runs:

- On demand (submission trigger)
- Periodically (reconciliation tick)
- On app startup (recovery pass)

This removes dependence on in-memory promises for correctness.

---

## 6. Retry and Fix Policy

### 6.1 Deterministic classification pipeline

Classification order:

1. Infrastructure signals (SSH/connectivity/permissions) -> `RESOURCE_ERROR`
2. Exit semantics + trace heuristics (OOM, signal, traceback presence)
3. LLM classification only when deterministic rules are inconclusive

### 6.2 Fix behavior

- `CODE_ERROR`: generate a proposed patch artifact and link to run.
- Auto-apply only if project policy allows and patch passes guardrails.
- Every fix produces a new `ExperimentAttempt`; never mutates past attempts.

### 6.3 Guardrails

- Max attempts per run.
- Max auto-fixes per run.
- Mandatory reflection or explicit override when policy requires.

---

## 7. Scheduling and Concurrency

### 7.1 Host capacity

Each host exposes capacity (default 1). Scheduler enforces slots.

### 7.2 Fairness

Round-robin by project with per-project in-flight limit.

### 7.3 Preemption policy

No implicit preemption. If enabled, preemption emits explicit events and requires policy match.

---

## 8. API and Tool Contract Changes

`run_experiment` response becomes run-centric:

```json
{
  "run_id": "...",
  "attempt": 1,
  "state": "QUEUED",
  "host": "lab-a100",
  "message": "Run accepted by scheduler"
}
```

`check_job`/`wait_for_jobs` should migrate to `check_run`/`wait_for_runs` with stable run IDs and attempt summaries.

Backward compatibility:

- Accept legacy job IDs during migration and map internally to run IDs.

---

## 9. Migration Strategy

### Phase A — Additive foundation

1. Add new run/attempt/event/lease tables.
2. Keep writing `RemoteJob`; add dual-write from submission path.
3. Introduce transition helpers and event append utility.

### Phase B — Helper protocol dual-stack

1. Add v10 helper commands (run-scoped).
2. Keep v9 compatibility path.
3. Gate by helper version negotiation in `remote-executor.ts`.

### Phase C — Coordinator cutover

1. Introduce coordinator worker service in-process.
2. Route new submissions through run state machine.
3. Keep legacy poller as fallback behind feature flag.

### Phase D — Policy hardening

1. Move auto-fix decisions to run policy engine.
2. Replace mutable `fixAttempts` handling with attempt-counted retries.

### Phase E — Decommission legacy

1. Remove legacy `runAndPoll` and helper global-status assumptions.
2. Convert UI/API consumers to run-first APIs.
3. Mark `RemoteJob` deprecated and later remove.

---

## 10. Verification Checklist

1. Two runs on same host/workspace can execute concurrently when capacity > 1.
2. Restarting app mid-run does not lose lifecycle progress.
3. Duplicate coordinator instances do not double-start attempts (lease fencing works).
4. Cancellation targets only specified run attempt.
5. Status/log retrieval is exact per run attempt; no cross-run bleed.
6. Retry creates a new attempt record with full lineage.
7. Auto-fix patch proposal and application are auditable events.
8. Legacy helper hosts still run experiments via compatibility mode.
9. `run_experiment_sweep` no longer causes hidden cancellation collisions.
10. Crash-recovery reconciliation converges state without manual cleanup.

---

## 11. Immediate Code Targets

Primary files for the first implementation slice:

- `prisma/schema.prisma` (new lifecycle tables)
- `src/lib/research/remote-executor.ts` (protocol adapter + coordinator entry points)
- `scripts/arcana_helper.py` (v10 run-scoped commands, remove auto-kill default)
- `src/lib/research/agent.ts` (`run_experiment` + `check_job` migration to run semantics)

This redesign intentionally raises the bar: execution correctness first, convenience second.
