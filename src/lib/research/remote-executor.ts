/**
 * Remote experiment executor — dispatches jobs to GPU machines via SSH/rsync.
 *
 * Designed with a backend interface so Ray can be swapped in later:
 *   - SSHExecutor: rsync + ssh (implemented now)
 *   - RayExecutor: ray job submit (future)
 */

import { exec } from "child_process";
import { promisify } from "util";
import path from "path";
import { prisma } from "@/lib/prisma";

const execAsync = promisify(exec);

// ── Helper management ────────────────────────────────────────────

const HELPER_VERSION = "3";
const helperInstalledHosts = new Map<string, boolean>();

/**
 * Ensure the Arcana helper is installed on a remote host.
 * Checks version, rsyncs if missing or outdated. Cached per host per process.
 */
async function ensureHelper(host: HostConfig): Promise<void> {
  const hostKey = `${host.user}@${host.host}:${host.port}`;
  if (helperInstalledHosts.get(hostKey)) return;

  try {
    const result = await sshExec(host, "python3 ~/.arcana/helper.py version 2>/dev/null || echo '{}'");
    const parsed = JSON.parse(result);
    if (parsed.version === HELPER_VERSION) {
      helperInstalledHosts.set(hostKey, true);
      return;
    }
  } catch {
    // Not installed or parse error — install it
  }

  // Rsync the helper
  const helperPath = path.join(process.cwd(), "scripts", "arcana_helper.py");
  const sshCmd = `ssh ${sshArgs(host).join(" ")}`;
  const target = sshTarget(host);

  await sshExec(host, "mkdir -p ~/.arcana");
  await execAsync(
    `rsync -az -e "${sshCmd}" "${helperPath}" "${target}:~/.arcana/helper.py"`,
    { timeout: 30_000 },
  );
  await sshExec(host, "chmod +x ~/.arcana/helper.py");
  helperInstalledHosts.set(hostKey, true);
}

/** Parse JSON response from the helper, throwing on errors. */
function parseHelperResponse<T>(raw: string): T {
  // Helper may output to stderr (warnings) — grab the last JSON line
  const lines = raw.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith("{")) {
      const parsed = JSON.parse(line);
      if (parsed.ok === false) {
        throw new Error(parsed.error || "Helper command failed");
      }
      return parsed as T;
    }
  }
  throw new Error(`No JSON in helper response: ${raw.slice(0, 200)}`);
}

/** Invoke the helper on a remote host. */
async function invokeHelper(host: HostConfig, args: string): Promise<string> {
  await ensureHelper(host);
  const envParts: string[] = [];
  if (host.conda) envParts.push(`ARCANA_CONDA='${host.conda}'`);
  if (host.setupCmd) envParts.push(`ARCANA_SETUP='${host.setupCmd}'`);
  const envPrefix = envParts.length > 0 ? envParts.join(" ") + " " : "";
  return sshExec(host, `${envPrefix}python3 ~/.arcana/helper.py ${args}`);
}

/** Status returned by the helper's status command. */
export interface HelperStatus {
  ok: boolean;
  pid?: number;
  pgid?: number;
  status: "running" | "completed" | "failed" | "oom_killed" | "setup" | "unknown";
  exit_code: number | null;
  started_at?: string;
  completed_at?: string | null;
  oom_detected: boolean;
  oom_detail?: string;
  resource_snapshots?: Array<{
    time: string;
    cpu_ram_total_gb: number;
    cpu_ram_avail_gb: number;
    gpu_mem: Array<{ idx: number; used_mb: number; total_mb: number }>;
  }>;
  stdout_tail: string;
  stderr_tail: string;
  error?: string;
}

/** Get structured status from the helper. */
export async function getHelperStatus(host: HostConfig, remoteDir: string): Promise<HelperStatus> {
  const raw = await invokeHelper(host, `status ${remoteDir}`);
  return parseHelperResponse<HelperStatus>(raw);
}

/** Kill via the helper. */
export async function killViaHelper(host: HostConfig, remoteDir: string): Promise<void> {
  await invokeHelper(host, `kill ${remoteDir}`);
}

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
  const args = ["-o", "ConnectTimeout=30"];
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
    execFileCb("ssh", args, { timeout: 300_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
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
    const rsyncCmd = `rsync -azP --delete --exclude='.nfs*' --exclude='.venv' --exclude='__pycache__' --exclude='*.pyc' --exclude='stdout.log' --exclude='stderr.log' --exclude='.exit_code' --exclude='.arcana' --ignore-errors -e "${sshCmd}" "${src}" "${target}:${remoteDir}/"`;

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
      } else if (msg.includes("Device or resource busy") || msg.includes("code 23") || msg.includes("code 24") || msg.includes("some files vanished")) {
        // rsync code 23 (partial transfer, NFS locks) and code 24 (files vanished during transfer, e.g. .pyc files)
        // are non-fatal — the important files synced fine.
        console.warn("[remote-executor] rsync had non-fatal errors, continuing");
      } else {
        throw err;
      }
    }

    return remoteDir;
  },

  async run(remoteDir: string, command: string, host: HostConfig): Promise<number> {
    // Command is already sanitized by agent.ts — don't double-sanitize.
    // Just trim whitespace.
    const cleanCmd = command.replace(/\s+/g, " ").trim();

    // Shell-escape the command for safe transport through SSH → remote shell → helper.
    // Single-quote the entire command, escaping internal single quotes.
    const escaped = cleanCmd.replace(/'/g, "'\\''");
    const raw = await invokeHelper(host, `run ${remoteDir} -- '${escaped}'`);
    const result = parseHelperResponse<{ ok: boolean; pid: number; pgid: number }>(raw);
    return result.pid;
  },

  async isAlive(pid: number, host: HostConfig): Promise<boolean> {
    const result = await sshExec(host, `kill -0 ${pid} 2>/dev/null && echo alive || echo dead`);
    return result.trim() === "alive";
  },

  async getLogs(remoteDir: string, host: HostConfig): Promise<{ stdout: string; stderr: string }> {
    // Try helper first (single SSH call with structured output)
    try {
      const raw = await invokeHelper(host, `logs ${remoteDir}`);
      const parsed = parseHelperResponse<{ stdout: string; stderr: string }>(raw);
      return { stdout: parsed.stdout || "", stderr: parsed.stderr || "" };
    } catch {
      // Fallback to raw tail if helper not available
      try {
        const [stdout, stderr] = await Promise.all([
          sshExec(host, `tail -200 ${remoteDir}/stdout.log 2>/dev/null || echo ""`),
          sshExec(host, `tail -50 ${remoteDir}/stderr.log 2>/dev/null || echo ""`),
        ]);
        return { stdout, stderr };
      } catch {
        return { stdout: "", stderr: "" };
      }
    }
  },

  async syncDown(remoteDir: string, localDir: string, host: HostConfig): Promise<void> {
    const sshCmd = `ssh ${sshArgs(host).join(" ")}`;
    const target = sshTarget(host);
    const SYNC_TIMEOUT = 600_000; // 10 min — large model outputs can take a while

    // Sync results/ directory back if it exists
    await execAsync(
      `rsync -azP -e "${sshCmd}" "${target}:${remoteDir}/results/" "${localDir}/results/"`,
      { timeout: SYNC_TIMEOUT },
    ).catch(() => {
      // results/ may not exist, that's ok
    });

    // Sync result files from experiment root (results.json, *.csv, *.json outputs)
    // Use rsync with include/exclude to grab only output files, not code or venv
    await execAsync(
      `rsync -azP --include='*.json' --include='*.csv' --include='*.txt' --include='*.png' --include='*.log' --exclude='*/' --exclude='*.py' --exclude='requirements.txt' -e "${sshCmd}" "${target}:${remoteDir}/" "${localDir}/"`,
      { timeout: SYNC_TIMEOUT },
    ).catch(() => {
      // Non-critical — some files may not exist
    });

    // Also grab log files explicitly (in case the rsync above missed them)
    for (const f of ["stdout.log", "stderr.log"]) {
      const scpArgs = sshArgs(host).map(a => `"${a}"`).join(" ");
      await execAsync(
        `scp ${scpArgs} "${target}:${remoteDir}/${f}" "${localDir}/${f}"`,
        { timeout: 60_000 },
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
    // 1. Start the command on the remote (via helper — handles venv, supervision, OOM detection)
    const pid = await backend.run(remoteDir, command, config);
    await prisma.remoteJob.update({
      where: { id: jobId },
      data: { remotePid: pid },
    });

    // 2. Poll via helper status — single SSH call per cycle replaces isAlive + getLogs + exit_code
    let done = false;
    let consecutiveSshFailures = 0;
    const MAX_SSH_FAILURES = 18; // ~9 min of unreachability before giving up (heavy GPU load can slow SSH)
    let finalStatus: HelperStatus | null = null;

    while (!done) {
      await new Promise((r) => setTimeout(r, 10_000)); // poll every 10s

      // Re-check job hasn't been cancelled
      const current = await prisma.remoteJob.findUnique({ where: { id: jobId } });
      if (!current || current.status === "CANCELLED") {
        try { await killViaHelper(config, remoteDir); } catch { /* best effort */ }
        return;
      }

      try {
        const status = await getHelperStatus(config, remoteDir);
        consecutiveSshFailures = 0;

        // Update logs from helper response
        await prisma.remoteJob.update({
          where: { id: jobId },
          data: { stdout: status.stdout_tail, stderr: status.stderr_tail },
        });

        if (status.status !== "running" && status.status !== "setup") {
          done = true;
          finalStatus = status;
        }
      } catch (err) {
        consecutiveSshFailures++;
        console.warn(`[remote-executor] Job ${jobId}: helper status SSH failure #${consecutiveSshFailures}: ${err}`);
        if (consecutiveSshFailures >= MAX_SSH_FAILURES) {
          console.error(`[remote-executor] Job ${jobId}: ${MAX_SSH_FAILURES} consecutive SSH failures, marking as failed`);
          done = true;
        }
      }
    }

    // 3. Extract exit code and OOM info from helper status
    let exitCode: number | null = finalStatus?.exit_code ?? null;
    const oomDetected = finalStatus?.oom_detected ?? false;
    const oomDetail = finalStatus?.oom_detail ?? "";

    // If helper wasn't reachable (SSH failures), try one last time to get status
    if (!finalStatus) {
      try {
        // Try the helper first (may work now after transient failures)
        const status = await getHelperStatus(config, remoteDir);
        exitCode = status.exit_code ?? null;
        if (status.stdout_tail) finalStatus = status;
      } catch {
        // Fallback: read status.json directly
        try {
          const exitStr = await sshExec(config, `cat ${remoteDir}/.arcana/status.json 2>/dev/null || echo '{}'`);
          const parsed = JSON.parse(exitStr);
          exitCode = parsed.exit_code ?? null;
        } catch { /* use null */ }
      }
    }

    // 4. Sync results back — ALWAYS, even on failure (to recover partial results)
    if (localDir) {
      try {
        await backend.syncDown(remoteDir, localDir, config);
      } catch (syncErr) {
        console.warn(`[remote-executor] syncDown failed for job ${jobId}:`, syncErr);
      }
    }

    // 5. Final logs (use helper status if available, otherwise fetch)
    let finalStdout = finalStatus?.stdout_tail ?? "";
    let finalStderr = finalStatus?.stderr_tail ?? "";
    if (!finalStatus) {
      try {
        const logs = await backend.getLogs(remoteDir, config);
        finalStdout = logs.stdout;
        finalStderr = logs.stderr;
      } catch { /* use empty */ }
    }

    // Append OOM detail to stderr so it's visible in all downstream consumers
    if (oomDetected && oomDetail) {
      finalStderr = `${finalStderr}\n\n[OOM DETECTED] ${oomDetail}`.trim();
    }

    const failed = oomDetected || (exitCode !== null && exitCode !== 0);
    // If we couldn't determine exit code at all (SSH failures, no status file),
    // don't guess — mark as FAILED so the user knows to check manually.
    const indeterminate = exitCode === null && !finalStatus;
    const finalJobStatus = failed || indeterminate ? "FAILED" : "COMPLETED";

    await prisma.remoteJob.update({
      where: { id: jobId },
      data: {
        status: finalJobStatus,
        exitCode,
        stdout: finalStdout,
        stderr: indeterminate
          ? `${finalStderr}\n\n[INDETERMINATE] Could not determine job outcome — SSH was unreachable. Check the remote host manually.`.trim()
          : finalStderr,
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
          status: finalJobStatus,
          completedAt: new Date(),
          output: JSON.stringify({
            remoteJobId: jobId,
            exitCode,
            resultsSynced: true,
            stdout: finalStdout.slice(-500),
          }),
        },
      });
    }

    if (job?.projectId) {
      // Extract script name from command for readable log entries
      const scriptMatch = job.command.match(/python3?\s+(\S+\.py)/);
      const scriptName = scriptMatch ? scriptMatch[1] : job.command.slice(0, 60);

      let failureDetail = "";
      if (failed || indeterminate) {
        // Prefer stderr for the error, but fall back to stdout tail if stderr is empty
        const stderrLines = (finalStderr || "").trim().split("\n").filter(Boolean);
        const stdoutLines = (finalStdout || "").trim().split("\n").filter(Boolean);

        if (stderrLines.length > 0) {
          // Find the actual error — often the last Traceback + error line
          const traceIdx = stderrLines.findLastIndex((l: string) => l.includes("Traceback"));
          const errorLines = traceIdx >= 0 ? stderrLines.slice(traceIdx).slice(-10) : stderrLines.slice(-10);
          failureDetail = errorLines.join("\n");
        } else if (stdoutLines.length > 0) {
          // Check stdout for Python errors (common when using 2>&1)
          const traceIdx = stdoutLines.findLastIndex((l: string) => l.includes("Traceback") || l.includes("Error:"));
          const errorLines = traceIdx >= 0 ? stdoutLines.slice(traceIdx).slice(-10) : stdoutLines.slice(-5);
          failureDetail = errorLines.join("\n");
        }
      }

      await prisma.researchLogEntry.create({
        data: {
          projectId: job.projectId,
          type: (failed || indeterminate) ? "dead_end" : "observation",
          content: indeterminate
            ? `\`${scriptName}\` outcome unknown on ${config.host} — SSH unreachable. Check manually.`
            : failed
              ? `\`${scriptName}\` failed (exit ${exitCode}) on ${config.host}${failureDetail ? `:\n\`\`\`\n${failureDetail}\n\`\`\`` : " — no error output captured"}`
              : `\`${scriptName}\` completed on ${config.host}, results synced back`,
          metadata: JSON.stringify({ remoteJobId: jobId }),
        },
      });

      // Invalidate workspace cache after job completes
      import("./workspace").then(({ invalidateWorkspace }) => {
        if (job.projectId) invalidateWorkspace(job.projectId);
      }).catch(() => {});
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

    // Log the failure so it's visible in the research timeline
    if (job?.projectId) {
      const scriptMatch = command.match(/python3?\s+(\S+\.py)/);
      const scriptName = scriptMatch ? scriptMatch[1] : command.slice(0, 60);
      await prisma.researchLogEntry.create({
        data: {
          projectId: job.projectId,
          type: "dead_end",
          content: `\`${scriptName}\` failed to start on ${config.host}: ${message}`,
          metadata: JSON.stringify({ remoteJobId: jobId }),
        },
      }).catch(() => {}); // Best effort — don't let log failure mask the real error
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

    // Primary check: use helper status (single SSH call for everything)
    let helperResult: HelperStatus | null = null;
    let exitCodeFromRemote: number | null = null;
    if (config && job.remoteDir) {
      try {
        helperResult = await getHelperStatus(config, job.remoteDir);
        exitCodeFromRemote = helperResult.exit_code;

        if (helperResult.status === "running" || helperResult.status === "setup") {
          // Genuinely still running — only kill if > 72 hours (multi-GPU training can be long)
          if (elapsed > 72 * 60 * 60 * 1000) {
            console.warn(`[remote-executor] Job ${job.id} running for >72h, killing`);
            await killViaHelper(config, job.remoteDir).catch(() => {});
          } else {
            continue; // Still alive, let it run
          }
        }
      } catch {
        // Helper/SSH failed — fall back to time-based check
        if (elapsed < 3 * 60 * 60 * 1000) continue;
      }
    } else if (elapsed < 3 * 60 * 60 * 1000) {
      continue; // No way to check, use time-based threshold
    }

    console.warn(`[remote-executor] Cleaning up job ${job.id} (${job.status} for ${Math.round(elapsed / 60000)}min, exit=${exitCodeFromRemote}, oom=${helperResult?.oom_detected})`);

    // Use helper's structured output for logs
    const finalStdout = helperResult?.stdout_tail || job.stdout || "";
    let finalStderr = helperResult?.stderr_tail || job.stderr || "";

    // Append OOM info if detected
    if (helperResult?.oom_detected && helperResult.oom_detail) {
      finalStderr = `${finalStderr}\n\n[OOM DETECTED] ${helperResult.oom_detail}`.trim();
    }

    // Determine status — use exit code when available, don't guess from stdout emptiness
    const oomKill = helperResult?.oom_detected ?? false;
    const failed = oomKill || (exitCodeFromRemote !== null && exitCodeFromRemote !== 0);
    // If we have an exit code, trust it. If not, mark as FAILED (indeterminate) rather than
    // guessing COMPLETED from stdout presence.
    const indeterminate = exitCodeFromRemote === null && !helperResult;
    const finalStatus = (failed || indeterminate) ? "FAILED" : "COMPLETED";

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
            oomDetected: oomKill,
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
  if (!job) return;

  const config: HostConfig = {
    host: job.host.host,
    port: job.host.port,
    user: job.host.user,
    keyPath: job.host.keyPath,
    workDir: job.host.workDir,
    conda: job.host.conda,
    setupCmd: job.host.setupCmd,
  };

  // Use helper for clean process group kill; fall back to raw kill
  if (job.remoteDir) {
    try {
      await killViaHelper(config, job.remoteDir);
    } catch {
      if (job.remotePid) {
        const backend = getBackend(job.host.backend);
        await backend.kill(job.remotePid, config);
      }
    }
  } else if (job.remotePid) {
    const backend = getBackend(job.host.backend);
    await backend.kill(job.remotePid, config);
  }

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
export interface HostProfile {
  alias: string;
  gpuCount: number;
  gpus: { index: number; name: string; memoryTotal: string; memoryFree: string }[];
  cpuRamGb: number;
  cudaVersion: string | null;
  pythonVersion: string | null;
  diskFreeGb: number | null;
  installedPackages: string[]; // key packages detected (torch, transformers, flash-attn, etc.)
  os: string | null;
  summary: string;
}

export async function probeGpus(hostId: string): Promise<HostProfile | null> {
  const host = await prisma.remoteHost.findUnique({ where: { id: hostId } });
  if (!host) return null;

  try {
    const config: HostConfig = {
      host: host.host, port: host.port, user: host.user,
      keyPath: host.keyPath, workDir: host.workDir, conda: null, setupCmd: null,
    };

    // Run all probes in parallel for speed
    const [gpuOutput, memOutput, envOutput] = await Promise.all([
      sshExec(config, `nvidia-smi --query-gpu=index,name,memory.total,memory.free --format=csv,noheader,nounits 2>/dev/null || echo NO_GPU`),
      sshExec(config, `free -g 2>/dev/null | awk '/^Mem:/{print $2}'`).catch(() => ""),
      sshExec(config, [
        `echo "CUDA:$(nvcc --version 2>/dev/null | grep -oP 'release \\K[0-9.]+' || nvidia-smi 2>/dev/null | grep -oP 'CUDA Version: \\K[0-9.]+')"`,
        `echo "PYTHON:$(python3 --version 2>/dev/null | awk '{print $2}')"`,
        `echo "DISK:$(df -BG ${host.workDir} 2>/dev/null | awk 'NR==2{print $4}' | tr -d 'G')"`,
        `echo "OS:$(cat /etc/os-release 2>/dev/null | grep PRETTY_NAME | cut -d'"' -f2 || uname -s)"`,
        // Check for key pre-installed packages (fast — just check if importable)
        `python3 -c "
pkgs = []
for p in ['torch','transformers','accelerate','deepspeed','flash_attn','bitsandbytes','datasets','scipy','numpy','pandas','sklearn']:
    try:
        m = __import__(p)
        v = getattr(m, '__version__', '?')
        pkgs.append(f'{p}=={v}')
    except: pass
print('PKGS:' + ','.join(pkgs))
" 2>/dev/null || echo "PKGS:"`,
      ].join(" && ")).catch(() => ""),
    ]);

    const cpuRamGb = parseInt(memOutput.trim()) || 0;

    // Parse environment info
    const envLines = envOutput.split("\n");
    const getVal = (prefix: string) => {
      const line = envLines.find((l) => l.startsWith(prefix));
      return line ? line.slice(prefix.length).trim() || null : null;
    };
    const cudaVersion = getVal("CUDA:");
    const pythonVersion = getVal("PYTHON:");
    const diskFreeGb = parseInt(getVal("DISK:") || "") || null;
    const os = getVal("OS:");
    const installedPackages = (getVal("PKGS:") || "").split(",").filter(Boolean);

    // Parse GPU info
    if (!gpuOutput || gpuOutput.includes("NO_GPU")) {
      return {
        alias: host.alias, gpuCount: 0, gpus: [], cpuRamGb,
        cudaVersion, pythonVersion, diskFreeGb, installedPackages, os,
        summary: `${host.alias}: No GPUs detected${cpuRamGb ? `, ${cpuRamGb} GB CPU RAM` : ""}`,
      };
    }

    const gpus = gpuOutput.split("\n").filter(Boolean).map((line) => {
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

    const ramNote = cpuRamGb > 0 ? `, ${cpuRamGb} GB CPU RAM` : "";
    const summary = `${host.alias}: ${gpus.length}x ${gpus[0]?.name || "GPU"} (${Math.round(totalMem / 1024)} GB total, ${Math.round(freeMem / 1024)} GB free${ramNote})`;

    return {
      alias: host.alias, gpuCount: gpus.length, gpus, cpuRamGb,
      cudaVersion, pythonVersion, diskFreeGb, installedPackages, os,
      summary,
    };
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
