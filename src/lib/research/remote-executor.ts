/**
 * Remote experiment executor — dispatches jobs to GPU machines via SSH/rsync.
 *
 * Designed with a backend interface so Ray can be swapped in later:
 *   - SSHExecutor: rsync + ssh (implemented now)
 *   - RayExecutor: ray job submit (future)
 */

import { exec } from "child_process";
import { promisify } from "util";
import { prisma } from "@/lib/prisma";

const execAsync = promisify(exec);

// ── Backend interface ─────────────────────────────────────────────

export interface ExecutorBackend {
  /** Sync local directory to remote, return the remote path */
  syncUp(localDir: string, host: HostConfig): Promise<string>;
  /** Start the experiment, return remote PID */
  run(remoteDir: string, command: string, host: HostConfig): Promise<number>;
  /** Check if job is still running */
  isAlive(pid: number, host: HostConfig): Promise<boolean>;
  /** Get tail of stdout/stderr */
  getLogs(remoteDir: string, host: HostConfig): Promise<{ stdout: string; stderr: string }>;
  /** Sync results back from remote to local */
  syncDown(remoteDir: string, localDir: string, host: HostConfig): Promise<void>;
  /** Kill a running job */
  kill(pid: number, host: HostConfig): Promise<void>;
}

export interface HostConfig {
  host: string;
  port: number;
  user: string;
  keyPath: string | null;
  workDir: string;
  conda: string | null;
  setupCmd: string | null;
}

// ── SSH executor ──────────────────────────────────────────────────

function sshArgs(host: HostConfig): string[] {
  const isConfigAlias = !host.user || host.user === "-";
  const args = ["-o", "ConnectTimeout=10"];
  // For SSH config aliases, don't override settings — let config handle it
  if (!isConfigAlias) {
    args.push("-o", "StrictHostKeyChecking=accept-new");
    if (host.keyPath) args.push("-i", host.keyPath);
    if (host.port !== 22) args.push("-p", String(host.port));
  }
  return args;
}

function sshTarget(host: HostConfig): string {
  // If user is "-" or empty, this is an SSH config alias — use host directly
  if (!host.user || host.user === "-") return host.host;
  return `${host.user}@${host.host}`;
}

async function sshExec(host: HostConfig, cmd: string): Promise<string> {
  const { execFile: execFileCb } = await import("child_process");

  // Use execFile with explicit args to avoid all shell quoting issues.
  // SSH takes the remote command as remaining args after the destination.
  const args = ["-T", ...sshArgs(host), sshTarget(host), "--", cmd];

  return new Promise((resolve, reject) => {
    execFileCb("ssh", args, { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = (stdout || "").trim();
      const errOut = (stderr || "").trim();

      if (err) {
        // If we got stdout despite error, return it (remote command ran but exited non-zero)
        if (out) {
          console.warn(`[remote-executor] sshExec non-zero exit but got stdout (${out.length} chars), stderr: ${errOut.slice(0, 200)}`);
          resolve(out);
          return;
        }
        // Genuine failure — include stderr in the error message
        const msg = errOut || err.message || "SSH command failed";
        reject(new Error(msg));
        return;
      }

      if (!out && errOut) {
        console.warn(`[remote-executor] sshExec empty stdout, stderr: ${errOut.slice(0, 300)}`);
      }
      resolve(out);
    });
  });
}

/**
 * Run a quick SSH command on a remote host — no rsync, no job record.
 * For lightweight operations: reading files, checking status, listing dirs.
 */
export async function quickRemoteCommand(hostId: string, command: string): Promise<{ ok: boolean; output: string; error?: string }> {
  const host = await prisma.remoteHost.findUnique({ where: { id: hostId } });
  if (!host) return { ok: false, output: "", error: "Host not found" };

  const config: HostConfig = {
    host: host.host, port: host.port, user: host.user,
    keyPath: host.keyPath, workDir: host.workDir,
    conda: null, setupCmd: null,
  };

  try {
    const output = await sshExec(config, command);
    return { ok: true, output };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, output: "", error: msg };
  }
}

export const sshExecutor: ExecutorBackend = {
  async syncUp(localDir: string, host: HostConfig): Promise<string> {
    // Ensure local dir ends with / for rsync behavior
    const src = localDir.endsWith("/") ? localDir : `${localDir}/`;
    const dirName = localDir.split("/").filter(Boolean).pop() || "experiment";
    const remoteDir = `${host.workDir}/${dirName}`;

    // Create remote dir
    await sshExec(host, `mkdir -p ${remoteDir}`);

    // Build rsync command carefully
    // The -e flag needs the full ssh command as a single string
    const sshCmd = `ssh ${sshArgs(host).join(" ")}`;
    const target = sshTarget(host);

    // Exclude NFS lock files (.nfs*), venvs (created on remote, not local), and use --ignore-errors to not fail on busy files
    const rsyncCmd = `rsync -azP --delete --exclude='.nfs*' --exclude='.venv' --exclude='__pycache__' --exclude='*.pyc' --exclude='stdout.log' --exclude='stderr.log' --exclude='.exit_code' --ignore-errors -e "${sshCmd}" "${src}" "${target}:${remoteDir}/"`;

    try {
      await execAsync(rsyncCmd, { timeout: 120_000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // If rsync not available locally, try scp fallback
      if (msg.includes("rsync: command not found") || msg.includes("rsync: not found")) {
        console.warn("[remote-executor] rsync not available, falling back to scp");
        await execAsync(
          `scp -r ${sshArgs(host).map(a => `"${a}"`).join(" ")} "${src}"* "${target}:${remoteDir}/"`,
          { timeout: 120_000 },
        );
      } else if (msg.includes("Device or resource busy") || msg.includes("code 23")) {
        // rsync partial transfer (code 23) — files were synced but some NFS locks couldn't be deleted.
        // This is fine, proceed.
        console.warn("[remote-executor] rsync had non-fatal errors (NFS locks), continuing");
      } else {
        throw err;
      }
    }

    return remoteDir;
  },

  async run(remoteDir: string, command: string, host: HostConfig): Promise<number> {
    // Write the command to a wrapper script on the remote to avoid all shell quoting issues.
    // This prevents f-strings, curly braces, nested quotes, etc. from breaking bash -c nesting.
    const scriptLines: string[] = [
      "#!/usr/bin/env bash",
      "set -e",
      `cd ${remoteDir}`,
      `[ -f .venv/bin/activate ] && source .venv/bin/activate || true`,
    ];
    if (host.conda) scriptLines.push(`conda activate ${host.conda} 2>/dev/null || source activate ${host.conda} 2>/dev/null || true`);
    if (host.setupCmd) scriptLines.push(host.setupCmd);
    scriptLines.push("set +e"); // Don't exit on command failure — capture exit code

    // Sanitize command — strip redundant cd/venv activation since the script
    // already handles those. This catches cases where the agent adds them anyway.
    let cleanCmd = command;
    cleanCmd = cleanCmd.replace(/^bash\s+-c\s+["'](.+?)["']\s*$/, "$1");
    cleanCmd = cleanCmd.replace(/\s*2>\/dev\/null\s*\|\|\s*true\s*/g, " ");
    cleanCmd = cleanCmd.replace(/(?:source\s+)?\.venv\/bin\/activate\s*(?:&&|;)\s*/g, "");
    cleanCmd = cleanCmd.replace(/source\s+activate\s*(?:&&|;)\s*/g, "");
    cleanCmd = cleanCmd.replace(/cd\s+\S+\s*(?:&&|;)\s*/g, "");
    cleanCmd = cleanCmd.replace(/(?:\/\S+)?\.venv\/bin\/python3?\s/g, "python3 ");
    cleanCmd = cleanCmd.replace(/(?:\/\S+)?\.venv\/bin\/pip3?\s/g, "pip3 ");
    cleanCmd = cleanCmd.replace(/\s+/g, " ").trim();

    scriptLines.push(cleanCmd);
    scriptLines.push("echo $? > .exit_code");

    const scriptContent = scriptLines.join("\n");
    // Use heredoc to write the script — avoids all quoting issues
    const writeScript = `cat > ${remoteDir}/.run.sh << 'ARCANA_EOF'\n${scriptContent}\nARCANA_EOF\nchmod +x ${remoteDir}/.run.sh`;
    await sshExec(host, writeScript);

    // Run the script in the background, capture stdout/stderr
    const launchCmd = `cd ${remoteDir} && nohup bash .run.sh > stdout.log 2> stderr.log & echo $!`;
    const pidStr = await sshExec(host, launchCmd);

    // Parse PID — grab just the last line (in case of MOTD or other output)
    const lines = pidStr.trim().split("\n");
    const lastLine = lines[lines.length - 1].trim();
    const pid = parseInt(lastLine, 10);

    if (isNaN(pid)) {
      throw new Error(`Failed to get PID from remote. Output: ${pidStr.slice(0, 200)}`);
    }

    return pid;
  },

  async isAlive(pid: number, host: HostConfig): Promise<boolean> {
    // Throws on SSH failure so callers can distinguish "dead" from "unreachable"
    const result = await sshExec(host, `kill -0 ${pid} 2>/dev/null && echo alive || echo dead`);
    return result.trim() === "alive";
  },

  async getLogs(remoteDir: string, host: HostConfig): Promise<{ stdout: string; stderr: string }> {
    try {
      const [stdout, stderr] = await Promise.all([
        sshExec(host, `tail -200 ${remoteDir}/stdout.log 2>/dev/null || echo ""`),
        sshExec(host, `tail -50 ${remoteDir}/stderr.log 2>/dev/null || echo ""`),
      ]);
      return { stdout, stderr };
    } catch {
      return { stdout: "", stderr: "" };
    }
  },

  async syncDown(remoteDir: string, localDir: string, host: HostConfig): Promise<void> {
    const sshCmd = `ssh ${sshArgs(host).join(" ")}`;
    const target = sshTarget(host);

    // Sync results/ directory back if it exists
    await execAsync(
      `rsync -azP -e "${sshCmd}" "${target}:${remoteDir}/results/" "${localDir}/results/"`,
      { timeout: 120_000 },
    ).catch(() => {
      // results/ may not exist, that's ok
    });

    // Sync result files from experiment root (results.json, *.csv, *.json outputs)
    // Use rsync with include/exclude to grab only output files, not code or venv
    await execAsync(
      `rsync -azP --include='*.json' --include='*.csv' --include='*.txt' --include='*.png' --include='*.log' --exclude='*/' --exclude='*.py' --exclude='requirements.txt' -e "${sshCmd}" "${target}:${remoteDir}/" "${localDir}/"`,
      { timeout: 120_000 },
    ).catch(() => {
      // Non-critical — some files may not exist
    });

    // Also grab log files explicitly (in case the rsync above missed them)
    for (const f of ["stdout.log", "stderr.log"]) {
      const scpArgs = sshArgs(host).map(a => `"${a}"`).join(" ");
      await execAsync(
        `scp ${scpArgs} "${target}:${remoteDir}/${f}" "${localDir}/${f}"`,
        { timeout: 30_000 },
      ).catch(() => {});
    }
  },

  async kill(pid: number, host: HostConfig): Promise<void> {
    // Kill the entire process group (negative PID) so child processes (python, etc.) also die
    await sshExec(host, `kill -- -${pid} 2>/dev/null; kill ${pid} 2>/dev/null; true`).catch(() => {});
  },
};

// ── Job dispatcher ────────────────────────────────────────────────

function getBackend(backendType: string): ExecutorBackend {
  switch (backendType) {
    case "ssh":
      return sshExecutor;
    // case "ray":
    //   return rayExecutor;
    default:
      return sshExecutor;
  }
}

/**
 * Submit a local experiment directory to a remote host.
 * Creates a RemoteJob, syncs files synchronously (so errors propagate),
 * then starts the experiment in the background.
 */
export async function submitRemoteJob(params: {
  hostId: string;
  localDir: string;
  command: string;
  stepId?: string;
  projectId?: string;
}): Promise<{ jobId: string }> {
  const host = await prisma.remoteHost.findUnique({ where: { id: params.hostId } });
  if (!host) throw new Error("Remote host not found");

  const config: HostConfig = {
    host: host.host,
    port: host.port,
    user: host.user,
    keyPath: host.keyPath,
    workDir: host.workDir,
    conda: host.conda,
    setupCmd: host.setupCmd,
  };

  const backend = getBackend(host.backend);

  // Create job record
  const job = await prisma.remoteJob.create({
    data: {
      hostId: host.id,
      stepId: params.stepId || null,
      projectId: params.projectId || null,
      localDir: params.localDir,
      remoteDir: "", // will be set after sync
      command: params.command,
      status: "SYNCING",
    },
  });

  // Sync files synchronously so errors propagate to caller
  let remoteDir: string;
  try {
    remoteDir = await backend.syncUp(params.localDir, config);
    await prisma.remoteJob.update({
      where: { id: job.id },
      data: { remoteDir, status: "RUNNING", startedAt: new Date() },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sync failed";
    await prisma.remoteJob.update({
      where: { id: job.id },
      data: { status: "FAILED", stderr: `Sync failed: ${message}`, completedAt: new Date() },
    });
    throw new Error(`File sync to ${host.alias} failed: ${message}`);
  }

  // Start the experiment + poll in the background
  runAndPoll(job.id, config, backend, remoteDir, params.command, params.localDir).catch((err) => {
    console.error(`[remote-executor] Job ${job.id} background error:`, err);
  });

  return { jobId: job.id };
}

async function runAndPoll(
  jobId: string,
  config: HostConfig,
  backend: ExecutorBackend,
  remoteDir: string,
  command: string,
  localDir?: string,
) {
  try {
    // 1. Start the command on the remote
    const pid = await backend.run(remoteDir, command, config);
    await prisma.remoteJob.update({
      where: { id: jobId },
      data: { remotePid: pid },
    });

    // 3. Poll until done (with SSH failure tolerance)
    let alive = true;
    let consecutiveSshFailures = 0;
    const MAX_SSH_FAILURES = 6; // ~60s of unreachability before giving up

    while (alive) {
      await new Promise((r) => setTimeout(r, 10_000)); // poll every 10s

      // Re-check job hasn't been cancelled
      const current = await prisma.remoteJob.findUnique({ where: { id: jobId } });
      if (!current || current.status === "CANCELLED") {
        await backend.kill(pid, config);
        return;
      }

      try {
        alive = await backend.isAlive(pid, config);
        consecutiveSshFailures = 0; // Reset on success
      } catch (sshErr) {
        consecutiveSshFailures++;
        console.warn(`[remote-executor] Job ${jobId}: isAlive SSH failure #${consecutiveSshFailures}: ${sshErr}`);
        if (consecutiveSshFailures >= MAX_SSH_FAILURES) {
          console.error(`[remote-executor] Job ${jobId}: ${MAX_SSH_FAILURES} consecutive SSH failures, marking as failed`);
          alive = false; // Exit loop, will be handled below
        }
        continue; // Skip log update this cycle
      }

      // Update logs (non-critical, don't let failures break the loop)
      try {
        const logs = await backend.getLogs(remoteDir, config);
        await prisma.remoteJob.update({
          where: { id: jobId },
          data: { stdout: logs.stdout, stderr: logs.stderr },
        });
      } catch (logErr) {
        console.warn(`[remote-executor] Job ${jobId}: getLogs failed:`, logErr);
      }
    }

    // 4. Get exit code
    let exitCode: number | null = null;
    try {
      const exitStr = await sshExec(config, `cat ${remoteDir}/.exit_code 2>/dev/null || echo -1`);
      exitCode = parseInt(exitStr, 10);
    } catch {
      // couldn't read exit code, check logs for errors
    }

    // 5. Sync results back — ALWAYS, even on failure (to recover partial results)
    if (localDir) {
      try {
        await backend.syncDown(remoteDir, localDir, config);
      } catch (syncErr) {
        console.warn(`[remote-executor] syncDown failed for job ${jobId}:`, syncErr);
        // Non-fatal — continue to update status
      }
    }

    // 6. Final status
    const finalLogs = await backend.getLogs(remoteDir, config);
    const failed = exitCode !== null && exitCode !== 0;

    await prisma.remoteJob.update({
      where: { id: jobId },
      data: {
        status: failed ? "FAILED" : "COMPLETED",
        exitCode,
        stdout: finalLogs.stdout,
        stderr: finalLogs.stderr,
        resultsSynced: true,
        completedAt: new Date(),
      },
    });

    // Update linked research step if any
    const job = await prisma.remoteJob.findUnique({ where: { id: jobId } });
    if (job?.stepId) {
      await prisma.researchStep.update({
        where: { id: job.stepId },
        data: {
          status: failed ? "FAILED" : "COMPLETED",
          completedAt: new Date(),
          output: JSON.stringify({
            remoteJobId: jobId,
            exitCode,
            resultsSynced: true,
            stdout: finalLogs.stdout.slice(-500),
          }),
        },
      });
    }

    if (job?.projectId) {
      await prisma.researchLogEntry.create({
        data: {
          projectId: job.projectId,
          type: failed ? "dead_end" : "observation",
          content: failed
            ? `Remote experiment failed (exit ${exitCode}) on ${config.host}:\n\`\`\`\n${(finalLogs.stderr || "").trim().split("\n").slice(-15).join("\n") || "No stderr captured"}\n\`\`\``
            : `Remote experiment completed on ${config.host}, results synced back`,
          metadata: JSON.stringify({ remoteJobId: jobId }),
        },
      });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : "Remote execution failed";
    console.error(`[remote-executor] Job ${jobId} failed:`, message);

    await prisma.remoteJob.update({
      where: { id: jobId },
      data: {
        status: "FAILED",
        stderr: message,
        completedAt: new Date(),
      },
    });

    const job = await prisma.remoteJob.findUnique({ where: { id: jobId } });
    if (job?.stepId) {
      await prisma.researchStep.update({
        where: { id: job.stepId },
        data: {
          status: "FAILED",
          completedAt: new Date(),
          output: JSON.stringify({ error: message }),
        },
      });
    }
  }
}

// ── Stale job cleanup ─────────────────────────────────────────────

/**
 * Detect and resolve jobs stuck in RUNNING/SYNCING/QUEUED state.
 *
 * This handles the case where `runAndPoll` background promise was lost
 * (server restart, event loop GC, unhandled rejection, SSH hang).
 *
 * Called on:
 *  - Research project page load (GET /api/research/[id])
 *  - Remote jobs list endpoint
 *  - Periodic cleanup if desired
 */
export async function cleanupStaleJobs(projectId?: string): Promise<number> {
  const MIN_AGE_MS = 5 * 60 * 1000; // Don't touch jobs younger than 5 minutes
  const now = new Date();

  const where: Record<string, unknown> = {
    status: { in: ["RUNNING", "SYNCING", "QUEUED"] },
  };
  if (projectId) where.projectId = projectId;

  const staleJobs = await prisma.remoteJob.findMany({
    where,
    include: { host: true },
  });

  let cleaned = 0;

  for (const job of staleJobs) {
    const startTime = job.startedAt || job.createdAt;
    const elapsed = now.getTime() - startTime.getTime();

    if (elapsed < MIN_AGE_MS) continue; // Too fresh, skip

    // Build SSH config if host is available
    const config: HostConfig | null = job.host ? {
      host: job.host.host, port: job.host.port, user: job.host.user,
      keyPath: job.host.keyPath, workDir: job.host.workDir,
      conda: job.host.conda, setupCmd: job.host.setupCmd,
    } : null;

    // Primary check: does .exit_code exist on remote? If so, process is done
    // regardless of what kill -0 says or how long it's been running.
    let exitCodeFromRemote: number | null = null;
    if (config && job.remoteDir) {
      try {
        const exitStr = await sshExec(config, `cat ${job.remoteDir}/.exit_code 2>/dev/null || echo __NONE__`);
        if (exitStr.trim() !== "__NONE__") {
          exitCodeFromRemote = parseInt(exitStr.trim(), 10);
          if (isNaN(exitCodeFromRemote)) exitCodeFromRemote = null;
        }
      } catch {
        // SSH failed — fall through to time-based checks
      }
    }

    // If no exit code file found, check if process is still alive
    if (exitCodeFromRemote === null) {
      if (config && job.remotePid) {
        try {
          const stillAlive = await sshExecutor.isAlive(job.remotePid, config);
          if (stillAlive) {
            // Genuinely still running — only kill if > 3 hours
            if (elapsed > 3 * 60 * 60 * 1000) {
              console.warn(`[remote-executor] Job ${job.id} running for >3h, killing`);
              await sshExecutor.kill(job.remotePid, config).catch(() => {});
            } else {
              continue; // Still alive, let it run
            }
          }
          // Process dead but no .exit_code — crashed or was killed externally
        } catch {
          // SSH unreachable — if > 45 min, clean up; otherwise skip
          if (elapsed < 45 * 60 * 1000) continue;
        }
      } else if (elapsed < 45 * 60 * 1000) {
        continue; // No way to check, use time-based threshold
      }
    }

    console.warn(`[remote-executor] Cleaning up job ${job.id} (${job.status} for ${Math.round(elapsed / 60000)}min, exit=${exitCodeFromRemote})`);

    // Fetch final logs from remote
    let finalStdout = job.stdout || "";
    let finalStderr = job.stderr || "";
    if (config && job.remoteDir) {
      try {
        const logs = await sshExecutor.getLogs(job.remoteDir, config);
        if (logs.stdout) finalStdout = logs.stdout;
        if (logs.stderr) finalStderr = logs.stderr;
      } catch {
        // Use whatever we have in DB
      }
    }

    // Determine status: exit code 0 or has substantial output → completed
    const failed = exitCodeFromRemote !== null ? exitCodeFromRemote !== 0
      : !finalStdout || finalStdout.trim().length === 0;
    const finalStatus = failed ? "FAILED" : "COMPLETED";

    await prisma.remoteJob.update({
      where: { id: job.id },
      data: {
        status: finalStatus,
        exitCode: exitCodeFromRemote,
        stdout: finalStdout || null,
        stderr: finalStderr || null,
        completedAt: now,
      },
    });

    // Sync results back if possible
    if (config && job.remoteDir && job.localDir) {
      try {
        await sshExecutor.syncDown(job.remoteDir, job.localDir, config);
      } catch {
        // Non-critical
      }
    }

    // Update linked research step
    if (job.stepId) {
      await prisma.researchStep.update({
        where: { id: job.stepId },
        data: {
          status: finalStatus,
          completedAt: now,
          output: JSON.stringify({
            remoteJobId: job.id,
            exitCode: exitCodeFromRemote,
            autoCleaned: true,
            stdout: (finalStdout || "").slice(-500),
          }),
        },
      }).catch(() => {});
    }

    cleaned++;
  }

  return cleaned;
}

// ── Utility ───────────────────────────────────────────────────────

/** Cancel a running remote job */
export async function cancelRemoteJob(jobId: string): Promise<void> {
  const job = await prisma.remoteJob.findUnique({
    where: { id: jobId },
    include: { host: true },
  });
  if (!job || !job.remotePid) return;

  const config: HostConfig = {
    host: job.host.host,
    port: job.host.port,
    user: job.host.user,
    keyPath: job.host.keyPath,
    workDir: job.host.workDir,
    conda: job.host.conda,
    setupCmd: job.host.setupCmd,
  };

  const backend = getBackend(job.host.backend);
  await backend.kill(job.remotePid, config);

  await prisma.remoteJob.update({
    where: { id: jobId },
    data: { status: "CANCELLED", completedAt: new Date() },
  });
}

export interface ConnectionTestResult {
  ok: boolean;
  error?: string;
  gpuInfo?: string;
  hostname?: string;
  user?: string;
}

/**
 * Test SSH connectivity to a host. Returns detailed result including GPU info.
 *
 * If the host has a blank user or host field, it's using SSH config alias —
 * SSH will resolve everything from ~/.ssh/config.
 */
/**
 * Probe GPUs on a remote host. Returns structured info for agent context.
 * Fast — runs a single SSH command. Returns null on failure (non-critical).
 */
export async function probeGpus(hostId: string): Promise<{
  alias: string;
  gpuCount: number;
  gpus: { index: number; name: string; memoryTotal: string; memoryFree: string }[];
  summary: string;
} | null> {
  const host = await prisma.remoteHost.findUnique({ where: { id: hostId } });
  if (!host) return null;

  try {
    const config: HostConfig = {
      host: host.host, port: host.port, user: host.user,
      keyPath: host.keyPath, workDir: host.workDir, conda: null, setupCmd: null,
    };

    const cmd = `nvidia-smi --query-gpu=index,name,memory.total,memory.free --format=csv,noheader,nounits 2>/dev/null || echo NO_GPU`;
    const output = await sshExec(config, cmd);

    if (!output || output.includes("NO_GPU")) {
      return { alias: host.alias, gpuCount: 0, gpus: [], summary: `${host.alias}: No GPUs detected` };
    }

    const gpus = output.split("\n").filter(Boolean).map((line) => {
      const [index, name, memTotal, memFree] = line.split(",").map((s) => s.trim());
      return {
        index: parseInt(index) || 0,
        name: name || "Unknown",
        memoryTotal: `${memTotal} MiB`,
        memoryFree: `${memFree} MiB`,
      };
    });

    const totalMem = gpus.reduce((sum, g) => sum + parseInt(g.memoryTotal), 0);
    const freeMem = gpus.reduce((sum, g) => sum + parseInt(g.memoryFree), 0);

    const summary = `${host.alias}: ${gpus.length}x ${gpus[0]?.name || "GPU"} (${Math.round(totalMem / 1024)} GB total, ${Math.round(freeMem / 1024)} GB free)`;

    return { alias: host.alias, gpuCount: gpus.length, gpus, summary };
  } catch (err) {
    console.error(`[remote-executor] GPU probe failed for ${host.alias}:`, err);
    return null;
  }
}

export async function testConnection(hostId: string): Promise<ConnectionTestResult> {
  const host = await prisma.remoteHost.findUnique({ where: { id: hostId } });
  if (!host) return { ok: false, error: "Host not found" };

  try {
    const { execFile: execFileCb } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFileCb);

    const isConfigAlias = !host.user || host.user === "-";
    const config: HostConfig = {
      host: host.host,
      port: host.port,
      user: host.user,
      keyPath: host.keyPath,
      workDir: host.workDir,
      conda: null,
      setupCmd: null,
    };

    const sshOpts = isConfigAlias
      ? ["-T", "-o", "ConnectTimeout=10", ...(host.keyPath ? ["-i", host.keyPath] : [])]
      : ["-T", ...sshArgs(config)];
    const target = isConfigAlias ? host.host : sshTarget(config);

    const remoteCmd = `echo __OK__ && whoami && hostname && nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null || echo no-gpu`;
    const { stdout } = await execFileAsync("ssh", [...sshOpts, target, "--", remoteCmd], { timeout: 30_000 });
    const lines = stdout.trim().split("\n");

    if (!lines[0]?.includes("__OK__")) {
      return { ok: false, error: `Unexpected output: ${stdout.slice(0, 200)}` };
    }

    const user = lines[1]?.trim() || undefined;
    const hostname = lines[2]?.trim() || undefined;
    const gpuLine = lines.slice(3).join("\n").trim();
    const gpuInfo = gpuLine === "no-gpu" ? undefined : gpuLine;

    console.log(`[remote-executor] Connection test to ${host.alias}: user=${user}, host=${hostname}, gpu=${gpuInfo || "none"}`);

    // Auto-update GPU type if we detected one and it's not set
    if (gpuInfo && !host.gpuType) {
      const gpuName = gpuInfo.split(",")[0]?.trim();
      if (gpuName) {
        await prisma.remoteHost.update({
          where: { id: hostId },
          data: { gpuType: gpuName },
        });
      }
    }

    return { ok: true, gpuInfo, hostname, user };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Connection failed";
    // Clean up the error message — strip the full command from exec errors
    const clean = msg.includes("Command failed:")
      ? msg.split("\n").slice(1).join("\n").trim() || msg
      : msg;
    return { ok: false, error: clean };
  }
}
