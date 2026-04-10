# Remote Pyright Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run pyright static analysis on the remote host before experiment submission, feeding diagnostics back to the agent for autonomous fix-and-retry.

**Architecture:** Helper gets a `check` command that lazily installs pyright into the remote venv and runs it in CLI mode. Executor exposes `analyzeScript()`. Agent tools `run_experiment`/`execute_remote` call it after syncUp, blocking on errors (up to 3 retries). Standalone `check_script` tool for proactive validation.

**Tech Stack:** Python (helper, pyright CLI), TypeScript (executor, agent), Prisma (schema)

---

### Task 1: Schema Migration

**Files:**
- Modify: `prisma/schema.prisma` (RemoteHost + RemoteJob models)

- [ ] **Step 1: Add `pyrightInstalled` to RemoteHost**

In `prisma/schema.prisma`, add after `maxArchives`:

```prisma
  pyrightInstalled  Boolean  @default(false)  // Cached: is pyright available in this host's env?
```

- [ ] **Step 2: Add `diagnostics` to RemoteJob**

In `prisma/schema.prisma`, add after `archivedAt`:

```prisma
  diagnostics   String?                     // JSON: pyright diagnostics at submission time
```

- [ ] **Step 3: Push schema and verify**

```bash
npx prisma db push && npx prisma generate
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | head -20
```
Expected: No new errors.

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma
git commit -m "Add pyright analysis fields — pyrightInstalled, diagnostics"
```

---

### Task 2: Helper `check` Command

**Files:**
- Modify: `scripts/arcana_helper.py`

- [ ] **Step 1: Add `cmd_check` function**

Add after `cmd_restore` and before `cmd_version` in `scripts/arcana_helper.py`:

```python
PYRIGHT_MARKER = "pyright_installed"
PYRIGHT_INSTALL_TIMEOUT = 120  # 2 min for initial install
PYRIGHT_RUN_TIMEOUT = 30       # 30s for analysis


def ensure_pyright(workdir):
    """Ensure pyright is installed in the workdir's venv. Returns (python_path, ok, reason)."""
    arcana_dir = os.path.join(workdir, ARCANA_DIR)
    marker_path = os.path.join(arcana_dir, PYRIGHT_MARKER)

    # Find the Python to use
    venv_py = get_venv_python(workdir)
    conda_env = os.environ.get("ARCANA_CONDA", "")

    # Determine pip path
    if conda_env:
        # For conda/pre-existing envs, use the env's pip directly
        if conda_env.endswith("/python") or conda_env.endswith("/python3"):
            pip_path = os.path.join(os.path.dirname(conda_env), "pip3")
            if not os.path.exists(pip_path):
                pip_path = os.path.join(os.path.dirname(conda_env), "pip")
            venv_py = conda_env
        else:
            # conda env name — try to find pip via which after activation
            pip_path = None  # Will use subprocess with activation
            venv_py = "python3"
    else:
        pip_path = os.path.join(workdir, ".venv", "bin", "pip3")
        if not os.path.exists(pip_path):
            pip_path = os.path.join(workdir, ".venv", "bin", "pip")

    # Check marker
    if os.path.exists(marker_path):
        return venv_py, True, "cached"

    # Check if pyright is already importable
    try:
        result = subprocess.run(
            [venv_py, "-c", "import pyright; print('ok')"],
            capture_output=True, text=True, timeout=10,
            cwd=workdir,
        )
        if result.returncode == 0 and "ok" in result.stdout:
            os.makedirs(arcana_dir, exist_ok=True)
            with open(marker_path, "w") as f:
                f.write("1")
            return venv_py, True, "already installed"
    except Exception:
        pass

    # Install pyright
    if pip_path and os.path.exists(pip_path):
        try:
            result = subprocess.run(
                [pip_path, "install", "pyright", "-q"],
                capture_output=True, text=True, timeout=PYRIGHT_INSTALL_TIMEOUT,
                cwd=workdir,
            )
            if result.returncode == 0:
                os.makedirs(arcana_dir, exist_ok=True)
                with open(marker_path, "w") as f:
                    f.write("1")
                return venv_py, True, "installed"
            return venv_py, False, f"pip install failed: {result.stderr[-200:]}"
        except subprocess.TimeoutExpired:
            return venv_py, False, "pip install timed out"
        except Exception as e:
            return venv_py, False, str(e)

    return venv_py, False, "no pip found"


def cmd_check(workdir, script_name):
    """Run pyright static analysis on a script in the workdir's environment."""
    workdir = os.path.abspath(workdir)
    if not os.path.isdir(workdir):
        json_err(f"Workdir does not exist: {workdir}")

    script_path = os.path.join(workdir, script_name)
    if not os.path.isfile(script_path):
        json_err(f"Script not found: {script_name}")

    # Ensure pyright is available
    venv_py, ok, reason = ensure_pyright(workdir)
    if not ok:
        json_out({
            "ok": True,
            "errors": [],
            "errorCount": 0,
            "warningCount": 0,
            "unavailable": True,
            "reason": reason,
        })
        return

    # Run pyright
    try:
        # Use the venv's pyright binary via python -m pyright
        result = subprocess.run(
            [venv_py, "-m", "pyright", "--outputjson", "--level", "basic",
             "--pythonpath", venv_py, script_path],
            capture_output=True, text=True, timeout=PYRIGHT_RUN_TIMEOUT,
            cwd=workdir,
        )

        # pyright returns non-zero when it finds errors — that's expected
        stdout = result.stdout.strip()
        if not stdout:
            json_out({
                "ok": True,
                "errors": [],
                "errorCount": 0,
                "warningCount": 0,
                "unavailable": True,
                "reason": f"pyright produced no output (exit {result.returncode}): {result.stderr[-200:]}",
            })
            return

        # Parse pyright JSON output
        try:
            data = json.loads(stdout)
        except json.JSONDecodeError:
            json_out({
                "ok": True,
                "errors": [],
                "errorCount": 0,
                "warningCount": 0,
                "unavailable": True,
                "reason": f"pyright output not JSON: {stdout[:200]}",
            })
            return

        # Extract diagnostics — pyright JSON has generalDiagnostics and potentially other sections
        diagnostics = data.get("generalDiagnostics", [])
        errors = []
        error_count = 0
        warning_count = 0

        for diag in diagnostics:
            severity = diag.get("severity", "information")
            if severity not in ("error", "warning"):
                continue  # Skip information/hint

            rng = diag.get("range", {})
            start = rng.get("start", {})
            end = rng.get("end", {})

            entry = {
                "line": start.get("line", 0) + 1,  # pyright is 0-indexed
                "col": start.get("character", 0) + 1,
                "endLine": end.get("line", 0) + 1,
                "endCol": end.get("character", 0) + 1,
                "severity": severity,
                "message": diag.get("message", ""),
                "rule": diag.get("rule", ""),
            }
            errors.append(entry)

            if severity == "error":
                error_count += 1
            else:
                warning_count += 1

        version = data.get("version", "")

        json_out({
            "ok": True,
            "errors": errors,
            "errorCount": error_count,
            "warningCount": warning_count,
            "pyrightVersion": version,
        })

    except subprocess.TimeoutExpired:
        json_out({
            "ok": True,
            "errors": [],
            "errorCount": 0,
            "warningCount": 0,
            "timeout": True,
        })
    except Exception as e:
        json_out({
            "ok": True,
            "errors": [],
            "errorCount": 0,
            "warningCount": 0,
            "unavailable": True,
            "reason": str(e),
        })
```

- [ ] **Step 2: Wire `check` into `main()`**

Add this case in `main()` before the `_monitor` case:

```python
        elif cmd == "check":
            if len(sys.argv) < 4:
                json_err("Usage: check <workdir> <script.py>")
            cmd_check(sys.argv[2], sys.argv[3])
```

- [ ] **Step 3: Update docstring**

Add to the docstring Commands section:

```
  check <workdir> <script.py>     Run pyright static analysis on a script
```

- [ ] **Step 4: Verify helper syntax**

```bash
python3 -c "import py_compile; py_compile.compile('scripts/arcana_helper.py', doraise=True); print('OK')"
```
Expected: `OK`

- [ ] **Step 5: Commit**

```bash
git add scripts/arcana_helper.py
git commit -m "Helper: add check command — pyright static analysis on remote"
```

---

### Task 3: Executor — `analyzeScript()` and types

**Files:**
- Modify: `src/lib/research/remote-executor.ts`

- [ ] **Step 1: Add types**

Add after the `HelperStatus` interface (around line 110):

```typescript
/** Single diagnostic from pyright analysis. */
export interface ScriptDiagnostic {
  line: number;
  col: number;
  endLine?: number;
  endCol?: number;
  severity: "error" | "warning";
  message: string;
  rule: string;
}

/** Result of pyright analysis on a script. */
export interface ScriptDiagnostics {
  errors: ScriptDiagnostic[];
  errorCount: number;
  warningCount: number;
  pyrightVersion?: string;
  unavailable?: boolean;
  timeout?: boolean;
  reason?: string;
}
```

- [ ] **Step 2: Add `analyzeScript()` function**

Add after the `archiveRun` function (in the "Workspace lifecycle" section):

```typescript
/**
 * Run pyright static analysis on a script via the remote helper.
 * Returns structured diagnostics, or null on any failure (non-blocking).
 */
export async function analyzeScript(
  host: HostConfig,
  remoteDir: string,
  scriptName: string,
): Promise<ScriptDiagnostics | null> {
  try {
    const raw = await invokeHelper(host, `check ${remoteDir} ${scriptName}`);
    const result = parseHelperResponse<ScriptDiagnostics & { ok: boolean }>(raw);

    // If pyright was unavailable or timed out, return the result as-is
    // (errorCount will be 0, so callers won't block)
    return {
      errors: result.errors || [],
      errorCount: result.errorCount || 0,
      warningCount: result.warningCount || 0,
      pyrightVersion: result.pyrightVersion,
      unavailable: result.unavailable,
      timeout: result.timeout,
      reason: result.reason,
    };
  } catch (err) {
    // SSH error, helper not found, parse error — all non-blocking
    console.warn(`[remote-executor] analyzeScript failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * Format pyright diagnostics into agent-readable text.
 */
export function formatDiagnostics(
  scriptName: string,
  diagnostics: ScriptDiagnostics,
  attempt: number,
  maxAttempts: number,
): string {
  const lines: string[] = [];
  lines.push(`Static analysis found ${diagnostics.errorCount} error(s) in ${scriptName}:\n`);

  for (const d of diagnostics.errors) {
    if (d.severity === "error") {
      lines.push(`  Line ${d.line}:${d.col} — ${d.message}${d.rule ? ` [${d.rule}]` : ""}`);
    }
  }

  if (diagnostics.warningCount > 0) {
    lines.push(`\n${diagnostics.warningCount} warning(s):`);
    for (const d of diagnostics.errors) {
      if (d.severity === "warning") {
        lines.push(`  Line ${d.line}:${d.col} — ${d.message}${d.rule ? ` [${d.rule}]` : ""}`);
      }
    }
  }

  lines.push(`\nFix these issues in the script and resubmit. (Attempt ${attempt}/${maxAttempts} — after ${maxAttempts} failed attempts, the script will be submitted anyway.)`);

  return lines.join("\n");
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/research/remote-executor.ts
git commit -m "Executor: add analyzeScript() and formatDiagnostics() for pyright"
```

---

### Task 4: Agent — Integrate analysis into `run_experiment`

**Files:**
- Modify: `src/lib/research/agent.ts`

- [ ] **Step 1: Add import for `analyzeScript` and `formatDiagnostics`**

Find the existing import from `./remote-executor` (line ~18):

```typescript
import { submitRemoteJob, probeGpus, quickRemoteCommand } from "./remote-executor";
```

Add the new functions:

```typescript
import { submitRemoteJob, probeGpus, quickRemoteCommand, analyzeScript, formatDiagnostics } from "./remote-executor";
```

- [ ] **Step 2: Add analysis attempt tracker**

In the `createTools` function (around line 2030), near where other session-level tracking variables are defined (like `activeJobIds`, `expCounter`), add:

```typescript
  // Track pyright analysis attempts per script name (prevents infinite fix loops)
  const analysisAttempts = new Map<string, number>();
  const MAX_ANALYSIS_ATTEMPTS = 3;
```

Find where `activeJobIds` is defined to locate the right spot — it should be near other `const` declarations inside `createTools`.

- [ ] **Step 3: Insert analysis gate in `run_experiment` after preflight, before failure tracking**

In the `run_experiment` tool's execute function, find the block after pre-flight validation (around line 3449) and before the DB-backed failure tracking (around line 3451). Insert the pyright analysis between them:

```typescript
          // ── Pyright static analysis: catch semantic errors before GPU submission ──
          if (!isPoc && !isBenchmarkProject) {
            try {
              // syncUp must happen first so the script is on the remote
              // We do a lightweight sync here — the full syncUp happens in submitRemoteJob
              // Instead, we call analyzeScript which invokes the helper directly
              const scriptMatch2 = sanitized.match(/python3?\s+(\S+\.py)/);
              const scriptFileName = scriptMatch2 ? scriptMatch2[1] : null;

              if (scriptFileName) {
                const attempts = analysisAttempts.get(scriptFileName) || 0;

                if (attempts < MAX_ANALYSIS_ATTEMPTS) {
                  emit({ type: "tool_progress", toolName: "run_experiment", content: "Running static analysis..." });

                  // We need the remote dir — do a quick syncUp first
                  const { sshExecutor, hostToConfig: toConfig } = await import("./remote-executor");
                  const hostConfig = toConfig(host as Parameters<typeof toConfig>[0]);
                  let remoteDir: string;
                  try {
                    remoteDir = await sshExecutor.syncUp(workDir, hostConfig);
                  } catch {
                    // syncUp failed — skip analysis, submitRemoteJob will handle the error
                    remoteDir = "";
                  }

                  if (remoteDir) {
                    const diagnostics = await analyzeScript(hostConfig, remoteDir, scriptFileName);

                    if (diagnostics && diagnostics.errorCount > 0) {
                      analysisAttempts.set(scriptFileName, attempts + 1);

                      // Store diagnostics for debugging
                      emit({ type: "tool_output", toolName: "run_experiment", content: `\n⛔ STATIC ANALYSIS: ${diagnostics.errorCount} error(s) found` });

                      return `BLOCKED — ${formatDiagnostics(scriptFileName, diagnostics, attempts + 1, MAX_ANALYSIS_ATTEMPTS)}\n\nThe experiment was NOT submitted. Fix the script with write_file and call run_experiment again.`;
                    }

                    if (diagnostics && diagnostics.warningCount > 0) {
                      const warnLines = diagnostics.errors
                        .filter(d => d.severity === "warning")
                        .map(d => `  Line ${d.line}: ${d.message}`)
                        .join("\n");
                      emit({ type: "tool_output", toolName: "run_experiment", content: `\n⚠ Static analysis warnings:\n${warnLines}` });
                    }

                    if (diagnostics?.unavailable) {
                      console.log(`[agent] pyright unavailable on ${host.alias}: ${diagnostics.reason}`);
                    }
                    if (diagnostics?.timeout) {
                      console.warn(`[agent] pyright timed out on ${host.alias}`);
                    }
                  }
                } else {
                  emit({ type: "tool_output", toolName: "run_experiment", content: `⚠ Proceeding despite pyright errors — ${MAX_ANALYSIS_ATTEMPTS} fix attempts exhausted (may be false positives)` });
                }
              }
            } catch (analysisErr) {
              // Never block on analysis failure
              console.warn("[agent] pyright analysis error:", analysisErr);
            }
          }
```

**Important placement note:** This block goes AFTER the preflight validation block (line ~3449) and BEFORE the DB-backed failure tracking block (line ~3451 `const scriptContent = ...`). The reason: preflight catches syntax errors cheaply (local), then pyright catches semantic errors (remote). If preflight blocks, we never SSH to the remote for pyright.

- [ ] **Step 4: Export `sshExecutor` and `hostToConfig` from remote-executor.ts**

The analysis gate needs `sshExecutor.syncUp` and `hostToConfig` to prepare the remote dir before calling `analyzeScript`. In `remote-executor.ts`:

Add `export` to `hostToConfig` if not already exported:

```typescript
export function hostToConfig(...) {
```

Add `export` to `sshExecutor`:

```typescript
export const sshExecutor: ExecutorBackend = {
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/research/agent.ts src/lib/research/remote-executor.ts
git commit -m "Agent: integrate pyright analysis into run_experiment — block on errors, retry up to 3x"
```

---

### Task 5: Agent — Integrate analysis into `execute_remote`

**Files:**
- Modify: `src/lib/research/agent.ts`

- [ ] **Step 1: Insert the same analysis gate in `execute_remote`**

Find the `execute_remote` tool's execute function. Locate the block after pre-flight validation (around line 3693) and before the auto-environment check (around line 3695). Insert the same pyright analysis block, with `toolName` changed to `"execute_remote"`:

```typescript
          // ── Pyright static analysis ──
          if (!isPoc && !isBenchmarkProject) {
            try {
              const scriptMatch2 = sanitized.match(/python3?\s+(\S+\.py)/);
              const scriptFileName = scriptMatch2 ? scriptMatch2[1] : null;

              if (scriptFileName) {
                const attempts = analysisAttempts.get(scriptFileName) || 0;

                if (attempts < MAX_ANALYSIS_ATTEMPTS) {
                  emit({ type: "tool_progress", toolName: "execute_remote", content: "Running static analysis..." });

                  const { sshExecutor, hostToConfig: toConfig } = await import("./remote-executor");
                  const hostConfig = toConfig(host as Parameters<typeof toConfig>[0]);
                  let remoteDir: string;
                  try {
                    remoteDir = await sshExecutor.syncUp(workDir, hostConfig);
                  } catch {
                    remoteDir = "";
                  }

                  if (remoteDir) {
                    const diagnostics = await analyzeScript(hostConfig, remoteDir, scriptFileName);

                    if (diagnostics && diagnostics.errorCount > 0) {
                      analysisAttempts.set(scriptFileName, attempts + 1);
                      emit({ type: "tool_output", toolName: "execute_remote", content: `\n⛔ STATIC ANALYSIS: ${diagnostics.errorCount} error(s) found` });
                      return `BLOCKED — ${formatDiagnostics(scriptFileName, diagnostics, attempts + 1, MAX_ANALYSIS_ATTEMPTS)}\n\nThe experiment was NOT submitted. Fix the script with write_file and try again.`;
                    }

                    if (diagnostics && diagnostics.warningCount > 0) {
                      const warnLines = diagnostics.errors
                        .filter(d => d.severity === "warning")
                        .map(d => `  Line ${d.line}: ${d.message}`)
                        .join("\n");
                      emit({ type: "tool_output", toolName: "execute_remote", content: `\n⚠ Static analysis warnings:\n${warnLines}` });
                    }
                  }
                } else {
                  emit({ type: "tool_output", toolName: "execute_remote", content: `⚠ Proceeding despite pyright errors — ${MAX_ANALYSIS_ATTEMPTS} fix attempts exhausted` });
                }
              }
            } catch (analysisErr) {
              console.warn("[agent] pyright analysis error:", analysisErr);
            }
          }
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/research/agent.ts
git commit -m "Agent: integrate pyright analysis into execute_remote (deprecated path)"
```

---

### Task 6: Agent — Standalone `check_script` tool

**Files:**
- Modify: `src/lib/research/agent.ts`

- [ ] **Step 1: Add `check_script` tool**

Add after the `clean_workspace` tool definition (which is after `get_workspace`):

```typescript
    check_script: tool({
      description: "Run static analysis (pyright) on a Python script before submitting it. Checks for import errors, wrong API arguments, type mismatches, and missing attributes — against the actual packages installed on the remote host. Use after writing a script to catch bugs before burning GPU time.",
      inputSchema: z.object({
        script: z.string().describe("Script filename relative to workdir (e.g., 'exp_055.py')"),
      }),
      execute: async ({ script: scriptName }: { script: string }) => {
        if (!scriptName.endsWith(".py")) return "Only Python scripts can be analyzed.";

        const hostWhere = { isDefault: true as const };
        let host = await prisma.remoteHost.findFirst({ where: hostWhere });
        if (!host) host = await prisma.remoteHost.findFirst();
        if (!host) return "No remote hosts configured.";

        emit({ type: "tool_progress", toolName: "check_script", content: `Analyzing ${scriptName} on ${host.alias}...` });

        try {
          const { sshExecutor, hostToConfig: toConfig } = await import("./remote-executor");
          const hostConfig = toConfig(host as Parameters<typeof toConfig>[0]);

          // Sync files so the script is on the remote
          let remoteDir: string;
          try {
            remoteDir = await sshExecutor.syncUp(workDir, hostConfig);
          } catch (syncErr) {
            return `Could not sync files to ${host.alias}: ${syncErr instanceof Error ? syncErr.message : syncErr}`;
          }

          const diagnostics = await analyzeScript(hostConfig, remoteDir, scriptName);

          if (!diagnostics) {
            return `Could not run analysis — SSH or helper error. The script can still be submitted.`;
          }

          if (diagnostics.unavailable) {
            return `Pyright not available on ${host.alias}: ${diagnostics.reason}. The script can still be submitted — pyright will be installed on the next attempt.`;
          }

          if (diagnostics.timeout) {
            return `Pyright timed out analyzing ${scriptName}. The script can still be submitted.`;
          }

          if (diagnostics.errorCount === 0 && diagnostics.warningCount === 0) {
            return `No issues found in ${scriptName}. Ready to submit.${diagnostics.pyrightVersion ? ` (pyright ${diagnostics.pyrightVersion})` : ""}`;
          }

          const parts: string[] = [];
          if (diagnostics.errorCount > 0) {
            parts.push(`**${diagnostics.errorCount} error(s):**`);
            for (const d of diagnostics.errors.filter(d => d.severity === "error")) {
              parts.push(`  Line ${d.line}:${d.col} — ${d.message}${d.rule ? ` [${d.rule}]` : ""}`);
            }
          }
          if (diagnostics.warningCount > 0) {
            parts.push(`\n**${diagnostics.warningCount} warning(s):**`);
            for (const d of diagnostics.errors.filter(d => d.severity === "warning")) {
              parts.push(`  Line ${d.line}:${d.col} — ${d.message}${d.rule ? ` [${d.rule}]` : ""}`);
            }
          }

          return parts.join("\n");
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `Analysis failed: ${msg}. The script can still be submitted.`;
        }
      },
    }),
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/research/agent.ts
git commit -m "Agent: add check_script tool — standalone pyright analysis"
```

---

### Task 7: Update `pyrightInstalled` Cache on RemoteHost

**Files:**
- Modify: `src/lib/research/remote-executor.ts`

- [ ] **Step 1: Update `analyzeScript` to cache pyrightInstalled**

In `analyzeScript()`, after a successful check (diagnostics returned, not unavailable, not timeout), update the host's `pyrightInstalled` flag. Add after the return statement preparation:

```typescript
export async function analyzeScript(
  host: HostConfig,
  remoteDir: string,
  scriptName: string,
  hostId?: string,
): Promise<ScriptDiagnostics | null> {
  try {
    const raw = await invokeHelper(host, `check ${remoteDir} ${scriptName}`);
    const result = parseHelperResponse<ScriptDiagnostics & { ok: boolean }>(raw);

    // Cache pyrightInstalled on the host record if this is a successful analysis
    if (hostId && !result.unavailable && !result.timeout) {
      prisma.remoteHost.update({
        where: { id: hostId },
        data: { pyrightInstalled: true },
      }).catch(() => {}); // Best-effort, don't block
    }

    return {
      errors: result.errors || [],
      errorCount: result.errorCount || 0,
      warningCount: result.warningCount || 0,
      pyrightVersion: result.pyrightVersion,
      unavailable: result.unavailable,
      timeout: result.timeout,
      reason: result.reason,
    };
  } catch (err) {
    console.warn(`[remote-executor] analyzeScript failed:`, err instanceof Error ? err.message : err);
    return null;
  }
}
```

Note: This replaces the version from Task 3 — it adds the `hostId` optional parameter and the caching logic.

- [ ] **Step 2: Pass `hostId` from agent callers**

In `agent.ts`, update the `analyzeScript` calls in both `run_experiment` and `execute_remote` to pass `host.id`:

```typescript
const diagnostics = await analyzeScript(hostConfig, remoteDir, scriptFileName, host.id);
```

And in `check_script`:

```typescript
const diagnostics = await analyzeScript(hostConfig, remoteDir, scriptName, host.id);
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/research/remote-executor.ts src/lib/research/agent.ts
git commit -m "Cache pyrightInstalled on RemoteHost after successful analysis"
```

---

### Task 8: Store Diagnostics on RemoteJob

**Files:**
- Modify: `src/lib/research/remote-executor.ts` (submitRemoteJob)

- [ ] **Step 1: Accept diagnostics in submitRemoteJob params**

Update the `submitRemoteJob` params type to accept optional diagnostics:

```typescript
export async function submitRemoteJob(params: {
  hostId: string;
  localDir: string;
  command: string;
  stepId?: string;
  projectId?: string;
  scriptHash?: string;
  hypothesisId?: string;
  diagnostics?: string;
}): Promise<{ jobId: string }> {
```

In the job creation, add the diagnostics:

```typescript
  const job = await prisma.remoteJob.create({
    data: {
      hostId: host.id,
      stepId: params.stepId || null,
      projectId: params.projectId || null,
      localDir: params.localDir,
      remoteDir: "",
      command: params.command,
      scriptHash: params.scriptHash || null,
      hypothesisId: params.hypothesisId || null,
      runDir: runName,
      diagnostics: params.diagnostics || null,
      status: "SYNCING",
    },
  });
```

- [ ] **Step 2: Pass diagnostics from agent when submitting**

In `agent.ts`, in the `run_experiment` tool where `submitRemoteJob` is called (around line 3493), if pyright ran and returned results, serialize and pass them:

The cleanest approach is to store the last diagnostics result in a variable before the submission block. After the pyright analysis section, add:

```typescript
          let lastDiagnostics: string | undefined;
```

And in the analysis block, after a successful (non-blocking) analysis:

```typescript
                    // Store diagnostics for the job record
                    if (diagnostics) {
                      lastDiagnostics = JSON.stringify(diagnostics);
                    }
```

Then pass to `submitRemoteJob`:

```typescript
            const result = await submitRemoteJob({
              hostId: host.id,
              localDir: workDir,
              command: sanitized,
              projectId,
              scriptHash,
              hypothesisId: resolvedHypothesisId,
              diagnostics: lastDiagnostics,
            });
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/research/remote-executor.ts src/lib/research/agent.ts
git commit -m "Store pyright diagnostics on RemoteJob for debugging"
```

---

### Task 9: Integration Verification

**Files:** None (verification only)

- [ ] **Step 1: Full compile check**

```bash
npx prisma db push && npx tsc --noEmit 2>&1 | head -20
```
Expected: Schema applied, no new TS errors.

- [ ] **Step 2: Helper syntax and version check**

```bash
python3 scripts/arcana_helper.py version
```
Expected: `{"ok": true, "version": "7"}`

```bash
python3 -c "import py_compile; py_compile.compile('scripts/arcana_helper.py', doraise=True); print('OK')"
```
Expected: `OK`

- [ ] **Step 3: Verify check command exists in helper**

```bash
python3 scripts/arcana_helper.py check /tmp test.py 2>&1 | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('error', d.get('ok')))"
```
Expected: Error about workdir not existing (confirms the command is wired up).

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A && git commit -m "Pyright analysis: integration fixes"
```
