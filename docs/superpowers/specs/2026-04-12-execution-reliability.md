# Execution Reliability

**Date:** 2026-04-12
**Status:** Draft

## Problem

A project with 8xA100 and all required packages pre-installed took 90 minutes to run one trivial experiment (package check). Root causes:

1. **The agent creates `requirements.txt` that duplicates pre-installed packages.** The helper then builds a `.venv` from scratch, attempting to compile `flash_attn` from source — which fails and corrupts the environment. Every subsequent experiment attempt uses the broken `.venv` instead of the host's pre-configured `/opt/venv`.

2. **The agent retries the same failing operation indefinitely.** 21 `validate_environment` calls, 14 `run_experiment` retries of the same script against the same broken venv. No circuit breaker, no escalation, no alternative strategy.

3. **A trivial smoke test counts as a real experiment.** `poc_000_check_pkgs.py` (prints Python version) triggered EXECUTION→ANALYSIS, ending the experiment phase before any real experiment ran.

4. **The DESIGN state leaked 11 minutes of off-task work.** The validator flagged `web_search` and `write_file` as red-flag tools 15 times, but the tools still executed and returned results. Validation without enforcement is decoration.

## Design

### Principle

The host environment is the source of truth for what's installed. The agent does not manage environments — it writes scripts that use what's available. The system prevents, not warns.

### 1. Eliminate agent-managed venvs when a host environment exists

**Current flow:**
```
Agent writes requirements.txt
→ Helper merges with base_requirements.txt
→ Creates .venv, pip installs everything
→ flash_attn build fails → broken .venv
→ All subsequent runs use broken .venv
```

**New flow:**
```
Host has conda/venv configured (ARCANA_CONDA is set)
→ Use it directly. No .venv creation. No pip install.
→ If the agent writes requirements.txt, IGNORE it — the host env is authoritative.
→ If a script imports something not in the host env, it fails at import time
   with a clear error, not a 30-minute build failure.
```

#### Changes to `arcana_helper.py`:

**`setup_venv`**: When `ARCANA_CONDA` is set, return immediately with "Using pre-configured environment." Do not create `.venv`, do not merge requirements, do not run pip. The host environment is complete.

**`get_venv_python`**: When `ARCANA_CONDA` is set, return the conda python path directly. Do not check for `.venv` first. The priority order must be: configured env > workspace .venv > system python.

**`ensure_runtime_env`**: Already correct (short-circuits on `ARCANA_CONDA`). No change needed.

**New: `validate_host_packages`**: Before first experiment, probe the host env for the packages the script actually imports. Parse `import` statements from the script, check against `pip list` output from the host. Report missing packages as a clear error: "Script imports X but host env doesn't have it. Install it on the host or remove the import." This replaces the requirements.txt → pip install flow.

#### Changes to `remote-executor.ts`:

**`base_requirements.txt` sync**: Do not sync `base_requirements.txt` to the workspace when the host has a configured environment. This file triggers the merge logic in the helper.

**requirements.txt handling**: When a host has `conda` configured, strip `requirements.txt` from the workspace sync or rename it to `requirements.txt.agent` so the helper ignores it. The agent can still write it for documentation, but the helper won't act on it.

### 2. Circuit breaker for repeated failures

**Current behavior:** The agent can call `validate_environment` and `run_experiment` unlimited times with the same failing arguments. No escalation, no backoff, no cap.

**New behavior:** Track consecutive failures per (projectId, scriptName/tool) pair. After N consecutive identical failures:

| Threshold | Action |
|-----------|--------|
| 2 same script failures | Inject message: "This script has failed twice. Read the error, fix the script, then retry." |
| 3 same tool calls | Block the tool for this script: "Blocked — fix the code before retrying." |
| 5 total failures in EXECUTION | Force pause: "Too many failures. Stopping to prevent resource waste. Review errors and replan." |

This is tracked in the `state-validator.ts` as part of the behavioral validation, not as a per-tool hack.

#### Implementation:

Add to `state-validator.ts`:

```typescript
interface FailureTracker {
  consecutiveFailures: Map<string, number>;  // key: "tool:scriptName"
  totalFailures: number;
}

function checkCircuitBreaker(
  tracker: FailureTracker,
  toolName: string,
  scriptName: string | null,
  succeeded: boolean,
): { blocked: boolean; message: string | null }
```

The tracker lives in the agent session (not DB) — it resets on new sessions. The Run FSM's `failureClass` provides the structured failure data.

### 3. Experiment quality gate for state transitions

**Current behavior:** Any COMPLETED RemoteJob triggers EXECUTION→ANALYSIS, including a script that just prints "Python 3.12.3".

**New behavior:** The EXECUTION→ANALYSIS guard requires a COMPLETED job that is a **real experiment** — not a smoke test or package check.

#### Definition of "real experiment":

A RemoteJob counts toward the EXECUTION→ANALYSIS transition guard when ALL of:
- `status = "COMPLETED"`
- `experimentPurpose` is NOT `"SMOKE"` (PoC/smoke tests don't count)
- OR `experimentPurpose = "SMOKE"` AND there is also at least one non-SMOKE job submitted (the PoC was a stepping stone, not the destination)

#### Changes to `project-fsm.ts`:

Update `ExecutionToAnalysisContext`:
```typescript
interface ExecutionToAnalysisContext {
  doneRunCount: number;           // current
  doneNonSmokeRunCount: number;   // NEW: COMPLETED jobs where purpose != SMOKE
}
```

Guard check:
```typescript
checks["real_experiment_done"] = {
  passed: ctx.doneNonSmokeRunCount > 0,
  detail: ctx.doneNonSmokeRunCount > 0
    ? `${ctx.doneNonSmokeRunCount} real experiments completed`
    : `Only smoke tests completed (${ctx.doneRunCount} total) — run a real experiment`,
};
```

#### Changes to `transition-engine.ts`:

Update `fetchGuardContext` for EXECUTION→ANALYSIS to query:
```typescript
const doneNonSmokeRunCount = await prisma.remoteJob.count({
  where: {
    projectId,
    status: "COMPLETED",
    experimentPurpose: { not: "SMOKE" },
  },
});
```

### 4. Validator enforcement: block, don't warn

**Current behavior:** Red-flag tools log a warning and inject a system message, but the tool still executes and returns results. The agent ignores the warning.

**New behavior:** Red-flag tools are not in the tool set at all — they physically cannot be called. The validator becomes a post-hoc auditor, not a real-time warner, because the tool-set filtering is the enforcement layer.

This is already mostly true (DESIGN doesn't have `write_file`), but `web_search` was still callable because it was cross-cutting. The fix from the tool-sets change (removing `web_search` from cross-cutting, adding it only to DISCOVERY/HYPOTHESIS/EXECUTION) handles this.

The validator's role changes to:
1. **Post-hoc audit** — log what the agent did for debugging (already implemented)
2. **Stagnation detection** — flag when the agent exceeds maxSteps in a state (already implemented)
3. **Circuit breaker** — track repeated failures and block (new, from section 2)

Remove the `redFlagTools` concept from the validator. If a tool isn't in the tool set, it can't be called. The validator doesn't need to duplicate this check.

### 5. System prompt: tell the agent what's installed

The agent shouldn't guess what packages are available. The system prompt should include the host's package list (already available in `RemoteHost.envNotes`).

In EXECUTION state, append to the state directive:
```
The remote host has these packages pre-installed: torch, transformers, peft, datasets, flash_attn, accelerate, ...
Do NOT write a requirements.txt. Do NOT try to install packages. Write scripts that import what's already available.
```

This is extracted from the `envNotes` field that's already populated by `diagnose_remote_host`.

## Migration

- Delete any `.venv` directories on remote hosts for active projects (they may be corrupted)
- No schema changes needed
- No DB migration needed

## Files Changed

| File | Change |
|------|--------|
| `scripts/arcana_helper.py` | `setup_venv`: skip when ARCANA_CONDA set. `get_venv_python`: prefer conda python. New `validate_host_packages`. |
| `src/lib/research/remote-executor.ts` | Skip base_requirements.txt sync when host has conda. Handle requirements.txt stripping. |
| `src/lib/research/fsm/project-fsm.ts` | EXECUTION→ANALYSIS guard requires non-SMOKE completed job |
| `src/lib/research/fsm/transition-engine.ts` | Fetch `doneNonSmokeRunCount` in guard context |
| `src/lib/research/fsm/state-validator.ts` | Add circuit breaker, remove redFlagTools (tool-sets handle this) |
| `src/lib/research/agent.ts` | EXECUTION directive includes host packages, circuit breaker wired into onStepFinish |
