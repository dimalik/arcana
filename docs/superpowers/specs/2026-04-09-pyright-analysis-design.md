# Remote Pyright Analysis — Design Spec

## Problem

Experiment scripts frequently fail on remote GPU hosts due to wrong imports, outdated API signatures, type mismatches, and missing packages. These errors are currently caught only at runtime — wasting GPU time, SSH round-trips, and agent iterations. The existing preflight catches syntax errors and domain-specific antipatterns, but not semantic issues like "this function doesn't accept that argument."

## Solution: Pyright Analysis via Helper

Run pyright on the remote host against the actual venv before submitting experiments. Diagnostics feed back to the agent, which fixes the script and resubmits — all before any GPU time is spent.

---

## 1. Helper `check` Command

New command in `arcana_helper.py`:

```
helper check <workdir> <script.py>
```

### Flow

1. Resolve the workdir's Python environment (venv or conda, same logic as `cmd_run`)
2. Ensure pyright is installed — `pip install pyright` into the venv if missing. Cache installation status via a marker file (`.arcana/pyright_installed`)
3. Run: `pyright --outputjson --pythonpath <venv_python> <workdir>/<script.py>`
4. Parse pyright's JSON output
5. Filter to errors and warnings (discard information/hint severity)
6. Return structured JSON:

```json
{
  "ok": true,
  "errors": [
    {
      "line": 12,
      "col": 5,
      "endLine": 12,
      "endCol": 17,
      "severity": "error",
      "message": "Import \"transfomers\" could not be resolved",
      "rule": "reportMissingImports"
    }
  ],
  "errorCount": 1,
  "warningCount": 0,
  "pyrightVersion": "1.1.390"
}
```

### Installation

- Pyright is a pip package (`pyright`) that bundles the node-based tool — no system Node.js needed
- First `check` call installs it (~20MB, ~30s). Marker file `.arcana/pyright_installed` skips subsequent checks
- If installation fails (network, permissions), return `{ "ok": true, "errors": [], "errorCount": 0, "unavailable": true, "reason": "..." }`
- The helper never blocks on pyright unavailability

### Timeout

- 30 seconds for pyright execution
- If exceeded, return empty diagnostics with `"timeout": true`

### Configuration

- No `pyrightconfig.json` needed — pyright infers settings from the venv
- Set `--pythonpath` to the venv's python so pyright resolves packages correctly
- Set `--level basic` to avoid overly strict checks on research scripts (basic catches imports, argument types, missing attributes; strict adds return type annotations which research scripts rarely have)

---

## 2. Agent Integration

### Modified `run_experiment` / `execute_remote` flow

After existing preflight and syncUp, before job submission:

```
Agent calls run_experiment("exp_055.py")
  1. Existing preflight (syntax, substance, domain checks)
  2. syncUp to remote
  3. NEW: analyzeScript(host, remoteDir, "exp_055.py")
  4. If errors and analysisAttempts < 3:
       DON'T submit. Return diagnostics to agent:
       "Script has 2 errors detected by static analysis. Fix and resubmit:
         Line 12: Import "transfomers" could not be resolved (reportMissingImports)
         Line 45: Argument "lr_scheudler" is not accepted by TrainingArguments (reportGeneralTypeIssues)"
  5. Agent fixes via write_file, calls run_experiment again
  6. If 3+ attempts with errors OR pyright unavailable → proceed anyway (log warning)
  7. Job submitted
```

### `analysisAttempts` tracking

- Per-script-name counter within the agent session (in-memory, not DB-persisted)
- Resets when the script name changes or agent restarts
- Prevents infinite fix loops on pyright false positives (some ML libraries have incomplete type stubs)
- After 3 attempts: log warning "Proceeding despite N pyright errors — may be false positives from incomplete type stubs"

### Standalone `check_script` tool

```
Input:  { script: string }  // filename relative to workdir, e.g. "exp_055.py"
Output: Formatted diagnostics or "No issues found"
```

- Available in experiment phase (same phase restriction as run_experiment)
- Agent can call proactively after writing a script, before attempting submission
- Uses same `analyzeScript()` function as the run_experiment integration
- Useful for the agent to validate before entering the full submission flow

---

## 3. Executor Layer

### `analyzeScript()` function

New function in `remote-executor.ts`:

```typescript
async function analyzeScript(
  host: HostConfig,
  remoteDir: string,
  scriptName: string,
): Promise<ScriptDiagnostics | null>
```

- Calls `invokeHelper(host, \`check ${remoteDir} ${scriptName}\`)`
- Parses response into `ScriptDiagnostics` interface
- Returns `null` on any failure (timeout, pyright not installed, SSH error, parse error)
- Null means "couldn't analyze, proceed anyway"

### `ScriptDiagnostics` interface

```typescript
interface ScriptDiagnostic {
  line: number;
  col: number;
  severity: "error" | "warning";
  message: string;
  rule: string;
}

interface ScriptDiagnostics {
  errors: ScriptDiagnostic[];
  errorCount: number;
  warningCount: number;
  pyrightVersion?: string;
  unavailable?: boolean;
  timeout?: boolean;
}
```

### `formatDiagnostics()` function

Formats diagnostics into agent-readable text:

```
Static analysis found 2 errors in exp_055.py:

  Line 12:5 — Import "transfomers" could not be resolved [reportMissingImports]
  Line 45:10 — Argument "lr_scheudler" is not a parameter of "__init__" [reportGeneralTypeIssues]

Fix these issues in the script and resubmit. (Attempt 1/3 — after 3 failed attempts, the script will be submitted anyway.)
```

Includes the attempt counter so the agent knows how many tries remain.

---

## 4. Schema Changes

### RemoteHost — add field

```prisma
pyrightInstalled  Boolean  @default(false)  // Cached: is pyright available in this host's env?
```

Updated by the executor after the first successful `check` call. Allows the agent to skip the "installing pyright..." wait message on subsequent calls.

### RemoteJob — add field

```prisma
diagnostics  String?  // JSON: pyright diagnostics at submission time (for debugging/UI)
```

Stored when a job is submitted (even if no errors). Allows post-hoc analysis of what pyright caught vs. what failed at runtime.

---

## 5. Non-Blocking Guarantees

Pyright analysis must **never** prevent experiments from running:

| Scenario | Behavior |
|----------|----------|
| Pyright not installed, install fails | Proceed, log warning |
| Pyright times out (>30s) | Proceed, log warning |
| SSH error during check | Proceed, log warning |
| Pyright reports errors, 3 fix attempts exhausted | Proceed, log warning |
| Remote has no venv (first run, setup pending) | Skip check entirely |
| Benchmark projects | Skip check (bypass all gates) |

---

## 6. Migration / Backward Compatibility

- Helper version stays at 7 (the `check` command is additive)
- Old helpers without `check` command: `invokeHelper` returns an error → `analyzeScript` returns null → proceeds without analysis
- `pyrightInstalled` defaults to false — first check call on each host triggers install
- No changes to existing preflight — pyright analysis is additive, runs after preflight

---

## Verification Checklist

1. `npx prisma db push` + `npx tsc --noEmit` pass
2. Helper `check` command installs pyright on first call
3. Helper `check` returns structured diagnostics for a script with errors
4. Helper `check` returns empty diagnostics for a clean script
5. Helper `check` handles timeout gracefully (returns empty + timeout flag)
6. Helper `check` handles missing venv (returns unavailable)
7. `run_experiment` runs analysis before submission
8. Agent receives diagnostics, fixes script, resubmits successfully
9. After 3 failed analysis attempts, job proceeds anyway
10. Pyright installation failure doesn't block experiments
11. SSH error during check doesn't block experiments
12. `check_script` tool works standalone
13. Benchmark projects skip analysis
14. Diagnostics stored on RemoteJob record
15. `pyrightInstalled` cached on RemoteHost after first success
