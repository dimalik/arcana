# Remote Execution

Arcana can run experiments on remote GPU servers via SSH. The research agent writes code locally, syncs it to a remote host, executes it, and syncs results back — all automatically.

## Setup

### 1. Configure SSH access

Ensure you can SSH into your GPU server without a password prompt. Either:

- Add your public key to `~/.ssh/authorized_keys` on the remote
- Use an SSH config alias in `~/.ssh/config`:

```
Host lab-gpu
  HostName 192.168.1.100
  User researcher
  IdentityFile ~/.ssh/id_ed25519
```

### 2. Add remote host in Arcana

Go to **Settings > Agent** and add a remote host:

| Field | Description | Example |
|-------|-------------|---------|
| Alias | Friendly name | `lab-a100` |
| Host | Hostname, IP, or SSH config alias | `lab-gpu` or `192.168.1.100` |
| Port | SSH port | `22` |
| User | SSH username (use `-` for SSH config aliases) | `researcher` or `-` |
| Key path | Path to SSH private key (optional if using agent/config) | `~/.ssh/id_ed25519` |
| Work directory | Remote base directory for experiments | `~/experiments` |
| GPU type | GPU model (auto-detected on first connection test) | `A100` |
| Conda env | Conda environment to activate (optional) | `research` |
| Setup command | Extra setup commands (optional) | `module load cuda/12.1` |

Click **Test Connection** to verify. Arcana will SSH in, check connectivity, and probe GPUs.

### 3. Mark a default host

Toggle the default flag on your preferred host. The agent will use it unless instructed otherwise.

## How it works

### File sync

Arcana uses `rsync` to sync the experiment directory to the remote host. It excludes `.venv`, `__pycache__`, log files, and NFS lock files. If `rsync` isn't available, it falls back to `scp`.

The sync is bidirectional:
- **Up**: local experiment dir → remote (before execution)
- **Down**: remote results → local (after completion)

Result sync grabs `*.json`, `*.csv`, `*.txt`, `*.png`, `*.log` files and the `results/` directory.

### Python environment management

The remote executor automatically manages Python environments. When a job runs:

1. If `requirements.txt` exists and no `.venv` directory exists → creates a venv
2. Activates the venv
3. Computes an MD5 hash of `requirements.txt`
4. If the hash differs from the last install → runs `pip install -r requirements.txt`
5. Stores the hash in `.venv/.reqs_hash` for next time
6. On subsequent runs with unchanged requirements → skips installation entirely

The agent does **not** need to include venv creation or pip install in its commands. Just `python3 experiment.py` is enough.

### Job lifecycle

```
submitRemoteJob()
  1. Create RemoteJob record (status: SYNCING)
  2. rsync local dir → remote
  3. Write .run.sh wrapper script on remote
  4. Start .run.sh in background (nohup)
  5. Return job ID immediately (status: RUNNING)

runAndPoll() [background]
  6. Poll every 10s: is process alive?
  7. Update stdout/stderr in DB
  8. On completion: read exit code, sync results back
  9. Update status to COMPLETED or FAILED
  10. Create research log entry
```

The `.run.sh` wrapper handles:
- Python venv creation and activation
- Requirements installation with change detection
- Conda environment activation (if configured)
- Custom setup commands (if configured)
- Command sanitization (strips redundant venv/pip commands the agent might add)
- Exit code capture

### Non-blocking execution

`execute_remote` returns immediately after submitting the job. The agent continues working while the experiment runs. It can:

- Search papers, read results, or write code for the next experiment
- Submit additional experiments in parallel
- Use `check_job` to poll a specific job's status
- Use `wait_for_jobs` to block until multiple jobs complete

### Stale job cleanup

If the server restarts or a background poll is lost, jobs can get stuck in RUNNING state. `cleanupStaleJobs()` handles this:

- Runs on project page load
- Checks remote for `.exit_code` file (definitive completion signal)
- Falls back to `kill -0` PID check
- Jobs running >3 hours are killed
- Unreachable jobs >45 minutes are marked failed
- Results are synced back even for failed jobs

### Experiment sweeps

`run_experiment_sweep` submits multiple variants of an experiment across different hosts:

```
Variants: [{ name: "lr_0.001", args: "--lr 0.001" }, { name: "lr_0.01", args: "--lr 0.01" }]
Hosts: [lab-a100, lambda-h100]

→ variant 1 submitted to lab-a100
→ variant 2 submitted to lambda-h100
→ All job IDs returned, agent monitors with check_job
```

## Troubleshooting

### Connection test fails
- Verify SSH access manually: `ssh user@host`
- Check firewall rules and SSH port
- For SSH config aliases, set user to `-` in Arcana

### Jobs stuck in SYNCING
- Check `rsync` is installed locally and on the remote
- Verify the work directory exists on the remote
- Check SSH key permissions (should be 600)

### Jobs fail immediately
- Check stderr in the job details
- Common causes: missing Python 3, CUDA not available, disk full
- The setup command field can load modules or set env vars

### Requirements installation fails
- Check `requirements.txt` for typos or unavailable packages
- Some packages need system libraries (e.g., `libffi-dev` for cffi)
- Use the setup command to install system dependencies first

### Results not syncing back
- Ensure experiments write output to files (not just stdout)
- Results directory and `*.json`/`*.csv` files are synced automatically
- Check that the remote host allows rsync back to your machine
