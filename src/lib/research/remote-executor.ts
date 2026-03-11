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
    execFileCb("ssh", args, { timeout: 60_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
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
    // Build the full command with optional conda activation and setup
    // Use bash -l for login shell so PATH includes common tools (python3, pip, etc.)
    const parts: string[] = [];
    parts.push(`cd ${remoteDir}`);
    // Auto-activate venv if it exists (agent creates .venv on first run)
    parts.push(`[ -f .venv/bin/activate ] && source .venv/bin/activate || true`);
    if (host.conda) parts.push(`conda activate ${host.conda} 2>/dev/null || source activate ${host.conda} 2>/dev/null || true`);
    if (host.setupCmd) parts.push(host.setupCmd);
    // Escape single quotes in command for safe nesting
    const escapedCmd = command.replace(/'/g, "'\\''");
    // Run command, capture exit code to a file, background it, emit PID
    parts.push(`nohup bash -c '${escapedCmd}; echo $? > .exit_code' > stdout.log 2> stderr.log & echo $!`);

    const fullCmd = parts.join(" && ");
    // Use -t to force pseudo-terminal allocation for better PATH resolution
    const pidStr = await sshExec(host, fullCmd);

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
    try {
      const result = await sshExec(host, `kill -0 ${pid} 2>/dev/null && echo alive || echo dead`);
      return result === "alive";
    } catch {
      return false;
    }
  },

  async getLogs(remoteDir: string, host: HostConfig): Promise<{ stdout: string; stderr: string }> {
    try {
      const [stdout, stderr] = await Promise.all([
        sshExec(host, `tail -50 ${remoteDir}/stdout.log 2>/dev/null || echo ""`),
        sshExec(host, `tail -20 ${remoteDir}/stderr.log 2>/dev/null || echo ""`),
      ]);
      return { stdout, stderr };
    } catch {
      return { stdout: "", stderr: "" };
    }
  },

  async syncDown(remoteDir: string, localDir: string, host: HostConfig): Promise<void> {
    const sshCmd = `ssh ${sshArgs(host).join(" ")}`;
    const target = sshTarget(host);

    // Sync results/ directory back if it exists, plus log files
    await execAsync(
      `rsync -azP -e "${sshCmd}" "${target}:${remoteDir}/results/" "${localDir}/results/"`,
      { timeout: 120_000 },
    ).catch(() => {
      // results/ may not exist, that's ok
    });

    // Also grab log files
    for (const f of ["stdout.log", "stderr.log"]) {
      const scpArgs = sshArgs(host).map(a => `"${a}"`).join(" ");
      await execAsync(
        `scp ${scpArgs} "${target}:${remoteDir}/${f}" "${localDir}/${f}"`,
        { timeout: 30_000 },
      ).catch(() => {});
    }
  },

  async kill(pid: number, host: HostConfig): Promise<void> {
    await sshExec(host, `kill ${pid} 2>/dev/null || true`).catch(() => {});
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

    // 3. Poll until done
    let alive = true;
    while (alive) {
      await new Promise((r) => setTimeout(r, 10_000)); // poll every 10s

      // Re-check job hasn't been cancelled
      const current = await prisma.remoteJob.findUnique({ where: { id: jobId } });
      if (!current || current.status === "CANCELLED") {
        await backend.kill(pid, config);
        return;
      }

      alive = await backend.isAlive(pid, config);

      // Update logs
      const logs = await backend.getLogs(remoteDir, config);
      await prisma.remoteJob.update({
        where: { id: jobId },
        data: { stdout: logs.stdout, stderr: logs.stderr },
      });
    }

    // 4. Get exit code
    let exitCode: number | null = null;
    try {
      const exitStr = await sshExec(config, `cat ${remoteDir}/.exit_code 2>/dev/null || echo -1`);
      exitCode = parseInt(exitStr, 10);
    } catch {
      // couldn't read exit code, check logs for errors
    }

    // 5. Sync results back
    if (localDir) {
      await backend.syncDown(remoteDir, localDir, config);
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
            ? `Remote experiment failed (exit ${exitCode}) on ${config.host}`
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
