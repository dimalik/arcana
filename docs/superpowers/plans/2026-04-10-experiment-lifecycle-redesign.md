# Experiment Lifecycle Reliability Implementation Plan

> **For agentic workers:** Use a strict task-by-task workflow. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace patchy background experiment handling with a durable, state-machine-driven run lifecycle that survives restarts, supports explicit concurrency, and keeps every retry/fix auditable.

**Architecture:** Introduce `ExperimentRun` + `ExperimentAttempt` + `ExperimentEvent` + `ExecutorLease`, add helper protocol v10 with run-scoped status/logs, and cut over from process-local polling (`runAndPoll`) to a lease-based coordinator.

**Tech Stack:** Prisma + SQLite, TypeScript (agent/executor), Python helper, Next.js API routes.

## Implementation Status (2026-04-10)

- Completed: schema foundation (`ExperimentRun`, `ExperimentAttempt`, `ExperimentEvent`, `ExecutorLease`) with Prisma push + client generation.
- Completed: transition/event helper module (`run-lifecycle.ts`) and dual-write projection from run lifecycle to `RemoteJob`.
- Completed: workspace lock guard in submission path; blocked project submissions now transition lifecycle state to `BLOCKED` for auditability.
- Completed: executable lifecycle checker `scripts/check-experiment-integrity.js` + npm command `check:experiment-integrity`.
- Pending: helper protocol v10 cutover, durable coordinator, run-centric tool/API migration, and end-to-end integration tests.

---

### Task 1: Schema Foundation (Run/Attempt/Event/Lease)

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] Add `ExperimentRun` model with explicit lifecycle state and policy metadata.
- [ ] Add `ExperimentAttempt` model linked to `ExperimentRun` and `RemoteHost`.
- [ ] Add `ExperimentEvent` append-only model (event type, payload JSON, timestamps).
- [ ] Add `ExecutorLease` model for coordinator ownership/fencing.
- [ ] Add indexes for `state`, `projectId`, `hostId`, `createdAt`, `leaseExpiresAt`.
- [ ] Keep `RemoteJob` intact for now (compatibility projection).
- [ ] Run:
```bash
npx prisma db push && npx prisma generate
```

---

### Task 2: Transition Helpers and Event Append API

**Files:**
- Add: `src/lib/research/run-lifecycle.ts`
- Modify: `src/lib/research/remote-executor.ts`

- [ ] Implement `transitionRunState(runId, from, to, reason)` with transition guards.
- [ ] Implement `appendRunEvent(runId, type, payload)` utility.
- [ ] Implement idempotency key support for start/cancel operations.
- [ ] Add compatibility projection writer to mirror latest run state into `RemoteJob`.
- [ ] Add unit tests for legal/illegal transitions.

---

### Task 3: Helper Protocol v10 (Run-Scoped)

**Files:**
- Modify: `scripts/arcana_helper.py`

- [ ] Bump `HELPER_VERSION` to `"10"`.
- [ ] Add required args to `run/status/logs/kill`: `--run-id` and `--attempt`.
- [ ] Store status/log/exit code under `runs/<run_id>/attempt_<n>/`.
- [ ] Remove implicit auto-kill of “current workspace run” in `cmd_run`.
- [ ] Preserve v9 command compatibility branch for migration window.
- [ ] Add parser-level validation for required run identifiers in v10 path.
- [ ] Verify with:
```bash
python3 -m py_compile scripts/arcana_helper.py
```

---

### Task 4: Coordinator Worker (Durable Poller Replacement)

**Files:**
- Add: `src/lib/research/run-coordinator.ts`
- Modify: `src/lib/research/remote-executor.ts`

- [ ] Implement lease acquisition/renewal/expiry logic using `ExecutorLease`.
- [ ] Implement deterministic handlers: `handleQueued`, `handleStarting`, `handleRunning`, `handleTerminal`.
- [ ] Persist all checkpoints via `ExperimentEvent`.
- [ ] Add startup reconciliation pass to recover abandoned runs.
- [ ] Feature-flag cutover from `runAndPoll` to coordinator (`RUN_COORDINATOR_V1=1`).

---

### Task 5: Agent Tool Contract Migration

**Files:**
- Modify: `src/lib/research/agent.ts`

- [ ] Change `run_experiment` return payload and text to use `run_id` semantics.
- [ ] Add `check_run` and `wait_for_runs` tools (keep `check_job`/`wait_for_jobs` aliases temporarily).
- [ ] Ensure run status queries read from `ExperimentRun` + latest attempt.
- [ ] Update sweep tool to submit multiple `ExperimentRun` records (no hidden same-workspace cancellation risk).
- [ ] Keep user-facing behavior backward compatible in this phase.

---

### Task 6: Retry/Fix Policy Engine

**Files:**
- Modify: `src/lib/research/auto-fix.ts`
- Add: `src/lib/research/run-policy.ts`

- [ ] Move retry/fix decisions to policy engine with explicit limits.
- [ ] Represent each retry as a new `ExperimentAttempt`.
- [ ] Record classification + fix proposal/application as `ExperimentEvent`s.
- [ ] Keep deterministic heuristics first; use LLM only for unresolved cases.
- [ ] Ensure no mutation of prior attempt records.

---

### Task 7: API + UI Compatibility Layer

**Files:**
- Modify: `src/app/api/research/[id]/...` routes that read `RemoteJob`
- Modify: relevant dashboard/job-list components

- [ ] Serve run-centric payloads while keeping legacy fields for older UI consumers.
- [ ] Display attempts per run in job details.
- [ ] Surface blocked state with explicit action needed.
- [ ] Validate that historical `RemoteJob`-only projects still render.

---

### Task 8: Verification and Decommission Gates

**Files:**
- Add: `docs/superpowers/plans/2026-04-10-experiment-lifecycle-redesign-qa.md` (optional QA matrix)

- [ ] Add integration test: concurrent runs on same host, no cross-run status bleed.
- [ ] Add restart-recovery test: kill app mid-run, restart, converge to correct terminal state.
- [ ] Add duplicate coordinator test: verify lease fencing prevents double-start.
- [ ] Add migration test: helper v9 host still executes through compatibility path.
- [ ] After passing all checks, remove legacy `runAndPoll` path and mark `RemoteJob` deprecated.

---

## Rollout Notes

- Roll out behind feature flags and enable per project or per host first.
- Keep dual-write/dual-read until at least one full research cycle completes without manual intervention.
- Only remove legacy status paths after coordinator stability is validated in real workloads.
