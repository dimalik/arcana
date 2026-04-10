#!/usr/bin/env python3
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
  check <workdir> <script.py>     Run pyright static analysis on a script
  version                        Print helper version
"""

import json
import os
import signal
import socket
import subprocess
import sys
import time
import hashlib
from pathlib import Path

HELPER_VERSION = "7"
ARCANA_DIR = ".arcana"
STATUS_FILE = "status.json"
REQS_HASH_FILE = "reqs_hash"
PIP_LOG_FILE = "pip_install.log"
MONITOR_PID_FILE = "monitor.pid"
SNAPSHOT_INTERVAL = 30  # seconds between resource snapshots
MAX_SNAPSHOTS = 120     # cap snapshot history


# ── Utilities ─────────────────────────────────────────────────────

def json_out(data):
    """Print JSON to stdout and exit."""
    print(json.dumps(data, default=str))
    sys.exit(0 if data.get("ok", True) else 1)


def json_err(msg):
    """Print error JSON and exit 1."""
    print(json.dumps({"ok": False, "error": str(msg)}))
    sys.exit(1)


def tail_file(path, lines=50):
    """Read last N lines from a file."""
    try:
        with open(path, "rb") as f:
            # Seek from end
            f.seek(0, 2)
            size = f.tell()
            if size == 0:
                return ""
            # Read last chunk — ML output often has long lines (JSON metrics, progress bars)
            chunk_size = min(size, lines * 1000)
            f.seek(max(0, size - chunk_size))
            data = f.read().decode("utf-8", errors="replace")
            result = "\n".join(data.split("\n")[-lines:])
            return result
    except (FileNotFoundError, PermissionError):
        return ""


def read_status(workdir):
    """Read status.json, return dict or None."""
    status_path = os.path.join(workdir, ARCANA_DIR, STATUS_FILE)
    try:
        with open(status_path) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def write_status(workdir, status):
    """Write status.json — atomic when possible, direct write as fallback for NFS."""
    arcana_dir = os.path.join(workdir, ARCANA_DIR)
    os.makedirs(arcana_dir, exist_ok=True)
    status_path = os.path.join(arcana_dir, STATUS_FILE)
    tmp_path = status_path + ".tmp"
    content = json.dumps(status, default=str)
    try:
        with open(tmp_path, "w") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.rename(tmp_path, status_path)
    except OSError:
        # NFS may not support atomic rename — write directly
        with open(status_path, "w") as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())


def file_hash(path):
    """MD5 hash of a file."""
    h = hashlib.md5()
    try:
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(8192), b""):
                h.update(chunk)
        return h.hexdigest()
    except FileNotFoundError:
        return None


def is_pid_alive(pid):
    """Check if a process is still running."""
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ProcessLookupError):
        return False


def get_cpu_ram():
    """Get CPU RAM info in GB. Returns (total, available)."""
    try:
        with open("/proc/meminfo") as f:
            info = {}
            for line in f:
                parts = line.split()
                if len(parts) >= 2:
                    info[parts[0].rstrip(":")] = int(parts[1])  # kB
            total = info.get("MemTotal", 0) / (1024 * 1024)
            avail = info.get("MemAvailable", info.get("MemFree", 0)) / (1024 * 1024)
            return round(total, 1), round(avail, 1)
    except Exception:
        return 0, 0


def get_gpu_info():
    """Get GPU memory info. Returns list of dicts."""
    try:
        out = subprocess.check_output(
            ["nvidia-smi", "--query-gpu=index,name,memory.used,memory.total",
             "--format=csv,noheader,nounits"],
            timeout=10, stderr=subprocess.DEVNULL, text=True,
        )
        gpus = []
        for line in out.strip().split("\n"):
            if not line.strip():
                continue
            parts = [p.strip() for p in line.split(",")]
            if len(parts) >= 4:
                gpus.append({
                    "idx": int(parts[0]),
                    "name": parts[1],
                    "used_mb": int(parts[2]),
                    "total_mb": int(parts[3]),
                })
        return gpus
    except Exception:
        return []


def take_snapshot():
    """Take a resource snapshot."""
    ram_total, ram_avail = get_cpu_ram()
    return {
        "time": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "cpu_ram_total_gb": ram_total,
        "cpu_ram_avail_gb": ram_avail,
        "gpu_mem": get_gpu_info(),
    }


def check_oom(pid):
    """Check if a process was OOM-killed. Best-effort."""
    # Check dmesg for OOM messages mentioning our PID
    try:
        out = subprocess.check_output(
            ["dmesg", "-T"], timeout=5, stderr=subprocess.DEVNULL, text=True,
        )
        for line in out.split("\n")[-200:]:  # last 200 lines
            lower = line.lower()
            if ("oom" in lower or "killed process" in lower or "out of memory" in lower):
                if str(pid) in line:
                    return True, line.strip()
        return False, ""
    except Exception:
        return False, ""


# ── Venv Management ───────────────────────────────────────────────

def setup_venv(workdir, log_callback=None):
    """
    Setup virtual environment and install requirements if needed.
    Returns (success, message).
    """
    reqs_path = os.path.join(workdir, "requirements.txt")
    if not os.path.exists(reqs_path):
        return True, "No requirements.txt found, skipping venv setup"

    arcana_dir = os.path.join(workdir, ARCANA_DIR)
    os.makedirs(arcana_dir, exist_ok=True)

    # Hash includes both project requirements and base requirements (if present)
    base_reqs_check_path = os.path.join(workdir, ARCANA_DIR, "base_requirements.txt")
    base_hash = file_hash(base_reqs_check_path) or ""
    current_hash = file_hash(reqs_path) + ":" + base_hash
    hash_path = os.path.join(arcana_dir, REQS_HASH_FILE)

    # Check if already installed with same hash
    try:
        with open(hash_path) as f:
            installed_hash = f.read().strip()
        if installed_hash == current_hash:
            return True, "Requirements unchanged, skipping install"
    except FileNotFoundError:
        pass

    venv_path = os.path.join(workdir, ".venv")

    # Detect and remove broken venvs (dir exists but bin/ is missing)
    if os.path.exists(venv_path) and not os.path.exists(os.path.join(venv_path, "bin")):
        if log_callback:
            log_callback("[env-setup] Removing broken venv (no bin/ directory)...")
        import shutil
        shutil.rmtree(venv_path, ignore_errors=True)

    # Create venv if missing
    if not os.path.exists(os.path.join(venv_path, "bin", "activate")):
        if log_callback:
            log_callback("[env-setup] Creating virtual environment...")
        try:
            subprocess.run(
                [sys.executable, "-m", "venv", venv_path],
                check=True, capture_output=True, text=True, timeout=120,
            )
        except subprocess.CalledProcessError as e:
            return False, f"venv creation failed: {e.stderr}"
        except subprocess.TimeoutExpired:
            return False, "venv creation timed out (>120s)"

    pip_path = os.path.join(venv_path, "bin", "pip3")
    if not os.path.exists(pip_path):
        pip_path = os.path.join(venv_path, "bin", "pip")
    if not os.path.exists(pip_path):
        # bin/ exists but pip is missing — broken state
        return False, f"pip not found at {pip_path}. Venv may be corrupt. Delete .venv/ and retry."

    # Upgrade pip
    try:
        subprocess.run(
            [pip_path, "install", "--upgrade", "pip", "-q"],
            capture_output=True, text=True, timeout=120,
        )
    except Exception:
        pass

    # Merge base requirements (from host config) with project requirements
    base_reqs_path = os.path.join(workdir, ARCANA_DIR, "base_requirements.txt")
    install_reqs_path = reqs_path  # default: use project requirements directly

    if os.path.exists(base_reqs_path):
        merged_reqs_path = os.path.join(workdir, ARCANA_DIR, "merged_requirements.txt")
        merged_lines = []
        base_packages = set()

        with open(base_reqs_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#'):
                    merged_lines.append(line)
                    pkg_name = line.split('==')[0].split('>=')[0].split('<=')[0].split('<')[0].split('>')[0].split('[')[0].strip().lower()
                    base_packages.add(pkg_name)

        with open(reqs_path) as f:
            for line in f:
                line = line.strip()
                if line and not line.startswith('#'):
                    pkg_name = line.split('==')[0].split('>=')[0].split('<=')[0].split('<')[0].split('>')[0].split('[')[0].strip().lower()
                    if pkg_name not in base_packages:
                        merged_lines.append(line)
                    elif log_callback:
                        log_callback(f"[env-setup] Skipping {line} — already in base requirements")

        with open(merged_reqs_path, 'w') as f:
            f.write('\n'.join(merged_lines) + '\n')

        install_reqs_path = merged_reqs_path
        if log_callback:
            log_callback(f"[env-setup] Merged {len(base_packages)} base + {len(merged_lines) - len(base_packages)} project packages")

    # Install requirements
    if log_callback:
        log_callback("[env-setup] Installing requirements...")
    pip_log_path = os.path.join(arcana_dir, PIP_LOG_FILE)
    try:
        result = subprocess.run(
            [pip_path, "install", "-r", install_reqs_path],
            capture_output=True, text=True, timeout=1800,
        )
        # Save full log
        with open(pip_log_path, "w") as f:
            f.write(result.stdout)
            if result.stderr:
                f.write("\n--- stderr ---\n")
                f.write(result.stderr)

        if result.returncode != 0:
            last_lines = result.stdout.split("\n")[-30:]
            return False, (
                f"pip install failed (exit {result.returncode}).\n"
                f"Last 30 lines:\n" + "\n".join(last_lines)
            )
    except subprocess.TimeoutExpired:
        return False, "pip install timed out (>30 min). Large packages like torch may need more time."

    # Save hash
    with open(hash_path, "w") as f:
        f.write(current_hash)

    return True, "Requirements installed successfully"


def get_venv_python(workdir):
    """Get path to venv python, or system python."""
    venv_py = os.path.join(workdir, ".venv", "bin", "python3")
    if os.path.exists(venv_py):
        return venv_py
    venv_py2 = os.path.join(workdir, ".venv", "bin", "python")
    if os.path.exists(venv_py2):
        return venv_py2
    return "python3"


# ── Commands ──────────────────────────────────────────────────────

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


def cmd_monitor(workdir, pid, pgid):
    """
    Internal monitor daemon. Waits for experiment to finish,
    updates status.json with exit code and OOM detection.
    Takes periodic resource snapshots.
    """
    workdir = os.path.abspath(workdir)
    pid = int(pid)
    pgid = int(pgid)

    # Detach from terminal
    try:
        os.setsid()
    except Exception:
        pass

    while True:
        # Check if process is alive
        if not is_pid_alive(pid):
            break

        try:
            # Take snapshot and update status
            status = read_status(workdir) or {}
            snapshots = status.get("resource_snapshots", [])
            snapshots.append(take_snapshot())
            if len(snapshots) > MAX_SNAPSHOTS:
                snapshots = snapshots[-MAX_SNAPSHOTS:]

            status["resource_snapshots"] = snapshots
            # Read log paths — from run dir if set, else workdir root
            run_name = status.get("run_name")
            log_base = os.path.join(workdir, run_name) if run_name else workdir
            status["stdout_tail"] = tail_file(os.path.join(log_base, "stdout.log"), 50)
            status["stderr_tail"] = tail_file(os.path.join(log_base, "stderr.log"), 20)
            write_status(workdir, status)
        except Exception as e:
            # Don't let snapshot/IO errors crash the monitor — keep watching the process
            try:
                sys.stderr.write(f"[arcana-monitor] snapshot error: {e}\n")
            except Exception:
                pass

        time.sleep(SNAPSHOT_INTERVAL)

    # Process exited — wait for the shell wrapper to write the exit_code file.
    # On NFS or under heavy I/O, this can take several seconds.
    time.sleep(5)

    exit_code = None
    try:
        _, wait_status = os.waitpid(pid, os.WNOHANG)
        if os.WIFEXITED(wait_status):
            exit_code = os.WEXITSTATUS(wait_status)
        elif os.WIFSIGNALED(wait_status):
            exit_code = 128 + os.WTERMSIG(wait_status)
    except ChildProcessError:
        # Not our child (experiment is a sibling process, not a child).
        # Read exit code from the file the experiment wrapper writes.
        for candidate in [
            os.path.join(workdir, ARCANA_DIR, "exit_code"),
            os.path.join(workdir, ".exit_code"),  # legacy fallback
        ]:
            try:
                with open(candidate) as f:
                    exit_code = int(f.read().strip())
                break
            except Exception:
                continue
        else:
            exit_code = -1

    # OOM detection — both kernel OOM (SIGKILL, exit 137) and CUDA OOM (exit 1 + stderr)
    oom_detected = False
    oom_detail = ""
    stderr_content = ""
    if exit_code == 137:  # 128 + 9 (SIGKILL) — kernel OOM
        oom_detected = True
        oom_detail = "Process received SIGKILL (exit 137) — likely OOM killed"
        dmesg_oom, dmesg_line = check_oom(pid)
        if dmesg_oom:
            oom_detail += f"\ndmesg: {dmesg_line}"
    elif exit_code is not None and exit_code != 0:
        # Check stderr for CUDA/GPU OOM
        stderr_content = tail_file(os.path.join(workdir, "stderr.log"), 100)
        cuda_oom_markers = ["CUDA out of memory", "OutOfMemoryError", "torch.cuda.OutOfMemoryError"]
        for marker in cuda_oom_markers:
            if marker in stderr_content:
                oom_detected = True
                oom_detail = f"GPU OOM detected: {marker} found in stderr"
                break

    # Determine final status
    if oom_detected:
        final_status = "oom_killed"
    elif exit_code is not None and exit_code != 0:
        final_status = "failed"
    else:
        final_status = "completed"

    # Final snapshot and status update
    status = read_status(workdir) or {}
    snapshots = status.get("resource_snapshots", [])
    snapshots.append(take_snapshot())

    # Structured failure diagnosis
    diagnosis = ""
    if final_status != "completed":
        if oom_detected:
            last_snap = snapshots[-1] if snapshots else {}
            gpu_mem = last_snap.get("gpu_mem", [])
            gpu_usage = ", ".join(f"GPU{g['idx']}: {g['used_mb']}MB/{g['total_mb']}MB" for g in gpu_mem) if gpu_mem else "unknown"
            diagnosis = f"OOM KILL — Process killed by kernel. GPU memory at crash: {gpu_usage}. "
            diagnosis += "Suggestions: (1) Use 4-bit quantization (bitsandbytes), (2) Use a smaller model, (3) Reduce batch size, (4) Use gradient checkpointing."
        elif exit_code == 1 and stderr_content:
            if "ModuleNotFoundError" in stderr_content or "ImportError" in stderr_content:
                module = ""
                for line in stderr_content.split("\n"):
                    if "ModuleNotFoundError" in line or "ImportError" in line:
                        module = line.strip()
                        break
                diagnosis = f"IMPORT ERROR — {module}. Add the missing package to requirements.txt and re-run."
            elif "CUDA" in stderr_content or "CUBLAS" in stderr_content:
                diagnosis = "CUDA ERROR — GPU operation failed. Check: (1) bf16 not supported on this GPU? Use fp16. (2) CUDA version mismatch? Check host profile. (3) GPU memory fragmentation? Restart and try again."
            elif "RuntimeError" in stderr_content:
                diagnosis = "RUNTIME ERROR — Check the traceback above. This is likely a code bug, not an infrastructure issue."
            else:
                diagnosis = "SCRIPT ERROR — Non-zero exit code. Check stderr for details."
        elif exit_code == 137:
            diagnosis = "SIGKILL — Process was killed externally (likely OOM killer or resource limit)."

    run_name = status.get("run_name")
    log_base = os.path.join(workdir, run_name) if run_name else workdir
    status.update({
        "status": final_status,
        "exit_code": exit_code,
        "completed_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "oom_detected": oom_detected,
        "oom_detail": oom_detail,
        "diagnosis": diagnosis,
        "resource_snapshots": snapshots[-MAX_SNAPSHOTS:],
        "stdout_tail": tail_file(os.path.join(log_base, "stdout.log"), 100),
        "stderr_tail": tail_file(os.path.join(log_base, "stderr.log"), 50),
    })
    write_status(workdir, status)


def cmd_status(workdir):
    """Get structured status."""
    workdir = os.path.abspath(workdir)
    status = read_status(workdir)

    if not status:
        # Legacy fallback: check for .exit_code file
        exit_code_path = os.path.join(workdir, ".exit_code")
        if os.path.exists(exit_code_path):
            try:
                with open(exit_code_path) as f:
                    code = int(f.read().strip())
                status = {
                    "status": "completed" if code == 0 else ("oom_killed" if code == 137 else "failed"),
                    "exit_code": code,
                    "oom_detected": code == 137,
                    "stdout_tail": tail_file(os.path.join(workdir, "stdout.log"), 100),
                    "stderr_tail": tail_file(os.path.join(workdir, "stderr.log"), 50),
                }
            except Exception:
                pass

        if not status:
            json_out({"ok": True, "status": "unknown", "error": "No status file found"})
            return

    # If status says running, verify the process is actually alive
    if status.get("status") == "running":
        pid = status.get("pid")
        if pid and not is_pid_alive(pid):
            # Process died but monitor didn't update — fix it now
            exit_code = None
            for candidate in [
                os.path.join(workdir, ARCANA_DIR, "exit_code"),
                os.path.join(workdir, ".exit_code"),  # legacy fallback
            ]:
                try:
                    with open(candidate) as f:
                        exit_code = int(f.read().strip())
                    break
                except Exception:
                    continue
            else:
                exit_code = -1

            oom_detected = exit_code == 137
            oom_detail = ""
            if oom_detected:
                oom_detail = "SIGKILL (exit 137) — likely OOM killed"
                _, dmesg_line = check_oom(pid)
                if dmesg_line:
                    oom_detail += f"\ndmesg: {dmesg_line}"

            final = "oom_killed" if oom_detected else ("failed" if exit_code != 0 else "completed")
            status.update({
                "status": final,
                "exit_code": exit_code,
                "completed_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "oom_detected": oom_detected,
                "oom_detail": oom_detail,
            })
            write_status(workdir, status)

    # Always refresh log tails
    run_name = status.get("run_name") if status else None
    log_base = os.path.join(workdir, run_name) if run_name else workdir
    status["stdout_tail"] = tail_file(os.path.join(log_base, "stdout.log"), 100)
    status["stderr_tail"] = tail_file(os.path.join(log_base, "stderr.log"), 50)
    status["ok"] = True

    json_out(status)


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


def cmd_kill(workdir):
    """Kill experiment process group."""
    workdir = os.path.abspath(workdir)
    status = read_status(workdir)

    if not status:
        json_err("No status file — nothing to kill")

    pid = status.get("pid")
    pgid = status.get("pgid")

    if not pid:
        json_err("No PID in status file")

    if not is_pid_alive(pid):
        status["status"] = "cancelled"
        status["completed_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        write_status(workdir, status)
        json_out({"ok": True, "message": "Process already dead"})
        return

    # Try SIGTERM on process group first
    try:
        if pgid:
            os.killpg(pgid, signal.SIGTERM)
        else:
            os.kill(pid, signal.SIGTERM)
    except Exception:
        pass

    # Wait up to 5 seconds for graceful exit
    for _ in range(50):
        if not is_pid_alive(pid):
            break
        time.sleep(0.1)

    # Force kill if still alive
    if is_pid_alive(pid):
        try:
            if pgid:
                os.killpg(pgid, signal.SIGKILL)
            else:
                os.kill(pid, signal.SIGKILL)
        except Exception:
            pass

    status["status"] = "cancelled"
    status["completed_at"] = time.strftime("%Y-%m-%dT%H:%M:%S")
    write_status(workdir, status)

    # Also kill monitor if running
    monitor_pid_path = os.path.join(workdir, ARCANA_DIR, MONITOR_PID_FILE)
    try:
        with open(monitor_pid_path) as f:
            mpid = int(f.read().strip())
        os.kill(mpid, signal.SIGTERM)
    except Exception:
        pass

    json_out({"ok": True, "message": f"Killed PID {pid}"})


def cmd_setup_env(workdir):
    """Setup venv + install requirements only."""
    workdir = os.path.abspath(workdir)
    if not os.path.isdir(workdir):
        json_err(f"Workdir does not exist: {workdir}")

    messages = []
    success, msg = setup_venv(workdir, log_callback=lambda m: messages.append(m))
    messages.append(msg)

    json_out({
        "ok": success,
        "message": msg,
        "log": "\n".join(messages),
    })


def cmd_info():
    """Return host info."""
    ram_total, ram_avail = get_cpu_ram()
    gpus = get_gpu_info()

    # Disk space
    disk_total = disk_free = 0
    try:
        import shutil
        usage = shutil.disk_usage(os.path.expanduser("~"))
        disk_total = round(usage.total / (1024**3), 1)
        disk_free = round(usage.free / (1024**3), 1)
    except Exception:
        pass

    json_out({
        "ok": True,
        "hostname": socket.gethostname(),
        "cpu_ram_total_gb": ram_total,
        "cpu_ram_avail_gb": ram_avail,
        "gpu_count": len(gpus),
        "gpus": gpus,
        "disk_total_gb": disk_total,
        "disk_free_gb": disk_free,
    })


def cmd_manifest(workdir):
    """Return structured workspace manifest: files, sizes, recent results."""
    workdir = os.path.abspath(workdir)
    if not os.path.isdir(workdir):
        json_err(f"Workdir does not exist: {workdir}")

    files = []
    results = []
    for root, dirs, filenames in os.walk(workdir):
        dirs[:] = [d for d in dirs if (not d.startswith('.') or d == '.archive') and d != '.venv' and d != '__pycache__' and d != '.arcana']
        rel_root = os.path.relpath(root, workdir)
        for fname in filenames:
            fpath = os.path.join(root, fname)
            rel_path = os.path.join(rel_root, fname) if rel_root != '.' else fname
            try:
                st = os.stat(fpath)
                entry = {
                    "path": rel_path,
                    "size": st.st_size,
                    "modified": time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(st.st_mtime)),
                }
                files.append(entry)
                if fname.endswith('.json') and ('result' in fname.lower() or 'metric' in fname.lower()):
                    try:
                        with open(fpath) as f:
                            content = f.read(5000)
                        results.append({"path": rel_path, "content": content})
                    except Exception:
                        pass
            except Exception:
                pass

    packages = []
    pip_path = os.path.join(workdir, ".venv", "bin", "pip3")
    if not os.path.exists(pip_path):
        pip_path = os.path.join(workdir, ".venv", "bin", "pip")
    if os.path.exists(pip_path):
        try:
            out = subprocess.check_output(
                [pip_path, "list", "--format=freeze"],
                timeout=15, stderr=subprocess.DEVNULL, text=True,
            )
            packages = [line.strip() for line in out.strip().split("\n") if line.strip()]
        except Exception:
            pass

    status = read_status(workdir) or {}

    json_out({
        "ok": True,
        "files": sorted(files, key=lambda f: f["modified"], reverse=True),
        "file_count": len(files),
        "results": results[:10],
        "packages": packages,
        "job_status": status.get("status"),
        "job_exit_code": status.get("exit_code"),
        "oom_detected": status.get("oom_detected", False),
    })


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
    for root, _dirs, files in os.walk(run_dir):
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


def cmd_prune(workdir, keep_recent=0, max_archives=20, dry_run=False):
    """Bulk workspace cleanup: archive stale runs, trim old archives, remove orphans."""
    import shutil
    import tarfile
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

    archive_dir = os.path.join(workdir, ".archive")

    for rd in archivable:
        if rd == running_run_name:
            continue
        run_path = os.path.join(workdir, rd)
        existing_archive = os.path.join(archive_dir, f"{rd}.tar.gz")
        if os.path.exists(existing_archive):
            continue

        if dry_run:
            result["archivedRuns"].append(rd)
        else:
            try:
                os.makedirs(archive_dir, exist_ok=True)

                dir_size = 0
                file_count = 0
                for root, _dirs, files in os.walk(run_path):
                    for f in files:
                        try:
                            dir_size += os.path.getsize(os.path.join(root, f))
                            file_count += 1
                        except OSError:
                            pass

                archive_path = os.path.join(archive_dir, f"{rd}.tar.gz")
                with tarfile.open(archive_path, "w:gz") as tar:
                    tar.add(run_path, arcname=rd)

                archive_size = os.path.getsize(archive_path)
                shutil.rmtree(run_path, ignore_errors=True)

                # Update manifest
                manifest_path = os.path.join(archive_dir, "manifest.json")
                manifest = []
                try:
                    with open(manifest_path) as mf:
                        manifest = json.load(mf)
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
                with open(manifest_path, "w") as mf:
                    json.dump(manifest, mf, indent=2)

                result["archivedRuns"].append(rd)
                result["bytesFreed"] += dir_size - archive_size
            except Exception as e:
                sys.stderr.write(f"[prune] Failed to archive {rd}: {e}\n")

    # 2. Trim old archives beyond max_archives
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
                    with open(manifest_path) as mf:
                        manifest = json.load(mf)
                    deleted_names = set(result["deletedArchives"])
                    manifest = [e for e in manifest if e.get("name") not in deleted_names]
                    with open(manifest_path, "w") as mf:
                        json.dump(manifest, mf, indent=2)
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
                        dir_sz = sum(
                            os.path.getsize(os.path.join(r, f_))
                            for r, _, fs in os.walk(fpath)
                            for f_ in fs
                        )
                        shutil.rmtree(fpath, ignore_errors=True)
                        result["orphansCleaned"] += 1
                        result["bytesFreed"] += dir_sz
                    except Exception:
                        pass

    # 4. Remove broken .venv dirs
    venv_path = os.path.join(workdir, ".venv")
    if os.path.isdir(venv_path) and not os.path.exists(os.path.join(venv_path, "bin")):
        if not dry_run:
            import shutil as shutil2
            shutil2.rmtree(venv_path, ignore_errors=True)

    result["ok"] = True
    result["dryRun"] = dry_run
    json_out(result)


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


PYRIGHT_MARKER = "pyright_installed"
PYRIGHT_INSTALL_TIMEOUT = 120  # 2 min for initial install
PYRIGHT_RUN_TIMEOUT = 90       # 90s — first run indexes the entire venv


def ensure_pyright(workdir):
    """Ensure pyright is pip-installed in the venv. Returns (python_path, ok, reason)."""
    venv_py = get_venv_python(workdir)
    conda_env = os.environ.get("ARCANA_CONDA", "")

    if conda_env.strip():
        # Derive pip from conda python path
        conda_bin = os.path.dirname(conda_env)
        pip_path = os.path.join(conda_bin, "pip3")
        if not os.path.exists(pip_path):
            pip_path = os.path.join(conda_bin, "pip")
    else:
        pip_path = os.path.join(workdir, ".venv", "bin", "pip3")
        if not os.path.exists(pip_path):
            pip_path = os.path.join(workdir, ".venv", "bin", "pip")

    # Check marker file
    marker_path = os.path.join(workdir, ARCANA_DIR, PYRIGHT_MARKER)
    if os.path.exists(marker_path):
        return (venv_py, True, "cached")

    # Try importing pyright
    try:
        result = subprocess.run(
            [venv_py, "-c", "import pyright; print('ok')"],
            capture_output=True, text=True, timeout=15,
        )
        if result.returncode == 0 and "ok" in result.stdout:
            os.makedirs(os.path.join(workdir, ARCANA_DIR), exist_ok=True)
            with open(marker_path, "w") as f:
                f.write("1")
            return (venv_py, True, "already installed")
    except Exception:
        pass

    # Try installing pyright
    try:
        result = subprocess.run(
            [pip_path, "install", "pyright", "-q"],
            capture_output=True, text=True, timeout=PYRIGHT_INSTALL_TIMEOUT,
        )
        if result.returncode == 0:
            os.makedirs(os.path.join(workdir, ARCANA_DIR), exist_ok=True)
            with open(marker_path, "w") as f:
                f.write("1")
            return (venv_py, True, "installed")
        else:
            return (venv_py, False, f"pip install pyright failed: {result.stderr[:500]}")
    except subprocess.TimeoutExpired:
        return (venv_py, False, "pip install pyright timed out")
    except Exception as e:
        return (venv_py, False, f"pip install pyright error: {e}")


def cmd_check(workdir, script_name):
    """Run pyright static analysis on a script."""
    workdir = os.path.abspath(workdir)
    if not os.path.isdir(workdir):
        json_err(f"Workdir does not exist: {workdir}")

    script_path = os.path.join(workdir, script_name)
    if not os.path.isfile(script_path):
        json_err(f"Script not found: {script_path}")

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

    # Run pyright
    try:
        result = subprocess.run(
            [venv_py, "-m", "pyright", "--outputjson", "--level", "basic",
             "--pythonpath", venv_py, script_path],
            capture_output=True, text=True, timeout=PYRIGHT_RUN_TIMEOUT,
            cwd=workdir,
        )
        # pyright returns non-zero on errors — that's expected, parse stdout anyway
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

    # Parse JSON output
    try:
        data = json.loads(result.stdout)
    except (json.JSONDecodeError, ValueError):
        json_out({
            "ok": True,
            "errors": [],
            "errorCount": 0,
            "warningCount": 0,
            "unavailable": True,
            "reason": f"Failed to parse pyright output: {result.stdout[:500]}",
        })

    diagnostics = data.get("generalDiagnostics", [])
    errors = []
    error_count = 0
    warning_count = 0

    for diag in diagnostics:
        severity = diag.get("severity", "")
        if severity not in ("error", "warning"):
            continue

        if severity == "error":
            error_count += 1
        else:
            warning_count += 1

        rng = diag.get("range", {})
        start = rng.get("start", {})
        end = rng.get("end", {})

        errors.append({
            "file": diag.get("file", script_name),
            "severity": severity,
            "message": diag.get("message", ""),
            "rule": diag.get("rule", ""),
            "line": start.get("line", 0) + 1,       # 0-indexed to 1-indexed
            "column": start.get("character", 0) + 1,
            "endLine": end.get("line", 0) + 1,
            "endColumn": end.get("character", 0) + 1,
        })

    pyright_version = data.get("version", "")

    json_out({
        "ok": True,
        "errors": errors,
        "errorCount": error_count,
        "warningCount": warning_count,
        "pyrightVersion": pyright_version,
    })


def cmd_version():
    """Print version."""
    json_out({"ok": True, "version": HELPER_VERSION})


# ── Main ──────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(1)

    cmd = sys.argv[1]

    try:
        if cmd == "version":
            cmd_version()
        elif cmd == "info":
            cmd_info()
        elif cmd == "run":
            # Parse: run <workdir> [--run <name>] -- <command...>
            args = sys.argv[2:]
            run_name = None
            # Extract --run <name> if present
            if "--run" in args:
                ri = args.index("--run")
                if ri + 1 < len(args):
                    run_name = args[ri + 1]
                    args = args[:ri] + args[ri + 2:]
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
        elif cmd == "status":
            if len(sys.argv) < 3:
                json_err("Usage: status <workdir>")
            cmd_status(sys.argv[2])
        elif cmd == "logs":
            if len(sys.argv) < 3:
                json_err("Usage: logs <workdir> [--lines N]")
            lines = 200
            stderr_lines = 50
            for i, arg in enumerate(sys.argv):
                if arg == "--lines" and i + 1 < len(sys.argv):
                    lines = int(sys.argv[i + 1])
                if arg == "--stderr-lines" and i + 1 < len(sys.argv):
                    stderr_lines = int(sys.argv[i + 1])
            cmd_logs(sys.argv[2], lines, stderr_lines)
        elif cmd == "kill":
            if len(sys.argv) < 3:
                json_err("Usage: kill <workdir>")
            cmd_kill(sys.argv[2])
        elif cmd == "setup-env":
            if len(sys.argv) < 3:
                json_err("Usage: setup-env <workdir>")
            cmd_setup_env(sys.argv[2])
        elif cmd == "manifest":
            if len(sys.argv) < 3:
                json_err("Usage: manifest <workdir>")
            cmd_manifest(sys.argv[2])
        elif cmd == "archive":
            if len(sys.argv) < 4:
                json_err("Usage: archive <workdir> <run_name> [--include-checkpoints]")
            include_ckpt = "--include-checkpoints" in sys.argv
            cmd_archive(sys.argv[2], sys.argv[3], include_checkpoints=include_ckpt)
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
        elif cmd == "restore":
            if len(sys.argv) < 4:
                json_err("Usage: restore <workdir> <run_name>")
            cmd_restore(sys.argv[2], sys.argv[3])
        elif cmd == "check":
            if len(sys.argv) < 4:
                json_err("Usage: check <workdir> <script.py>")
            cmd_check(sys.argv[2], sys.argv[3])
        elif cmd == "_monitor":
            # Internal: _monitor <workdir> <pid> <pgid>
            if len(sys.argv) < 5:
                sys.exit(1)
            cmd_monitor(sys.argv[2], sys.argv[3], sys.argv[4])
        else:
            json_err(f"Unknown command: {cmd}")
    except Exception as e:
        json_err(str(e))


if __name__ == "__main__":
    main()
