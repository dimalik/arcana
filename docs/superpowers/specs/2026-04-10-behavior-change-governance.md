# Behavior Change Governance (Agent + Execution)

## Why this exists

Arcana already has active agents, historical projects, and established execution patterns.  
Behavior changes must improve correctness, not novelty. This document defines the minimum bar for changing agent or experiment behavior.

## Hard rules

1. No silent behavior changes.
2. Every behavior change must have a written contract before merge.
3. Every behavior change must define objective invariants and pass executable checks.
4. Compatibility path must be explicit (default preserve, feature flag, or migration).
5. Rollback path must be documented before rollout.

## Required artifacts per behavior change

1. **Spec entry** in `docs/superpowers/specs/` containing:
   - Problem statement
   - Prior behavior and new behavior (side-by-side)
   - Compatibility mode and default
   - Risk analysis
   - Rollback strategy
2. **Execution plan** in `docs/superpowers/plans/` with checkable tasks.
3. **Validation evidence**:
   - Type check and lint results
   - Run lifecycle integrity report (`npm run check:experiment-integrity`)
   - For experiment execution changes: one real project replay or targeted reproduction trace
4. **User-facing docs updates** where behavior is visible (`docs/research-agent.md`, `docs/remote-execution.md`, API references).

## Experiment lifecycle invariants (minimum)

1. `ExperimentRun.attemptCount` equals actual `ExperimentAttempt` count.
2. Terminal runs (`SUCCEEDED|FAILED|CANCELLED|BLOCKED`) have `completedAt`.
3. Non-terminal runs (`QUEUED|STARTING|RUNNING`) do not have `completedAt`.
4. Linked terminal `RemoteJob.status` matches terminal run projection.
5. No more than one active job in the same `host + workspace`.
6. Event log contains only legal state transitions.

These are enforced by `scripts/check-experiment-integrity.js`.

## Rollout policy

1. Additive schema changes first.
2. Dual-write/dual-read while migration is in progress.
3. Enable new behavior behind flags or constrained scope first (project/host subset).
4. Remove legacy paths only after invariant checks stay green on real usage windows.

## Review gate

No PR that changes agent execution behavior should be considered done unless:

1. Required artifacts are present.
2. Integrity checker passes on current DB state.
3. Docs are updated in the same change set.
