# Workspace Lifecycle Management — Design Spec

## Problem

Remote experiment workspaces are append-only. Each experiment adds scripts, figures, checkpoints, and logs but nothing is ever removed. After ~50 experiments a workspace can accumulate ~1000 files including hundreds of old figures, checkpoint directories, and stale outputs. This causes:

1. **sync-up failure/slowness** — rsync must stat every file on both sides to compute the delta. On NFS-backed storage this can timeout.
2. **sync-down confusion** — stale outputs from previous experiments get mixed with current results, making new experiments appear to "complete" instantly with old data.
3. **rsync during running experiments** — if a code fix needs to be synced while an experiment is producing outputs, rsync contends with actively-written files.

## Solution: Hybrid Isolation + Auto-Archive

Two complementary mechanisms:

- **Run isolation (from Approach C):** Each experiment writes to its own `run_NNN/` directory. sync-up excludes all `run_*/` dirs so it never touches experiment outputs. The running experiment's files are invisible to rsync.
- **Auto-archive (from Approach A):** After sync-down completes, the helper compresses the run directory into `.archive/run_NNN.tar.gz` and deletes the flat files. The workspace stays lean.

---

## 1. Workspace Structure

```
~/experiments/project-abc/
├── exp_055.py                    # Scripts live in root (synced up)
├── exp_056.py
├── requirements.txt
├── data/                         # Shared input data
├── .arcana/                      # Helper metadata (untouched)
│   └── status.json
├── .venv/                        # Shared venv (excluded from sync)
│
├── run_055/                      # Experiment 55's outputs (completed)
│   ├── results/
│   ├── figures/
│   ├── checkpoints/
│   ├── stdout.log
│   └── stderr.log
├── run_056/                      # Experiment 56 (currently running)
│   ├── results/
│   └── ...
│
├── .archive/                     # Compressed old runs
│   ├── run_001.tar.gz
│   ├── run_042.tar.gz
│   └── manifest.json             # Index: { name, archivedAt, sizeBytes, fileCount, hadCheckpoints }
└── .archive_policy.json          # Per-host overrides pushed from Settings
```

### Key Invariants

- **sync-up excludes `run_*/` and `.archive/`** — only pushes code, config, and data. This is the core fix: rsync never has to diff experiment outputs.
- **sync-down targets a specific `run_NNN/`** — not the whole workspace. Precise and fast.
- **The running experiment's `run_NNN/` is never touched by rsync.**
- **Scripts work without modification** — the helper `cd`s into `run_NNN/` before executing, so relative paths (`open("results.json")`, `plt.savefig("fig.png")`) resolve into the run directory naturally. No env var required.
- `ARCANA_OUTPUT_DIR` is set as a convenience for scripts that need the absolute path, but is not required.
- stdout/stderr redirect into `run_NNN/` instead of the workspace root.

---

## 2. Helper Commands

### Modified: `run <workdir> --run <name> -- <command>`

New `--run <name>` argument (e.g., `--run run_055`):

1. Create `<workdir>/run_055/` if it doesn't exist
2. Set `ARCANA_OUTPUT_DIR=<workdir>/run_055` in subprocess environment
3. `cd` into `run_055/` before executing the command
4. Redirect stdout/stderr to `run_055/stdout.log` and `run_055/stderr.log`
5. Status file stays in `.arcana/status.json` (tracks current job, not per-run)

If `--run` is omitted, falls back to current behavior (root-level logs). Backward compatible during migration.

### New: `archive <workdir> <run_name> [--include-checkpoints]`

Called automatically by the executor after successful sync-down.

1. Verify `run_NNN/` exists
2. Verify no process is running in it (check `.arcana/status.json` pid — refuse if the current job's run name matches and pid is alive)
3. If `--include-checkpoints` is absent, delete `run_NNN/checkpoints/` and `run_NNN/*ckpt*` first
4. Tar+gzip `run_NNN/` into `.archive/run_NNN.tar.gz`
5. Delete the flat `run_NNN/` directory
6. Update `.archive/manifest.json` with entry
7. Return JSON: `{ archived: "run_055", savedBytes: 142000000, archivePath: ".archive/run_055.tar.gz" }`

**Safety:** Refuses to archive if the run dir's experiment is still running.

### New: `prune <workdir> [--keep-recent N] [--max-archives N] [--dry-run]`

Manual bulk cleanup. Called by the agent's `clean_workspace` tool.

1. Archive any unarchived `run_*` dirs that have no running process (catch-up if auto-archive was missed)
2. If `.archive/` has more than `--max-archives` (default: 20) tarballs, delete oldest
3. Remove orphaned output files in root matching `*.png`, `*.pdf`, `fig_*`, `*ckpt*`, `pub_fig*`, `final_fig*` — these are pre-migration leftovers
4. Remove broken/empty `.venv/` dirs
5. Return JSON: `{ archivedRuns: [...], deletedArchives: [...], orphansCleaned: N, bytesFreed: N }`

`--dry-run` returns what would happen without doing it.

### New: `restore <workdir> <run_name>`

Unpack an archived run for re-inspection.

1. Extract `.archive/run_NNN.tar.gz` back to `run_NNN/`
2. Remove the tarball
3. Update manifest
4. Return JSON: `{ restored: "run_055", path: "run_055/" }`

---

## 3. Executor Integration (`remote-executor.ts`)

### Run naming

The executor derives the run name from the experiment script:

- `exp_055.py` → `run_055`
- `baseline_bert.py` → `run_baseline_bert`
- `sweep_lr_001.py` → `run_sweep_lr_001`

Stored on the `RemoteJob` record as `runDir`.

### Modified `submitRemoteJob()`

1. Determine run name from script
2. `syncUp()` — excludes `run_*/` and `.archive/` (new exclusions)
3. `helper run <workdir> --run <run_name> -- python3 <script>`
4. Store run name on RemoteJob
5. `runAndPoll()` in background (unchanged)

### Modified `syncUp()`

Add exclusions:

```
--exclude='run_*' --exclude='.archive'
```

This is the core fix — sync-up no longer stats hundreds of output files from previous experiments.

### Modified `syncDown()`

Target the specific run directory:

```
rsync -azP -e "ssh [args]" "user@host:workdir/run_055/" "local_dir/run_055/"
```

Plus explicit log sync from `run_055/stdout.log` and `run_055/stderr.log`.

### New: `archiveRun()` — called after successful sync-down

1. Read host's cleanup policy from `RemoteHost` config
2. If policy is `"none"` → skip
3. SSH: `helper archive <workdir> <run_name> [--include-checkpoints]` based on policy
4. Log bytes saved, archive path
5. Update RemoteJob: `archivedAt` timestamp

Called automatically at the end of `runAndPoll()` after sync-down succeeds. If archive fails (SSH error, still running), log a warning but don't fail the job — cleanup is best-effort.

---

## 4. Agent Integration

### New tool: `clean_workspace`

```
Input:  { dry_run?: boolean, keep_recent?: number }
Output: Summary of what was archived/pruned
```

- Calls helper `prune <workdir> --keep-recent N [--dry-run]`
- Available in all phases (not phase-restricted)
- Agent can call proactively when workspace health is poor

### Modified `get_workspace`

The manifest response now includes:

- Active run dirs (with sizes)
- Archive count and total archive size
- `workspace_health` field: `"clean"` | `"needs_attention"` (>500 files or >10 unarchived runs)

When health is `"needs_attention"`, tool output includes: *"Workspace has N unarchived experiment runs. Consider calling clean_workspace."*

### Modified `check_job` / sync-down path

Reads results from `run_NNN/` instead of workspace root. The `runDir` on the RemoteJob tells it exactly where to look.

---

## 5. Schema Changes

### RemoteJob — add fields

```prisma
runDir      String?    // Run directory name (e.g., "run_055")
archivedAt  DateTime?  // When remote outputs were archived
```

### RemoteHost — add fields

```prisma
cleanupPolicy  String  @default("archive")  // "archive" | "archive-with-checkpoints" | "delete" | "none"
maxArchives    Int     @default(20)          // Max tarballs before oldest are pruned
```

---

## 6. Settings UI

In the existing Remote Hosts configuration form, add a **Workspace Cleanup** section:

- **Cleanup policy** — dropdown: `Archive after sync` (default) | `Archive with checkpoints` | `Delete after sync` | `None`
- **Max archives** — number input, default 20

Maps to `cleanupPolicy` and `maxArchives` on `RemoteHost`. No new page — inline with existing host settings.

---

## Migration / Backward Compatibility

- **Helper `--run` flag is optional.** If omitted, current root-level behavior is preserved. Old jobs continue to work.
- **Existing workspaces** with scattered files: the first `prune` call will archive old `run_*` dirs and clean orphaned root-level output files.
- **RemoteJob records without `runDir`**: executor falls back to root-level sync-down (current behavior).
- **Helper version bump** to 7: executor checks version before using `--run` flag. If old helper, falls back to current behavior and logs a warning to update.

---

## Verification Checklist

1. `npx prisma db push` + `npx tsc --noEmit` pass
2. New experiment writes outputs to `run_NNN/` — not workspace root
3. sync-up excludes `run_*/` and `.archive/` — fast even with many past experiments
4. sync-down targets specific `run_NNN/` — gets correct results
5. Auto-archive compresses `run_NNN/` after sync-down
6. Archive refuses to compress a still-running experiment
7. `prune` archives unarchived runs + deletes old archives beyond max
8. `prune --dry-run` reports without acting
9. `restore` unpacks an archive
10. `clean_workspace` agent tool calls prune and returns summary
11. `get_workspace` reports workspace health
12. Host cleanup policy "none" skips auto-archive
13. Host cleanup policy "archive-with-checkpoints" includes checkpoints in tarball
14. Old helper (version <7) falls back to root-level behavior gracefully
15. Orphaned root-level files (pre-migration) cleaned by first prune
16. Settings UI shows cleanup policy per host
