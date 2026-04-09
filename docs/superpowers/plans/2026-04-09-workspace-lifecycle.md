# Workspace Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Isolate each experiment's outputs into a `run_NNN/` directory, auto-archive after sync-down, and provide manual cleanup tools — so workspaces stay lean during active research.

**Architecture:** Helper gets `--run` flag + 3 new commands (archive, prune, restore). Executor derives run name from script, passes `--run` to helper, targets sync-down to specific run dir, auto-archives after sync. Agent gets a `clean_workspace` tool. Settings UI adds cleanup policy per host.

**Tech Stack:** Python (helper, stdlib only), TypeScript (executor, agent, workspace, settings API), Prisma (schema), React (settings UI)

---

### Task 1: Schema Migration

**Files:**
- Modify: `prisma/schema.prisma:618-668` (RemoteHost + RemoteJob models)

- [ ] **Step 1: Add fields to RemoteHost**

In `prisma/schema.prisma`, add two fields to the `RemoteHost` model, after `envVars`:

```prisma
  cleanupPolicy    String   @default("archive")  // "archive" | "archive-with-checkpoints" | "delete" | "none"
  maxArchives      Int      @default(20)          // Max tarballs in .archive/ before oldest are pruned
```

- [ ] **Step 2: Add fields to RemoteJob**

In `prisma/schema.prisma`, add two fields to the `RemoteJob` model, after `errorClass`:

```prisma
  runDir        String?                     // Run directory name (e.g., "run_055")
  archivedAt    DateTime?                   // When remote outputs were archived post-sync
```

- [ ] **Step 3: Push schema and verify**

Run:
```bash
npx prisma db push && npx prisma generate
```
Expected: Schema applied successfully, client regenerated.

- [ ] **Step 4: Verify TypeScript still compiles**

Run:
```bash
npx tsc --noEmit 2>&1 | head -20
```
Expected: No new errors (existing errors, if any, are pre-existing).

- [ ] **Step 5: Commit**

```bash
git add prisma/schema.prisma
git commit -m "Add workspace lifecycle fields — runDir, archivedAt, cleanupPolicy, maxArchives"
```

---

### Task 2: Helper — Modified `run` with `--run` flag

**Files:**
- Modify: `scripts/arcana_helper.py:34` (HELPER_VERSION), `scripts/arcana_helper.py:345-495` (cmd_run), `scripts/arcana_helper.py:498-637` (cmd_monitor), `scripts/arcana_helper.py:892-958` (main arg parser)

- [ ] **Step 1: Bump HELPER_VERSION to "7"**

In `scripts/arcana_helper.py`, line 34:

```python
HELPER_VERSION = "7"
```

- [ ] **Step 2: Update the docstring to list new commands**

Replace the docstring (lines 2-21) with:

```python
"""
Arcana Remote Helper — installed once on remote GPU hosts.

Self-contained (stdlib only). Handles:
- Process supervision with OOM detection
- Virtual environment management
- Structured JSON status reporting
- Resource monitoring (CPU RAM, GPU memory)
- Workspace lifecycle (archive, prune, restore)

Invoked via: python3 ~/.arcana/helper.py <command> [args...]

Commands:
  run <workdir> [--run <name>] -- <command...>   Launch experiment in background
  status <workdir>                Get structured status JSON
  logs <workdir> [--lines N]     Tail stdout/stderr
  kill <workdir>                  Kill experiment process group
  setup-env <workdir>            Setup venv + install requirements
  info                           Host info (RAM, GPUs, disk)
  manifest <workdir>             Structured workspace manifest (files, results, packages)
  archive <workdir> <run_name> [--include-checkpoints]  Archive a completed run
  prune <workdir> [--keep-recent N] [--max-archives N] [--dry-run]  Bulk cleanup
  restore <workdir> <run_name>   Restore an archived run
  version                        Print helper version
"""
```

- [ ] **Step 3: Modify cmd_run to accept --run flag**

Replace `cmd_run` (lines 345-495) with this updated version. The key changes are: parse `--run` from argv before `--`, create the run dir, set `ARCANA_OUTPUT_DIR`, `cd` into run dir, redirect stdout/stderr into run dir, and store `run_name` in status.json.

```python
def cmd_run(workdir, command, run_name=None):
    """Launch experiment in background with monitoring."""
    workdir = os.path.abspath(workdir)
    if not os.path.isdir(workdir):
        json_err(f"Workdir does not exist: {workdir}")

    # Auto-kill any running experiment in this workdir before starting a new one
    # Process management is infrastructure — handled automatically, not by the agent
    status = read_status(workdir)
    if status and status.get("status") == "running":
        old_pid = status.get("pid")
        old_pgid = status.get("pgid")
        if old_pid and is_pid_alive(old_pid):
            try:
                if old_pgid:
                    os.killpg(old_pgid, signal.SIGTERM)
                else:
                    os.kill(old_pid, signal.SIGTERM)
                # Give it a moment to die
                for _ in range(10):
                    if not is_pid_alive(old_pid):
                        break
                    time.sleep(0.5)
                # Force kill if still alive
                if is_pid_alive(old_pid):
                    try:
                        if old_pgid:
                            os.killpg(old_pgid, signal.SIGKILL)
                        else:
                            os.kill(old_pid, signal.SIGKILL)
                    except Exception:
                        pass
            except Exception:
                pass
            status["status"] = "cancelled"
            status["completed_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
            write_status(workdir, status)

    # Create run directory if --run was specified
    run_dir = None
    if run_name:
        run_dir = os.path.join(workdir, run_name)
        os.makedirs(run_dir, exist_ok=True)

    # Check for pre-existing environment (user-configured venv/conda)
    conda_env = os.environ.get("ARCANA_CONDA", "")
    has_existing_env = bool(conda_env.strip())

    write_status(workdir, {
        "status": "setup",
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "run_name": run_name,
    })

    # Only create/install venv if NO pre-existing environment is configured
    msg = "Using pre-configured environment" if has_existing_env else ""
    if not has_existing_env:
        success, msg = setup_venv(workdir)
        if not success:
            write_status(workdir, {
                "status": "failed",
                "error": msg,
                "started_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "completed_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "run_name": run_name,
            })
            json_err(f"Environment setup failed: {msg}")

    # Build the actual command to run
    # Working directory is the run dir if specified, otherwise workdir
    cwd = run_dir or workdir
    shell_parts = [f"cd {cwd}"]

    # Pre-existing env takes priority
    if has_existing_env:
        # Support: /path/to/bin/activate, /path/to/bin/python, conda env name
        if conda_env.endswith("/activate"):
            shell_parts.append(f"source {conda_env}")
        elif conda_env.endswith("/python") or conda_env.endswith("/python3"):
            bin_dir = os.path.dirname(conda_env)
            activate = os.path.join(bin_dir, "activate")
            shell_parts.append(f"source {activate} 2>/dev/null || export PATH={bin_dir}:$PATH")
        else:
            shell_parts.append(
                f"conda activate {conda_env} 2>/dev/null || source activate {conda_env} 2>/dev/null || source {conda_env} 2>/dev/null || true"
            )
    else:
        # No pre-existing env — use .venv if it was created by setup_venv
        venv_activate = os.path.join(workdir, ".venv", "bin", "activate")
        if os.path.exists(venv_activate):
            shell_parts.append(f"source {venv_activate}")

    # Custom setup command from env var
    setup_cmd = os.environ.get("ARCANA_SETUP")
    if setup_cmd:
        shell_parts.append(setup_cmd)

    # Set ARCANA_OUTPUT_DIR so scripts can find the output path if needed
    if run_dir:
        shell_parts.append(f"export ARCANA_OUTPUT_DIR='{run_dir}'")

    # Wrap command to capture its exit code — the monitor can't use waitpid
    # because the experiment is a sibling, not a child process.
    exit_code_file = os.path.join(workdir, ARCANA_DIR, "exit_code")
    shell_parts.append(f'({command}); __ec=$?; echo $__ec > {exit_code_file}; exit $__ec')
    full_cmd = " && ".join(shell_parts)

    # Launch as background process — stdout/stderr go to run dir if specified
    stdout_path = os.path.join(cwd, "stdout.log")
    stderr_path = os.path.join(cwd, "stderr.log")

    stdout_f = open(stdout_path, "w")
    stderr_f = open(stderr_path, "w")

    proc = subprocess.Popen(
        ["bash", "-c", full_cmd],
        stdout=stdout_f,
        stderr=stderr_f,
        cwd=cwd,
        start_new_session=True,  # new process group
        close_fds=True,
    )

    pid = proc.pid
    pgid = os.getpgid(pid)

    # Write initial status
    write_status(workdir, {
        "pid": pid,
        "pgid": pgid,
        "status": "running",
        "exit_code": None,
        "started_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "completed_at": None,
        "oom_detected": False,
        "oom_detail": "",
        "env_setup_msg": msg,
        "run_name": run_name,
        "resource_snapshots": [take_snapshot()],
        "stdout_tail": "",
        "stderr_tail": "",
    })

    # Close file handles in parent (child has its own)
    stdout_f.close()
    stderr_f.close()

    # Launch monitor as a detached subprocess
    monitor_cmd = [
        sys.executable, os.path.abspath(__file__),
        "_monitor", workdir, str(pid), str(pgid),
    ]
    monitor_proc = subprocess.Popen(
        monitor_cmd,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
        close_fds=True,
    )

    # Save monitor PID
    arcana_dir = os.path.join(workdir, ARCANA_DIR)
    with open(os.path.join(arcana_dir, MONITOR_PID_FILE), "w") as f:
        f.write(str(monitor_proc.pid))

    json_out({"ok": True, "pid": pid, "pgid": pgid, "run_name": run_name})
```

- [ ] **Step 4: Update cmd_monitor to read logs from run dir**

The monitor reads stdout/stderr from run dir when `run_name` is present. In `cmd_monitor` (line ~498), the tailing paths need to respect the run dir. Replace the `stdout_tail`/`stderr_tail` lines in the polling loop (around line 528-529) with:

```python
            # Read log paths — from run dir if set, else workdir root
            run_name = status.get("run_name")
            log_base = os.path.join(workdir, run_name) if run_name else workdir
            status["stdout_tail"] = tail_file(os.path.join(log_base, "stdout.log"), 50)
            status["stderr_tail"] = tail_file(os.path.join(log_base, "stderr.log"), 20)
```

And similarly for the final status update (around line 634-635):

```python
    run_name = status.get("run_name")
    log_base = os.path.join(workdir, run_name) if run_name else workdir
    status.update({
        ...
        "stdout_tail": tail_file(os.path.join(log_base, "stdout.log"), 100),
        "stderr_tail": tail_file(os.path.join(log_base, "stderr.log"), 50),
    })
```

- [ ] **Step 5: Update cmd_status to read logs from run dir**

In `cmd_status` (line ~640), the log tailing at the end (line 704-705) must also respect run_name:

```python
    # Always refresh log tails
    run_name = status.get("run_name") if status else None
    log_base = os.path.join(workdir, run_name) if run_name else workdir
    status["stdout_tail"] = tail_file(os.path.join(log_base, "stdout.log"), 100)
    status["stderr_tail"] = tail_file(os.path.join(log_base, "stderr.log"), 50)
```

- [ ] **Step 6: Update cmd_logs to read from run dir**

In `cmd_logs` (line ~711), check status for run_name:

```python
def cmd_logs(workdir, lines=200, stderr_lines=50):
    """Tail stdout/stderr."""
    workdir = os.path.abspath(workdir)
    # Check if there's an active run with a run dir
    status = read_status(workdir)
    run_name = status.get("run_name") if status else None
    log_base = os.path.join(workdir, run_name) if run_name else workdir
    json_out({
        "ok": True,
        "stdout": tail_file(os.path.join(log_base, "stdout.log"), lines),
        "stderr": tail_file(os.path.join(log_base, "stderr.log"), stderr_lines),
    })
```

- [ ] **Step 7: Update main() arg parser for --run flag**

In `main()` (line ~894), update the `run` command parser to extract `--run <name>` before `--`:

```python
        elif cmd == "run":
            # Parse: run <workdir> [--run <name>] -- <command...>
            args = sys.argv[2:]
            run_name = None
            # Extract --run <name> if present
            if "--run" in args:
                ri = args.index("--run")
                if ri + 1 < len(args):
                    run_name = args[ri + 1]
                    args = args[:ri] + args[ri + 2:]  # Remove --run and its value
            if "--" not in args:
                # Fallback: run <workdir> <command as single string>
                if len(args) < 2:
                    json_err("Usage: run <workdir> [--run <name>] -- <command...>")
                workdir = args[0]
                command = " ".join(args[1:])
            else:
                sep_idx = args.index("--")
                workdir = args[0]
                command = " ".join(args[sep_idx + 1:])
            cmd_run(workdir, command, run_name=run_name)
```

- [ ] **Step 8: Commit**

```bash
git add scripts/arcana_helper.py
git commit -m "Helper v7: --run flag for per-experiment output isolation"
```

---

### Task 3: Helper — `archive` command

**Files:**
- Modify: `scripts/arcana_helper.py` (add cmd_archive + wire into main)

- [ ] **Step 1: Add cmd_archive function**

Add this after `cmd_manifest` (around line 884):

```python
def cmd_archive(workdir, run_name, include_checkpoints=False):
    """Archive a completed experiment run into .archive/."""
    import shutil
    import tarfile

    workdir = os.path.abspath(workdir)
    run_dir = os.path.join(workdir, run_name)

    if not os.path.isdir(run_dir):
        json_err(f"Run directory does not exist: {run_name}")

    # Safety: refuse to archive if the current job is still running in this run dir
    status = read_status(workdir)
    if status and status.get("status") == "running" and status.get("run_name") == run_name:
        pid = status.get("pid")
        if pid and is_pid_alive(pid):
            json_err(f"Cannot archive {run_name} — experiment is still running (PID {pid})")

    # Delete checkpoints before archiving (unless --include-checkpoints)
    if not include_checkpoints:
        for item in os.listdir(run_dir):
            item_path = os.path.join(run_dir, item)
            if item == "checkpoints" and os.path.isdir(item_path):
                shutil.rmtree(item_path, ignore_errors=True)
            elif "ckpt" in item.lower() and os.path.isdir(item_path):
                shutil.rmtree(item_path, ignore_errors=True)

    # Count files and measure size before archiving
    file_count = 0
    total_size = 0
    for root, dirs, files in os.walk(run_dir):
        for f in files:
            fpath = os.path.join(root, f)
            try:
                total_size += os.path.getsize(fpath)
                file_count += 1
            except OSError:
                pass

    # Create .archive/ directory
    archive_dir = os.path.join(workdir, ".archive")
    os.makedirs(archive_dir, exist_ok=True)

    # Create tarball
    archive_path = os.path.join(archive_dir, f"{run_name}.tar.gz")
    try:
        with tarfile.open(archive_path, "w:gz") as tar:
            tar.add(run_dir, arcname=run_name)
    except Exception as e:
        json_err(f"Failed to create archive: {e}")

    archive_size = os.path.getsize(archive_path)

    # Delete the flat run directory
    shutil.rmtree(run_dir, ignore_errors=True)

    # Update manifest
    manifest_path = os.path.join(archive_dir, "manifest.json")
    manifest = []
    try:
        with open(manifest_path) as f:
            manifest = json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        pass

    manifest.append({
        "name": run_name,
        "archivedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "sizeBytes": archive_size,
        "originalSizeBytes": total_size,
        "fileCount": file_count,
        "hadCheckpoints": include_checkpoints,
    })

    with open(manifest_path, "w") as f:
        json.dump(manifest, f, indent=2)

    saved_bytes = total_size - archive_size
    json_out({
        "ok": True,
        "archived": run_name,
        "savedBytes": saved_bytes,
        "archiveSize": archive_size,
        "archivePath": f".archive/{run_name}.tar.gz",
        "fileCount": file_count,
    })
```

- [ ] **Step 2: Wire archive into main()**

Add this case in `main()` before the `_monitor` case:

```python
        elif cmd == "archive":
            if len(sys.argv) < 4:
                json_err("Usage: archive <workdir> <run_name> [--include-checkpoints]")
            include_ckpt = "--include-checkpoints" in sys.argv
            cmd_archive(sys.argv[2], sys.argv[3], include_checkpoints=include_ckpt)
```

- [ ] **Step 3: Commit**

```bash
git add scripts/arcana_helper.py
git commit -m "Helper: add archive command — compress completed run dirs"
```

---

### Task 4: Helper — `prune` command

**Files:**
- Modify: `scripts/arcana_helper.py` (add cmd_prune + wire into main)

- [ ] **Step 1: Add cmd_prune function**

Add after `cmd_archive`:

```python
def cmd_prune(workdir, keep_recent=0, max_archives=20, dry_run=False):
    """Bulk workspace cleanup: archive stale runs, trim old archives, remove orphans."""
    import shutil
    import glob as glob_mod

    workdir = os.path.abspath(workdir)
    if not os.path.isdir(workdir):
        json_err(f"Workdir does not exist: {workdir}")

    result = {
        "archivedRuns": [],
        "deletedArchives": [],
        "orphansCleaned": 0,
        "bytesFreed": 0,
    }

    # Check current running status
    status = read_status(workdir)
    running_run_name = None
    if status and status.get("status") == "running":
        pid = status.get("pid")
        if pid and is_pid_alive(pid):
            running_run_name = status.get("run_name")

    # 1. Archive any unarchived run_* dirs (except running and recent)
    run_dirs = sorted([
        d for d in os.listdir(workdir)
        if d.startswith("run_") and os.path.isdir(os.path.join(workdir, d))
    ])

    # Skip the most recent N run dirs
    archivable = run_dirs[:-keep_recent] if keep_recent > 0 and len(run_dirs) > keep_recent else run_dirs

    for rd in archivable:
        if rd == running_run_name:
            continue  # Skip currently running
        run_path = os.path.join(workdir, rd)
        archive_path = os.path.join(workdir, ".archive", f"{rd}.tar.gz")
        if os.path.exists(archive_path):
            continue  # Already archived

        if dry_run:
            result["archivedRuns"].append(rd)
        else:
            try:
                # Reuse cmd_archive logic but inline the essentials
                import tarfile
                archive_dir = os.path.join(workdir, ".archive")
                os.makedirs(archive_dir, exist_ok=True)

                dir_size = 0
                file_count = 0
                for root, dirs, files in os.walk(run_path):
                    for f in files:
                        try:
                            dir_size += os.path.getsize(os.path.join(root, f))
                            file_count += 1
                        except OSError:
                            pass

                with tarfile.open(archive_path, "w:gz") as tar:
                    tar.add(run_path, arcname=rd)

                archive_size = os.path.getsize(archive_path)
                shutil.rmtree(run_path, ignore_errors=True)

                # Update manifest
                manifest_path = os.path.join(archive_dir, "manifest.json")
                manifest = []
                try:
                    with open(manifest_path) as f:
                        manifest = json.load(f)
                except (FileNotFoundError, json.JSONDecodeError):
                    pass
                manifest.append({
                    "name": rd,
                    "archivedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
                    "sizeBytes": archive_size,
                    "originalSizeBytes": dir_size,
                    "fileCount": file_count,
                    "hadCheckpoints": False,
                })
                with open(manifest_path, "w") as f:
                    json.dump(manifest, f, indent=2)

                result["archivedRuns"].append(rd)
                result["bytesFreed"] += dir_size - archive_size
            except Exception as e:
                sys.stderr.write(f"[prune] Failed to archive {rd}: {e}\n")

    # 2. Trim old archives beyond max_archives
    archive_dir = os.path.join(workdir, ".archive")
    if os.path.isdir(archive_dir):
        archives = sorted(glob_mod.glob(os.path.join(archive_dir, "run_*.tar.gz")))
        if len(archives) > max_archives:
            to_delete = archives[:len(archives) - max_archives]
            for ap in to_delete:
                name = os.path.basename(ap).replace(".tar.gz", "")
                if dry_run:
                    result["deletedArchives"].append(name)
                else:
                    try:
                        sz = os.path.getsize(ap)
                        os.remove(ap)
                        result["deletedArchives"].append(name)
                        result["bytesFreed"] += sz
                    except OSError:
                        pass

            # Update manifest to remove deleted entries
            if not dry_run:
                manifest_path = os.path.join(archive_dir, "manifest.json")
                try:
                    with open(manifest_path) as f:
                        manifest = json.load(f)
                    deleted_names = set(result["deletedArchives"])
                    manifest = [e for e in manifest if e.get("name") not in deleted_names]
                    with open(manifest_path, "w") as f:
                        json.dump(manifest, f, indent=2)
                except Exception:
                    pass

    # 3. Remove orphaned output files in root (pre-migration leftovers)
    orphan_patterns = ["*.png", "*.pdf", "fig_*", "*ckpt*", "pub_fig*", "final_fig*"]
    for pattern in orphan_patterns:
        for fpath in glob_mod.glob(os.path.join(workdir, pattern)):
            if os.path.isfile(fpath):
                if dry_run:
                    result["orphansCleaned"] += 1
                else:
                    try:
                        sz = os.path.getsize(fpath)
                        os.remove(fpath)
                        result["orphansCleaned"] += 1
                        result["bytesFreed"] += sz
                    except OSError:
                        pass
            elif os.path.isdir(fpath) and "ckpt" in fpath.lower():
                if dry_run:
                    result["orphansCleaned"] += 1
                else:
                    try:
                        dir_size = sum(
                            os.path.getsize(os.path.join(r, f))
                            for r, _, fs in os.walk(fpath)
                            for f in fs
                        )
                        shutil.rmtree(fpath, ignore_errors=True)
                        result["orphansCleaned"] += 1
                        result["bytesFreed"] += dir_size
                    except Exception:
                        pass

    # 4. Remove broken .venv dirs
    venv_path = os.path.join(workdir, ".venv")
    if os.path.isdir(venv_path) and not os.path.exists(os.path.join(venv_path, "bin")):
        if not dry_run:
            shutil.rmtree(venv_path, ignore_errors=True)

    result["ok"] = True
    result["dryRun"] = dry_run
    json_out(result)
```

- [ ] **Step 2: Wire prune into main()**

Add this case in `main()`:

```python
        elif cmd == "prune":
            if len(sys.argv) < 3:
                json_err("Usage: prune <workdir> [--keep-recent N] [--max-archives N] [--dry-run]")
            keep_recent = 0
            max_archives = 20
            dry_run = "--dry-run" in sys.argv
            for i, arg in enumerate(sys.argv):
                if arg == "--keep-recent" and i + 1 < len(sys.argv):
                    keep_recent = int(sys.argv[i + 1])
                if arg == "--max-archives" and i + 1 < len(sys.argv):
                    max_archives = int(sys.argv[i + 1])
            cmd_prune(sys.argv[2], keep_recent=keep_recent, max_archives=max_archives, dry_run=dry_run)
```

- [ ] **Step 3: Commit**

```bash
git add scripts/arcana_helper.py
git commit -m "Helper: add prune command — bulk workspace cleanup"
```

---

### Task 5: Helper — `restore` command

**Files:**
- Modify: `scripts/arcana_helper.py` (add cmd_restore + wire into main)

- [ ] **Step 1: Add cmd_restore function**

Add after `cmd_prune`:

```python
def cmd_restore(workdir, run_name):
    """Restore an archived run directory."""
    import tarfile

    workdir = os.path.abspath(workdir)
    archive_dir = os.path.join(workdir, ".archive")
    archive_path = os.path.join(archive_dir, f"{run_name}.tar.gz")

    if not os.path.exists(archive_path):
        json_err(f"Archive not found: .archive/{run_name}.tar.gz")

    run_dir = os.path.join(workdir, run_name)
    if os.path.exists(run_dir):
        json_err(f"Run directory already exists: {run_name}. Remove it first.")

    try:
        with tarfile.open(archive_path, "r:gz") as tar:
            tar.extractall(path=workdir)
    except Exception as e:
        json_err(f"Failed to extract archive: {e}")

    # Remove the tarball
    os.remove(archive_path)

    # Update manifest — remove this entry
    manifest_path = os.path.join(archive_dir, "manifest.json")
    try:
        with open(manifest_path) as f:
            manifest = json.load(f)
        manifest = [e for e in manifest if e.get("name") != run_name]
        with open(manifest_path, "w") as f:
            json.dump(manifest, f, indent=2)
    except Exception:
        pass

    json_out({"ok": True, "restored": run_name, "path": run_name + "/"})
```

- [ ] **Step 2: Wire restore into main()**

```python
        elif cmd == "restore":
            if len(sys.argv) < 4:
                json_err("Usage: restore <workdir> <run_name>")
            cmd_restore(sys.argv[2], sys.argv[3])
```

- [ ] **Step 3: Commit**

```bash
git add scripts/arcana_helper.py
git commit -m "Helper: add restore command — unpack archived runs"
```

---

### Task 6: Executor — Run naming + modified syncUp

**Files:**
- Modify: `src/lib/research/remote-executor.ts:17` (HELPER_VERSION), `src/lib/research/remote-executor.ts:269-308` (syncUp), `src/lib/research/remote-executor.ts:404-469` (submitRemoteJob)

- [ ] **Step 1: Bump HELPER_VERSION and add deriveRunName helper**

At the top of `remote-executor.ts`, change line 18:

```typescript
const HELPER_VERSION = "7";
```

Add a helper function after `hostToConfig` (around line 159):

```typescript
/** Derive a run directory name from an experiment command.
 *  e.g. "python3 exp_055.py" → "run_055"
 *       "python3 baseline_bert.py --lr 0.001" → "run_baseline_bert"
 */
function deriveRunName(command: string): string {
  const scriptMatch = command.match(/python3?\s+(\S+\.py)/);
  if (!scriptMatch) return `run_${Date.now()}`;
  const scriptName = scriptMatch[1].replace(/\.py$/, "");
  // Strip exp_ prefix to avoid "run_exp_055" — just "run_055"
  const cleaned = scriptName.replace(/^exp_/, "");
  return `run_${cleaned}`;
}
```

- [ ] **Step 2: Add run_* and .archive exclusions to syncUp**

In `sshExecutor.syncUp` (line ~285), add the two new exclusions to the rsync command. Replace the rsync command string:

```typescript
    const rsyncCmd = `rsync -azP --delete --exclude='.nfs*' --exclude='.venv' --exclude='__pycache__' --exclude='*.pyc' --exclude='stdout.log' --exclude='stderr.log' --exclude='.exit_code' --exclude='.arcana' --exclude='run_*' --exclude='.archive' --ignore-errors -e "${sshCmd}" "${src}" "${target}:${remoteDir}/"`;
```

The only change is adding `--exclude='run_*' --exclude='.archive'`.

- [ ] **Step 3: Modify submitRemoteJob to pass --run flag**

In `submitRemoteJob` (line ~404), add `runDir` to the job creation and pass `--run` to the helper.

After the job is created (line ~421), add run name derivation:

```typescript
  const runName = deriveRunName(params.command);
```

Update the job creation `data` to include `runDir: runName`:

```typescript
  const job = await prisma.remoteJob.create({
    data: {
      hostId: host.id,
      stepId: params.stepId || null,
      projectId: params.projectId || null,
      localDir: params.localDir,
      remoteDir: "", // will be set after sync
      command: params.command,
      scriptHash: params.scriptHash || null,
      hypothesisId: params.hypothesisId || null,
      runDir: runName,
      status: "SYNCING",
    },
  });
```

Pass the `runName` to `runAndPoll`:

```typescript
  runAndPoll(job.id, config, backend, remoteDir, params.command, params.localDir, runName).catch((err) => {
    console.error(`[remote-executor] Job ${job.id} background error:`, err);
  });
```

- [ ] **Step 4: Update runAndPoll signature and run command**

Add `runName` parameter to `runAndPoll`:

```typescript
async function runAndPoll(
  jobId: string,
  config: HostConfig,
  backend: ExecutorBackend,
  remoteDir: string,
  command: string,
  localDir?: string,
  runName?: string,
) {
```

In the `backend.run` call (line ~481), the run command needs to pass `--run` to the helper. Update the `sshExecutor.run` method signature and implementation — but actually the `run` method calls `invokeHelper` which calls the helper. So we need to modify `sshExecutor.run` to accept an optional `runName` and pass it to the helper.

Update `ExecutorBackend.run` interface:

```typescript
  /** Start the experiment, return remote PID */
  run(remoteDir: string, command: string, host: HostConfig, runName?: string): Promise<number>;
```

Update `sshExecutor.run`:

```typescript
  async run(remoteDir: string, command: string, host: HostConfig, runName?: string): Promise<number> {
    const cleanCmd = command.replace(/\s+/g, " ").trim();
    const escaped = cleanCmd.replace(/'/g, "'\\''");
    const runFlag = runName ? `--run ${runName} ` : "";
    const raw = await invokeHelper(host, `run ${remoteDir} ${runFlag}-- '${escaped}'`);
    const result = parseHelperResponse<{ ok: boolean; pid: number; pgid: number }>(raw);
    return result.pid;
  },
```

Update the call in `runAndPoll`:

```typescript
    const pid = await backend.run(remoteDir, command, config, runName);
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/research/remote-executor.ts
git commit -m "Executor: run isolation — derive run name, pass --run to helper, exclude run_* from syncUp"
```

---

### Task 7: Executor — Modified syncDown + archiveRun

**Files:**
- Modify: `src/lib/research/remote-executor.ts:348-378` (syncDown), `src/lib/research/remote-executor.ts:471-814` (runAndPoll)

- [ ] **Step 1: Update syncDown to target run dir**

Update `sshExecutor.syncDown` to accept optional `runName`. When present, sync from `remoteDir/run_NNN/` to `localDir/run_NNN/` instead of the root:

Update the interface:

```typescript
  /** Sync results back from remote to local */
  syncDown(remoteDir: string, localDir: string, host: HostConfig, runName?: string): Promise<void>;
```

Replace the `syncDown` implementation:

```typescript
  async syncDown(remoteDir: string, localDir: string, host: HostConfig, runName?: string): Promise<void> {
    const sshCmd = `ssh ${sshArgs(host).join(" ")}`;
    const target = sshTarget(host);
    const SYNC_TIMEOUT = 600_000; // 10 min

    if (runName) {
      // Targeted sync: grab the entire run directory
      const localRunDir = path.join(localDir, runName);
      const fs = await import("fs");
      fs.mkdirSync(localRunDir, { recursive: true });

      await execAsync(
        `rsync -azP -e "${sshCmd}" "${target}:${remoteDir}/${runName}/" "${localRunDir}/"`,
        { timeout: SYNC_TIMEOUT },
      ).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        // Non-fatal rsync errors (NFS locks, vanished files)
        if (msg.includes("code 23") || msg.includes("code 24") || msg.includes("some files vanished")) {
          console.warn("[remote-executor] syncDown had non-fatal errors, continuing");
        } else {
          console.warn(`[remote-executor] syncDown from ${runName}/ failed: ${msg.slice(0, 200)}`);
        }
      });
      return;
    }

    // Legacy: no run name — sync from root (existing behavior)
    await execAsync(
      `rsync -azP -e "${sshCmd}" "${target}:${remoteDir}/results/" "${localDir}/results/"`,
      { timeout: SYNC_TIMEOUT },
    ).catch(() => {});

    await execAsync(
      `rsync -azP --include='*.json' --include='*.csv' --include='*.txt' --include='*.png' --include='*.log' --exclude='*/' --exclude='*.py' --exclude='requirements.txt' -e "${sshCmd}" "${target}:${remoteDir}/" "${localDir}/"`,
      { timeout: SYNC_TIMEOUT },
    ).catch(() => {});

    for (const f of ["stdout.log", "stderr.log"]) {
      const scpArgs = sshArgs(host).map(a => `"${a}"`).join(" ");
      await execAsync(
        `scp ${scpArgs} "${target}:${remoteDir}/${f}" "${localDir}/${f}"`,
        { timeout: 60_000 },
      ).catch(() => {});
    }
  },
```

- [ ] **Step 2: Add archiveRun function**

Add after `cleanupStaleJobs` (around line 945):

```typescript
/**
 * Archive a completed run on the remote host.
 * Called after successful syncDown. Best-effort — failures are logged, not thrown.
 */
async function archiveRun(
  jobId: string,
  config: HostConfig,
  remoteDir: string,
  runName: string,
  cleanupPolicy: string,
): Promise<void> {
  if (cleanupPolicy === "none") return;

  const includeCheckpoints = cleanupPolicy === "archive-with-checkpoints";
  const ckptFlag = includeCheckpoints ? " --include-checkpoints" : "";

  try {
    if (cleanupPolicy === "delete") {
      // Just delete the run dir — don't archive
      await sshExec(config, `rm -rf ${remoteDir}/${runName}`);
    } else {
      const raw = await invokeHelper(config, `archive ${remoteDir} ${runName}${ckptFlag}`);
      const result = parseHelperResponse<{ archived: string; savedBytes: number }>(raw);
      console.log(`[remote-executor] Archived ${runName}: saved ${Math.round(result.savedBytes / 1024)}KB`);
    }

    await prisma.remoteJob.update({
      where: { id: jobId },
      data: { archivedAt: new Date() },
    });
  } catch (err) {
    // Best-effort — don't fail the job because archival failed
    console.warn(`[remote-executor] archiveRun failed for ${runName}:`, err instanceof Error ? err.message : err);
  }
}
```

- [ ] **Step 3: Call archiveRun and pass runName to syncDown in runAndPoll**

In `runAndPoll`, after the syncDown call (around line 557-562), read the job's runName and host cleanup policy, then call archiveRun.

Update the syncDown call to pass `runName`:

```typescript
    // 4. Sync results back — ALWAYS, even on failure (to recover partial results)
    if (localDir) {
      try {
        await backend.syncDown(remoteDir, localDir, config, runName);
      } catch (syncErr) {
        console.warn(`[remote-executor] syncDown failed for job ${jobId}:`, syncErr);
      }

      // 4b. Archive the run on the remote host (best-effort, post-sync)
      if (runName && !failed && !indeterminate) {
        const host = await prisma.remoteHost.findFirst({
          where: { jobs: { some: { id: jobId } } },
          select: { cleanupPolicy: true },
        });
        const policy = host?.cleanupPolicy || "archive";
        await archiveRun(jobId, config, remoteDir, runName, policy);
      }
    }
```

Note: this must be placed after the `failed`/`indeterminate` variables are computed (after step 3 in the original code, around line 585), but before the final DB update. Move the syncDown block below the exit code extraction and status determination.

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/research/remote-executor.ts
git commit -m "Executor: targeted syncDown per run dir + auto-archive after sync"
```

---

### Task 8: Workspace — Health reporting

**Files:**
- Modify: `src/lib/research/workspace.ts`

- [ ] **Step 1: Add health fields to WorkspaceState**

Add to the `WorkspaceState` interface:

```typescript
  runDirs: { name: string; fileCount: number; sizeBytes: number }[];
  archiveCount: number;
  archiveTotalBytes: number;
  workspaceHealth: "clean" | "needs_attention";
```

- [ ] **Step 2: Update getWorkspaceState to compute health**

In `getWorkspaceState`, after parsing the manifest response, compute the new fields:

```typescript
    // Compute run dirs and archive stats from file listing
    const runDirMap = new Map<string, { fileCount: number; sizeBytes: number }>();
    for (const f of (parsed.files || [])) {
      const match = (f.path as string).match(/^(run_[^/]+)\//);
      if (match) {
        const rd = match[1];
        const existing = runDirMap.get(rd) || { fileCount: 0, sizeBytes: 0 };
        existing.fileCount++;
        existing.sizeBytes += f.size || 0;
        runDirMap.set(rd, existing);
      }
    }
    const runDirs = Array.from(runDirMap.entries()).map(([name, stats]) => ({ name, ...stats }));

    // Count archives
    const archiveFiles = (parsed.files || []).filter((f: { path: string }) => (f.path as string).startsWith(".archive/"));
    const archiveCount = archiveFiles.filter((f: { path: string }) => (f.path as string).endsWith(".tar.gz")).length;
    const archiveTotalBytes = archiveFiles.reduce((sum: number, f: { size: number }) => sum + (f.size || 0), 0);

    const workspaceHealth = (parsed.file_count > 500 || runDirs.length > 10) ? "needs_attention" as const : "clean" as const;
```

Include these in the `WorkspaceState` construction:

```typescript
    const state: WorkspaceState = {
      files: parsed.files || [],
      fileCount: parsed.file_count || 0,
      results: parsed.results || [],
      packages: parsed.packages || [],
      jobStatus: parsed.job_status || null,
      jobExitCode: parsed.job_exit_code ?? null,
      oomDetected: parsed.oom_detected || false,
      runDirs,
      archiveCount,
      archiveTotalBytes,
      workspaceHealth,
      cachedAt: Date.now(),
    };
```

- [ ] **Step 3: Update formatWorkspace to show health**

Add health info at the end of `formatWorkspace`:

```typescript
  if (state.runDirs.length > 0) {
    parts.push(`\n**Run Dirs (${state.runDirs.length}):**`);
    for (const rd of state.runDirs.slice(0, 10)) {
      parts.push(`- ${rd.name} (${rd.fileCount} files, ${formatSize(rd.sizeBytes)})`);
    }
  }

  if (state.archiveCount > 0) {
    parts.push(`\n**Archives:** ${state.archiveCount} archived runs (${formatSize(state.archiveTotalBytes)} total)`);
  }

  if (state.workspaceHealth === "needs_attention") {
    parts.push(`\n**⚠ Workspace needs attention** — ${state.fileCount} files, ${state.runDirs.length} unarchived runs. Consider calling \`clean_workspace\`.`);
  }
```

- [ ] **Step 4: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 5: Commit**

```bash
git add src/lib/research/workspace.ts
git commit -m "Workspace: add run dirs, archive stats, and health reporting"
```

---

### Task 9: Agent — `clean_workspace` tool

**Files:**
- Modify: `src/lib/research/agent.ts` (add tool near existing workspace tools)

- [ ] **Step 1: Add clean_workspace tool**

Find the `get_workspace` tool definition (around line 3139) and add the `clean_workspace` tool after it. Use the same patterns as existing tools (tool(), z.object, emit, invokeHelper):

```typescript
    clean_workspace: tool({
      description: "Clean up the remote experiment workspace. Archives old experiment run directories into compressed tarballs, removes orphaned output files from root (pre-migration leftovers), and trims old archives beyond the host's max. Use when get_workspace shows 'needs_attention' or when sync is slow. Supports --dry-run to preview without acting.",
      inputSchema: z.object({
        dry_run: z.boolean().optional().default(false).describe("Preview what would be cleaned without actually doing it"),
        keep_recent: z.number().optional().default(0).describe("Number of recent run dirs to keep unarchived"),
      }),
      execute: async ({ dry_run, keep_recent }: { dry_run?: boolean; keep_recent?: number }) => {
        // Find remote host — same pattern as get_workspace
        const hostWhere = { isDefault: true as const };
        let host = await prisma.remoteHost.findFirst({ where: hostWhere });
        if (!host) host = await prisma.remoteHost.findFirst();
        if (!host) return "No remote hosts configured.";

        emit({ type: "tool_progress", toolName: "clean_workspace", content: dry_run ? "Previewing workspace cleanup..." : "Cleaning workspace..." });

        try {
          const maxArchives = host.maxArchives || 20;
          const flags = [
            (keep_recent ?? 0) > 0 ? `--keep-recent ${keep_recent}` : "",
            `--max-archives ${maxArchives}`,
            dry_run ? "--dry-run" : "",
          ].filter(Boolean).join(" ");

          // Use the same glob pattern as workspace.ts to find the remote workdir
          const workDirGlob = `~/experiments/*${projectId.slice(0, 8)}*`;
          const { ok, output, error } = await quickRemoteCommand(host.id,
            `python3 ~/.arcana/helper.py prune ${workDirGlob} ${flags} 2>/dev/null || echo '{"ok":false}'`
          );

          if (!ok) return `Workspace cleanup failed: ${error || "unknown error"}`;

          const parsed = JSON.parse(output);
          if (!parsed.ok) return `Workspace cleanup failed: ${parsed.error || "helper returned error"}`;

          // Invalidate workspace cache after cleanup
          if (!dry_run) {
            invalidateWorkspace(projectId);
          }

          const prefix = dry_run ? "**Dry run** — would " : "";
          const parts: string[] = [];
          if (parsed.archivedRuns?.length > 0) {
            parts.push(`${prefix}archive ${parsed.archivedRuns.length} run dirs: ${parsed.archivedRuns.join(", ")}`);
          }
          if (parsed.deletedArchives?.length > 0) {
            parts.push(`${prefix}delete ${parsed.deletedArchives.length} old archives: ${parsed.deletedArchives.join(", ")}`);
          }
          if (parsed.orphansCleaned > 0) {
            parts.push(`${prefix}remove ${parsed.orphansCleaned} orphaned files from root`);
          }
          if (parts.length === 0) {
            return "Workspace is already clean — nothing to do.";
          }

          const saved = parsed.bytesFreed > 0 ? ` (${Math.round(parsed.bytesFreed / 1024 / 1024)}MB freed)` : "";
          return parts.join("\n") + (dry_run ? "" : saved);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return `Workspace cleanup failed: ${msg}`;
        }
      },
    }),
```

Note: This tool uses the same pattern as the existing `get_workspace` tool — finds the host via `prisma.remoteHost.findFirst()`, uses `quickRemoteCommand` to invoke the helper with a workdir glob, and uses `invalidateWorkspace` from `./workspace`. All of these are already imported in `agent.ts`. No new imports needed for this tool.

- [ ] **Step 2: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/research/agent.ts
git commit -m "Agent: add clean_workspace tool — prune via helper"
```

---

### Task 10: Settings UI — Cleanup policy per host

**Files:**
- Modify: `src/components/research/remote-hosts-manager.tsx`
- Modify: `src/app/api/research/hosts/route.ts` (or wherever host CRUD lives)

- [ ] **Step 1: Add cleanupPolicy and maxArchives to the RemoteHost interface**

In `remote-hosts-manager.tsx` (line ~25), add to the `RemoteHost` interface:

```typescript
  cleanupPolicy: string;
  maxArchives: number;
```

- [ ] **Step 2: Add cleanup section to host form**

Find where the host form fields are rendered (near envNotes, envVars, baseRequirements). Add a "Workspace Cleanup" section after the environment section. This should include a select dropdown for policy and a number input for max archives:

```tsx
{/* Workspace Cleanup */}
<div className="space-y-3 pt-3 border-t border-neutral-200">
  <h4 className="text-xs font-medium text-neutral-500 uppercase tracking-wide">Workspace Cleanup</h4>

  <div className="grid grid-cols-2 gap-3">
    <div>
      <label className="block text-xs text-neutral-500 mb-1">After experiment sync</label>
      <select
        className="w-full px-2 py-1.5 text-sm border border-neutral-200 rounded-md bg-white"
        value={pendingEdits[host.id]?.cleanupPolicy ?? host.cleanupPolicy ?? "archive"}
        onChange={(e) => setPendingEdit(host.id, "cleanupPolicy", e.target.value)}
      >
        <option value="archive">Archive (no checkpoints)</option>
        <option value="archive-with-checkpoints">Archive with checkpoints</option>
        <option value="delete">Delete after sync</option>
        <option value="none">Keep everything</option>
      </select>
    </div>

    <div>
      <label className="block text-xs text-neutral-500 mb-1">Max archives</label>
      <input
        type="number"
        min={1}
        max={100}
        className="w-full px-2 py-1.5 text-sm border border-neutral-200 rounded-md"
        value={pendingEdits[host.id]?.maxArchives ?? host.maxArchives ?? 20}
        onChange={(e) => setPendingEdit(host.id, "maxArchives", e.target.value)}
      />
    </div>
  </div>
</div>
```

- [ ] **Step 3: Include cleanupPolicy and maxArchives in save payload**

Find where the host save/update API call is made (the function that sends PUT/POST to the hosts API). Ensure `cleanupPolicy` and `maxArchives` are included in the request body, reading from `pendingEdits` with fallback to current host values.

- [ ] **Step 4: Update the API route to accept and save the new fields**

Find the hosts API route (likely `src/app/api/research/hosts/route.ts` or similar). In the PUT handler, add `cleanupPolicy` and `maxArchives` to the Prisma update:

```typescript
cleanupPolicy: body.cleanupPolicy || "archive",
maxArchives: parseInt(body.maxArchives, 10) || 20,
```

And in the GET handler, ensure these fields are returned in the response.

- [ ] **Step 5: Verify TypeScript compiles**

```bash
npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 6: Commit**

```bash
git add src/components/research/remote-hosts-manager.tsx src/app/api/research/hosts/route.ts
git commit -m "Settings: add workspace cleanup policy per remote host"
```

---

### Task 11: Helper manifest — Include .archive in listing

**Files:**
- Modify: `scripts/arcana_helper.py:827-884` (cmd_manifest)

- [ ] **Step 1: Update cmd_manifest to not exclude .archive**

Currently `cmd_manifest` (line 836) skips directories starting with `.`. We need to allow `.archive` through. Update the dir filter:

```python
        dirs[:] = [d for d in dirs if (not d.startswith('.') or d == '.archive') and d != '.venv' and d != '__pycache__' and d != '.arcana']
```

- [ ] **Step 2: Commit**

```bash
git add scripts/arcana_helper.py
git commit -m "Helper: include .archive/ in manifest listing for health reporting"
```

---

### Task 12: Integration verification

**Files:** None (verification only)

- [ ] **Step 1: Verify schema is clean**

```bash
npx prisma db push && npx tsc --noEmit 2>&1 | head -20
```

- [ ] **Step 2: Verify helper commands parse correctly**

```bash
python3 scripts/arcana_helper.py version
```
Expected: `{"ok": true, "version": "7"}`

```bash
python3 scripts/arcana_helper.py --help 2>&1 | head -5
```
Expected: Shows updated docstring with new commands.

- [ ] **Step 3: Spot-check run name derivation**

In a Node REPL or temporary test:
- `"python3 exp_055.py"` → `"run_055"`
- `"python3 baseline_bert.py --lr 0.001"` → `"run_baseline_bert"`
- `"python3 sweep_lr_001.py"` → `"run_sweep_lr_001"`

- [ ] **Step 4: Final commit if any fixes needed**

```bash
git add -A
git commit -m "Workspace lifecycle: integration fixes"
```
