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
import { mkdir, readFile, writeFile } from "fs/promises";
import { prisma } from "@/lib/prisma";
import { isSyntheticTestHost } from "./remote-host-policy";
import { extractRuntimeDependencies, type RuntimeDependency } from "./runtime-dependencies";
import { resolveExperimentContract } from "./experiment-contracts";
import {
  acquireExecutorLease,
  buildWorkspaceLeaseKey,
  createAttemptRecord,
  heartbeatAttemptExecutorLeases,
  heartbeatExecutorLease,
  createRunForSubmission,
  finalizeAttempt,
  linkRunToRemoteJob,
  loadExecutorLease,
  releaseAttemptExecutorLeases,
  releaseExecutorLease,
  reserveNextAttemptNumber,
  setAttemptRunning,
  syncLegacyRemoteJobProjection,
  transitionRunState,
  EXECUTOR_LEASE_TTL_MS,
} from "./run-lifecycle";
import { importExperimentResultFromRemoteJob } from "./result-import";
import { createOrUpdateHelpRequest } from "./help-requests";
import { launchSubAgentTask } from "./sub-agent-launcher";

const execAsync = promisify(exec);
const ACTIVE_REMOTE_JOB_STATUSES = ["SYNCING", "QUEUED", "RUNNING"] as const;
const TERMINAL_HELPER_STATUSES = new Set<HelperStatus["status"]>(["completed", "failed", "oom_killed"]);
const WORKSPACE_LOCK_STALE_HEARTBEAT_MS = EXECUTOR_LEASE_TTL_MS;
const staleCleanupByProject = new Map<string, Promise<number>>();
let staleCleanupAllProjects: Promise<number> | null = null;

// ── Helper management ────────────────────────────────────────────

const HELPER_VERSION = "14";
const helperInstalledHosts = new Map<string, boolean>();

export function getWorkspaceBaseName(localDir: string): string {
  const normalized = localDir.replace(/\\/g, "/").replace(/\/+$/, "");
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] || "experiment";
}

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
  try {
    await execAsync(
      `rsync -az -e "${sshCmd}" "${helperPath}" "${target}:~/.arcana/helper.py"`,
      { timeout: 30_000 },
    );
  } catch (rsyncErr) {
    // rsync missing locally or on remote — fall back to scp
    const scpArgs = sshArgs(host).map(a => `"${a}"`).join(" ");
    await execAsync(
      `scp ${scpArgs} "${helperPath}" "${target}:~/.arcana/helper.py"`,
      { timeout: 30_000 },
    );
  }
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
  // Pass user-configured environment variables (HF_TOKEN, WANDB_API_KEY, etc.)
  if (host.envVars) {
    for (const [key, val] of Object.entries(host.envVars)) {
      if (key && val && /^[A-Z_][A-Z0-9_]*$/i.test(key)) {
        envParts.push(`${key}='${val.replace(/'/g, "'\\''")}'`);
      }
    }
  }
  const envPrefix = envParts.length > 0 ? envParts.join(" ") + " " : "";
  return sshExec(host, `${envPrefix}python3 ~/.arcana/helper.py ${args}`);
}

interface RuntimeProbeResult {
  ok: boolean;
  kind: string;
  detail?: string;
  elapsedMs?: number;
  error?: string;
}

export interface RuntimeSmokeProbeResult extends RuntimeProbeResult {
  torchVersion?: string;
  cudaAvailable?: boolean;
  gpuCount?: number;
  torchImportError?: string;
}

function encodeRuntimeProbePayload(dependency: RuntimeDependency): string {
  return Buffer.from(JSON.stringify(dependency), "utf-8").toString("base64url");
}

async function probeRuntimeDependency(host: HostConfig, remoteDir: string, dependency: RuntimeDependency): Promise<RuntimeProbeResult> {
  const raw = await invokeHelper(host, `probe ${remoteDir} ${encodeRuntimeProbePayload(dependency)}`);
  return parseHelperResponse<RuntimeProbeResult>(raw);
}

export async function probeRuntimeSmoke(hostId: string, localDir: string): Promise<RuntimeSmokeProbeResult> {
  const host = await prisma.remoteHost.findUnique({ where: { id: hostId } });
  if (!host) {
    return { ok: false, kind: "runtime_smoke", error: "Host not found" };
  }

  const config = hostToConfig(host);
  const remoteDir = `${host.workDir}/${getWorkspaceBaseName(localDir)}`;
  const payload = Buffer.from(JSON.stringify({ kind: "runtime_smoke" }), "utf-8").toString("base64url");

  try {
    const raw = await invokeHelper(config, `probe ${remoteDir} ${payload}`);
    return parseHelperResponse<RuntimeSmokeProbeResult>(raw);
  } catch (err) {
    return {
      ok: false,
      kind: "runtime_smoke",
      error: err instanceof Error ? err.message : String(err),
    };
  }
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
  diagnosis?: string;
  error?: string;
}

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

const BLOCKING_PYRIGHT_RULES = new Set([
  "reportMissingImports",
  "reportUndefinedVariable",
  "reportUndefinedFunction",
  "reportAttributeAccessIssue",
  "reportCallIssue",
]);

function normalizePyrightDiagnostic(raw: Record<string, unknown>): ScriptDiagnostic {
  const rule = typeof raw.rule === "string" ? raw.rule : "";
  const reportedSeverity = raw.severity === "error" ? "error" : "warning";
  const severity: "error" | "warning" =
    reportedSeverity === "error" && BLOCKING_PYRIGHT_RULES.has(rule) ? "error" : "warning";

  const line = typeof raw.line === "number" ? raw.line : 1;
  const col =
    typeof raw.col === "number"
      ? raw.col
      : typeof raw.column === "number"
        ? raw.column
        : 1;
  const endLine =
    typeof raw.endLine === "number"
      ? raw.endLine
      : undefined;
  const endCol =
    typeof raw.endCol === "number"
      ? raw.endCol
      : typeof raw.endColumn === "number"
        ? raw.endColumn
        : undefined;

  return {
    line,
    col,
    endLine,
    endCol,
    severity,
    message: typeof raw.message === "string" ? raw.message : "",
    rule,
  };
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
  run(remoteDir: string, command: string, host: HostConfig, runName?: string): Promise<number>;
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
  envVars?: Record<string, string> | null;
}

export interface MockRemoteExecutionOptions {
  enabled: boolean;
  mode?: "success" | "failure";
  writeResultFile?: boolean;
}

/** Build HostConfig from a Prisma RemoteHost record */
export function hostToConfig(host: { host: string; port: number; user: string; keyPath: string | null; workDir: string; conda: string | null; setupCmd: string | null; envVars: string | null }): HostConfig {
  let envVars: Record<string, string> | null = null;
  if (host.envVars) { try { envVars = JSON.parse(host.envVars); } catch { /* ignore */ } }
  return {
    host: host.host, port: host.port, user: host.user, keyPath: host.keyPath,
    workDir: host.workDir, conda: host.conda, setupCmd: host.setupCmd, envVars,
  };
}

async function findLatestAttempt(runId: string | null | undefined) {
  if (!runId) return null;
  return prisma.experimentAttempt.findFirst({
    where: { runId },
    orderBy: [{ attemptNumber: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      state: true,
      heartbeatAt: true,
      remoteDir: true,
      localDir: true,
      hostId: true,
    },
  });
}

async function loadRemoteJobWithHost(jobId: string) {
  return prisma.remoteJob.findUnique({
    where: { id: jobId },
    include: { host: true },
  });
}

type RemoteJobWithHost = NonNullable<Awaited<ReturnType<typeof loadRemoteJobWithHost>>>;

interface WorkspaceLeaseBinding {
  leaseKey: string;
  leaseToken: string;
  attemptId?: string | null;
}

async function heartbeatWorkspaceLease(binding: WorkspaceLeaseBinding | null | undefined) {
  if (!binding) return;
  if (binding.attemptId) {
    await heartbeatAttemptExecutorLeases({ attemptId: binding.attemptId }).catch(() => {});
    return;
  }
  await heartbeatExecutorLease({
    leaseKey: binding.leaseKey,
    leaseToken: binding.leaseToken,
  }).catch(() => {});
}

async function releaseWorkspaceLease(
  binding: WorkspaceLeaseBinding | null | undefined,
  reason: string,
  payload?: unknown,
) {
  if (!binding) return;
  if (binding.attemptId) {
    await releaseAttemptExecutorLeases({
      attemptId: binding.attemptId,
      reason,
      payload,
    }).catch(() => {});
    return;
  }
  await releaseExecutorLease({
    leaseKey: binding.leaseKey,
    leaseToken: binding.leaseToken,
    reason,
    payload,
  }).catch(() => {});
}

function attemptHeartbeatAgeMs(heartbeatAt: Date | null | undefined) {
  if (!heartbeatAt) return Number.POSITIVE_INFINITY;
  return Date.now() - heartbeatAt.getTime();
}

async function finalizeRemoteJobFromHelper(params: {
  job: RemoteJobWithHost;
  helperStatus: HelperStatus;
  syncResults?: boolean;
  reason: string;
}) {
  const { job, helperStatus, syncResults = true, reason } = params;
  const config = hostToConfig(job.host);
  const exitCode = helperStatus.exit_code ?? null;
  const oomDetected = helperStatus.oom_detected ?? false;
  const failed = oomDetected || (exitCode !== null && exitCode !== 0);

  const finalStdout = helperStatus.stdout_tail || job.stdout || "";
  let finalStderr = helperStatus.stderr_tail || job.stderr || "";
  if (oomDetected && helperStatus.oom_detail) {
    finalStderr = `${finalStderr}\n\n[OOM DETECTED] ${helperStatus.oom_detail}`.trim();
  }
  if (helperStatus.diagnosis) {
    finalStderr = `[DIAGNOSIS] ${helperStatus.diagnosis}\n\n${finalStderr}`;
  }

  if (syncResults && job.localDir && job.remoteDir) {
    try {
      await sshExecutor.syncDown(job.remoteDir, job.localDir, config);
    } catch (syncErr) {
      console.warn(`[remote-executor] syncDown failed while reconciling ${job.id}:`, syncErr);
    }
  }

  await prisma.remoteJob.update({
    where: { id: job.id },
    data: {
      status: failed ? "FAILED" : "COMPLETED",
      exitCode,
      stdout: finalStdout,
      stderr: finalStderr,
      resultsSynced: true,
      completedAt: new Date(),
      startedAt: job.startedAt || new Date(),
      ...(failed ? { errorClass: oomDetected ? "RESOURCE_ERROR" : job.errorClass || null } : {}),
    },
  });

  const latestAttempt = await findLatestAttempt(job.runId);
  if (latestAttempt && latestAttempt.state !== "TERMINAL") {
    await finalizeAttempt({
      attemptId: latestAttempt.id,
      exitCode,
      stdoutTail: finalStdout,
      stderrTail: finalStderr,
      errorClass: failed ? (oomDetected ? "RESOURCE_ERROR" : job.errorClass || null) : null,
      errorReason: failed ? reason : null,
    }).catch(() => {});
  }

  if (job.runId) {
    await transitionRunState({
      runId: job.runId,
      toState: failed ? "FAILED" : "SUCCEEDED",
      reason,
      attemptId: latestAttempt?.id || null,
      payload: { jobId: job.id, exitCode, reconciled: true },
    }).catch(() => {});
    await syncLegacyRemoteJobProjection({ runId: job.runId, remoteJobId: job.id }).catch(() => {});
  }
  if (latestAttempt?.id) {
    await releaseAttemptExecutorLeases({
      attemptId: latestAttempt.id,
      reason,
      payload: { jobId: job.id, finalized: true },
    }).catch(() => {});
  } else if (job.remoteDir) {
    await releaseExecutorLease({
      leaseKey: buildWorkspaceLeaseKey(job.hostId, job.remoteDir),
      reason,
      payload: { jobId: job.id, finalized: true },
    }).catch(() => {});
  }

  if (!failed) {
    await importExperimentResultFromRemoteJob(job.id).catch((err) => {
      console.warn(`[remote-executor] result import failed for ${job.id}:`, err);
    });
  }

  return prisma.remoteJob.findUnique({
    where: { id: job.id },
    include: { host: true },
  });
}

async function markRemoteJobLostHeartbeat(params: {
  job: RemoteJobWithHost;
  reason: string;
}) {
  const { job, reason } = params;
  await prisma.remoteJob.update({
    where: { id: job.id },
    data: {
      status: "FAILED",
      exitCode: job.exitCode ?? null,
      stderr: `${job.stderr || ""}\n\n[RECONCILED] ${reason}`.trim(),
      errorClass: "RESOURCE_ERROR",
      resultsSynced: true,
      completedAt: new Date(),
    },
  });

  const latestAttempt = await findLatestAttempt(job.runId);
  if (latestAttempt && latestAttempt.state !== "TERMINAL") {
    await finalizeAttempt({
      attemptId: latestAttempt.id,
      exitCode: null,
      stdoutTail: job.stdout || "",
      stderrTail: `${job.stderr || ""}\n\n[RECONCILED] ${reason}`.trim(),
      errorClass: "RESOURCE_ERROR",
      errorReason: reason,
    }).catch(() => {});
  }
  if (job.runId) {
    await transitionRunState({
      runId: job.runId,
      toState: "FAILED",
      reason,
      attemptId: latestAttempt?.id || null,
      payload: { jobId: job.id, reconciled: true, staleHeartbeat: true },
    }).catch(() => {});
    await syncLegacyRemoteJobProjection({ runId: job.runId, remoteJobId: job.id }).catch(() => {});
  }
  if (latestAttempt?.id) {
    await releaseAttemptExecutorLeases({
      attemptId: latestAttempt.id,
      reason,
      payload: { jobId: job.id, reconciled: true, staleHeartbeat: true },
    }).catch(() => {});
  } else if (job.remoteDir) {
    await releaseExecutorLease({
      leaseKey: buildWorkspaceLeaseKey(job.hostId, job.remoteDir),
      reason,
      payload: { jobId: job.id, reconciled: true, staleHeartbeat: true },
    }).catch(() => {});
  }

  return prisma.remoteJob.findUnique({
    where: { id: job.id },
    include: { host: true },
  });
}

export async function reconcileRemoteJobState(jobId: string) {
  const job = await loadRemoteJobWithHost(jobId);
  if (!job || !job.host) return job;

  if (!ACTIVE_REMOTE_JOB_STATUSES.includes(job.status as (typeof ACTIVE_REMOTE_JOB_STATUSES)[number])) {
    if (job.status === "COMPLETED") {
      await importExperimentResultFromRemoteJob(job.id).catch(() => {});
    }
    return job;
  }

  if (!job.remoteDir) return job;

  const config = hostToConfig(job.host);
  try {
    const helperStatus = await getHelperStatus(config, job.remoteDir);

    await prisma.remoteJob.update({
      where: { id: job.id },
      data: {
        stdout: helperStatus.stdout_tail || job.stdout,
        stderr: helperStatus.stderr_tail || job.stderr,
      },
    }).catch(() => {});

    if (helperStatus.status === "running" || helperStatus.status === "setup") {
      const latestAttempt = await findLatestAttempt(job.runId);
      if (latestAttempt && latestAttempt.state !== "TERMINAL") {
        await prisma.experimentAttempt.update({
          where: { id: latestAttempt.id },
          data: {
            heartbeatAt: new Date(),
            stdoutTail: helperStatus.stdout_tail || undefined,
            stderrTail: helperStatus.stderr_tail || undefined,
          },
        }).catch(() => {});
        await heartbeatAttemptExecutorLeases({ attemptId: latestAttempt.id }).catch(() => {});
      } else {
        const lease = await loadExecutorLease(buildWorkspaceLeaseKey(job.hostId, job.remoteDir));
        if (lease) {
          await heartbeatExecutorLease({
            leaseKey: lease.leaseKey,
            leaseToken: lease.leaseToken,
          }).catch(() => {});
        }
      }
      return prisma.remoteJob.findUnique({
        where: { id: job.id },
        include: { host: true },
      });
    }

    if (TERMINAL_HELPER_STATUSES.has(helperStatus.status)) {
      return finalizeRemoteJobFromHelper({
        job,
        helperStatus,
        syncResults: true,
        reason: "Terminal state reconciled from remote helper",
      });
    }

    const latestAttempt = await findLatestAttempt(job.runId);
    const heartbeatAge = attemptHeartbeatAgeMs(latestAttempt?.heartbeatAt || job.startedAt || job.createdAt);
    if (helperStatus.status === "unknown" && heartbeatAge >= WORKSPACE_LOCK_STALE_HEARTBEAT_MS) {
      return markRemoteJobLostHeartbeat({
        job,
        reason: "Remote helper reported unknown status after the workspace heartbeat expired.",
      });
    }

    return prisma.remoteJob.findUnique({
      where: { id: job.id },
      include: { host: true },
    });
  } catch (err) {
    const latestAttempt = await findLatestAttempt(job.runId);
    const heartbeatAge = attemptHeartbeatAgeMs(latestAttempt?.heartbeatAt || job.startedAt || job.createdAt);
    if (heartbeatAge >= WORKSPACE_LOCK_STALE_HEARTBEAT_MS) {
      return markRemoteJobLostHeartbeat({
        job,
        reason: "Workspace lock reconciliation released a stale job after lost heartbeat.",
      });
    }
    return prisma.remoteJob.findUnique({
      where: { id: job.id },
      include: { host: true },
    });
  }
}

async function findBlockingWorkspaceJob(params: {
  hostId: string;
  projectedRemoteDir: string;
  localDir: string;
  leaseKey: string;
  excludeAttemptId?: string;
}) {
  const activeLease = await loadExecutorLease(params.leaseKey);
  if (activeLease) {
    const now = new Date();
    if (activeLease.leaseExpiresAt > now) {
      const leaseJob = activeLease.runId
        ? await prisma.remoteJob.findFirst({
            where: { runId: activeLease.runId },
            orderBy: { createdAt: "desc" },
            include: { host: true },
          })
        : null;
      if (leaseJob) {
        const reconciled = await reconcileRemoteJobState(leaseJob.id);
        if (reconciled && ACTIVE_REMOTE_JOB_STATUSES.includes(reconciled.status as (typeof ACTIVE_REMOTE_JOB_STATUSES)[number])) {
          return reconciled;
        }
      }

      if (activeLease.attemptId) {
        const attempt = await prisma.experimentAttempt.findUnique({
          where: { id: activeLease.attemptId },
          select: {
            id: true,
            runId: true,
            heartbeatAt: true,
            startedAt: true,
          },
        });
        if (attempt) {
          const heartbeatAge = attemptHeartbeatAgeMs(attempt.heartbeatAt || attempt.startedAt);
          if (heartbeatAge < WORKSPACE_LOCK_STALE_HEARTBEAT_MS) {
            return {
              id: attempt.id,
              status: "RUNNING",
              command: `lease:${activeLease.ownerId}`,
            };
          }

          await finalizeAttempt({
            attemptId: attempt.id,
            exitCode: null,
            errorClass: "RESOURCE_ERROR",
            errorReason: "Expired workspace lease released stale attempt during admission reconciliation.",
          }).catch(() => {});
          if (attempt.runId) {
            await transitionRunState({
              runId: attempt.runId,
              toState: "FAILED",
              reason: "Expired workspace lease released stale attempt during admission reconciliation.",
              attemptId: attempt.id,
              payload: { reconciled: true, expiredLease: true },
            }).catch(() => {});
          }
          await releaseAttemptExecutorLeases({
            attemptId: attempt.id,
            reason: "Expired workspace lease released during admission reconciliation.",
            payload: { expiredLease: true },
          }).catch(() => {});
        }
      } else {
        return {
          id: activeLease.id,
          status: "RUNNING",
          command: `lease:${activeLease.ownerId}`,
        };
      }
    } else {
      await releaseExecutorLease({
        leaseKey: activeLease.leaseKey,
        leaseToken: activeLease.leaseToken,
        reason: "Expired workspace lease released during admission reconciliation.",
        payload: { expiredLease: true },
      }).catch(() => {});
    }
  }

  const candidateAttempts = await prisma.experimentAttempt.findMany({
    where: {
      hostId: params.hostId,
      state: { in: ["STARTING", "RUNNING"] },
      ...(params.excludeAttemptId ? { NOT: { id: params.excludeAttemptId } } : {}),
      OR: [
        { remoteDir: params.projectedRemoteDir },
        { localDir: params.localDir },
      ],
    },
    orderBy: [{ attemptNumber: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      runId: true,
      heartbeatAt: true,
      startedAt: true,
    },
  });

  for (const attempt of candidateAttempts) {
    const candidate = await prisma.remoteJob.findFirst({
      where: { runId: attempt.runId || undefined },
      orderBy: { createdAt: "desc" },
      include: { host: true },
    });
    if (candidate) {
      const reconciled = await reconcileRemoteJobState(candidate.id);
      if (!reconciled) continue;
      if (ACTIVE_REMOTE_JOB_STATUSES.includes(reconciled.status as (typeof ACTIVE_REMOTE_JOB_STATUSES)[number])) {
        return reconciled;
      }
      continue;
    }

    const heartbeatAge = attemptHeartbeatAgeMs(attempt.heartbeatAt || attempt.startedAt);
    if (heartbeatAge >= WORKSPACE_LOCK_STALE_HEARTBEAT_MS) {
      await finalizeAttempt({
        attemptId: attempt.id,
        exitCode: null,
        errorClass: "RESOURCE_ERROR",
        errorReason: "Workspace reconciliation released stale attempt without a linked remote job.",
      }).catch(() => {});
      if (attempt.runId) {
        await transitionRunState({
          runId: attempt.runId,
          toState: "FAILED",
          reason: "Workspace reconciliation released stale attempt without a linked remote job.",
          attemptId: attempt.id,
          payload: { reconciled: true, missingRemoteJob: true },
        }).catch(() => {});
      }
      await releaseAttemptExecutorLeases({
        attemptId: attempt.id,
        reason: "Workspace reconciliation released stale attempt without a linked remote job.",
        payload: { reconciled: true, missingRemoteJob: true },
      }).catch(() => {});
      continue;
    }

    return {
      id: attempt.id,
      status: "RUNNING",
      command: "attempt_without_remote_job",
    };
  }

  const candidates = await prisma.remoteJob.findMany({
    where: {
      hostId: params.hostId,
      status: { in: [...ACTIVE_REMOTE_JOB_STATUSES] },
      OR: [
        { remoteDir: params.projectedRemoteDir },
        { remoteDir: "", localDir: params.localDir },
        { localDir: params.localDir },
      ],
    },
    orderBy: { createdAt: "desc" },
    include: { host: true },
  });

  for (const candidate of candidates) {
    const reconciled = await reconcileRemoteJobState(candidate.id);
    if (!reconciled) continue;
    if (ACTIVE_REMOTE_JOB_STATUSES.includes(reconciled.status as (typeof ACTIVE_REMOTE_JOB_STATUSES)[number])) {
      return reconciled;
    }
  }

  return null;
}

/** Derive a run directory name from an experiment command.
 *  e.g. "python3 exp_055.py" → "run_055"
 *       "python3 baseline_bert.py --lr 0.001" → "run_baseline_bert"
 */
function deriveRunName(command: string): string {
  const scriptMatch = command.match(/python3?\s+(\S+\.py)/);
  if (!scriptMatch) return `run_${Date.now()}`;
  const scriptName = scriptMatch[1].replace(/\.py$/, "");
  const cleaned = scriptName.replace(/^exp_/, "");
  return `run_${cleaned}`;
}

// ── SSH executor ──────────────────────────────────────────────────

function sshArgs(host: HostConfig): string[] {
  const isConfigAlias = !host.user || host.user === "-";
  const args = [
    "-o", "ConnectTimeout=30",
    // Connection multiplexing: reuse SSH connections instead of opening new ones
    // Eliminates repeated handshakes during polling (6/min → 0)
    "-o", "ControlMaster=auto",
    "-o", `ControlPath=/tmp/arcana-ssh-%r@%h:%p`,
    "-o", "ControlPersist=300",  // Keep master alive for 5 minutes after last use
    // Keep-alive: detect dead connections faster
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=4",  // Give up after 60s of no response
  ];
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

async function sshExecOnce(host: HostConfig, cmd: string): Promise<string> {
  const { execFile: execFileCb } = await import("child_process");
  const args = ["-T", ...sshArgs(host), sshTarget(host), "--", cmd];

  return new Promise((resolve, reject) => {
    execFileCb("ssh", args, { timeout: 300_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      const out = (stdout || "").trim();
      const errOut = (stderr || "").trim();

      if (err) {
        const msg = [errOut, out, err.message]
          .find((value) => typeof value === "string" && value.trim().length > 0)
          || "SSH command failed";
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
 * SSH exec with automatic retry on transient failures.
 * Retries up to 2 times with exponential backoff (3s, 9s).
 * Connection errors, timeouts, and "Connection reset" are retried.
 * Command-level errors (non-zero exit without stdout) are NOT retried.
 */
async function sshExec(host: HostConfig, cmd: string): Promise<string> {
  const MAX_RETRIES = 2;
  const RETRYABLE = /connect|timeout|reset|broken pipe|connection refused|no route|network is unreachable/i;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await sshExecOnce(host, cmd);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isRetryable = RETRYABLE.test(msg);

      if (!isRetryable || attempt === MAX_RETRIES) {
        throw err;
      }

      const delay = 3000 * Math.pow(3, attempt); // 3s, 9s
      console.warn(`[remote-executor] SSH retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms: ${msg.slice(0, 100)}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error("SSH exec failed after retries"); // unreachable but satisfies TS
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
    const rsyncCmd = `rsync -azP --delete --exclude='.nfs*' --exclude='.venv' --exclude='__pycache__' --exclude='*.pyc' --exclude='stdout.log' --exclude='stderr.log' --exclude='.exit_code' --exclude='.arcana' --exclude='run_*' --exclude='.archive' --ignore-errors -e "${sshCmd}" "${src}" "${target}:${remoteDir}/"`;

    try {
      await execAsync(rsyncCmd, { timeout: 120_000 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // rsync missing locally or on remote — fall back to scp
      if (msg.includes("rsync: command not found") || msg.includes("rsync: not found") || msg.includes("rsync: No such file") || (msg.includes("rsync") && msg.includes("code 127"))) {
        console.warn("[remote-executor] rsync not available (local or remote), falling back to scp");
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

  async run(remoteDir: string, command: string, host: HostConfig, runName?: string): Promise<number> {
    // Command is already sanitized by agent.ts — don't double-sanitize.
    // Just trim whitespace.
    const cleanCmd = command.replace(/\s+/g, " ").trim();

    // Shell-escape the command for safe transport through SSH → remote shell → helper.
    // Single-quote the entire command, escaping internal single quotes.
    const escaped = cleanCmd.replace(/'/g, "'\\''");
    const runArg = runName ? ` --run '${runName.replace(/'/g, "'\\''")}'` : "";
    const raw = await invokeHelper(host, `run ${remoteDir}${runArg} -- '${escaped}'`);
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
  scriptHash?: string;
  hypothesisId?: string;
  experimentPurpose?: string;
  grounding?: string;
  claimEligibility?: string;
  promotionPolicy?: string;
  evidenceClass?: string;
  diagnostics?: string;
  idempotencyKey?: string;
  ignoreActiveWorkspaceLock?: boolean;
  mock?: MockRemoteExecutionOptions;
}): Promise<{ jobId: string; runId?: string }> {
  const host = await prisma.remoteHost.findUnique({ where: { id: params.hostId } });
  if (!host) throw new Error("Remote host not found");
  if (isSyntheticTestHost(host) && !params.mock?.enabled) {
    throw new Error(
      `Host ${host.alias} (${host.host}) is a synthetic test host and cannot be used for normal research execution.`,
    );
  }

  const config = hostToConfig(host);

  const backend = getBackend(host.backend);

  const runName = deriveRunName(params.command);
  const scriptMatch = params.command.match(/python3?\s+(\S+\.py)/);
  const scriptName = scriptMatch ? path.basename(scriptMatch[1]) : null;
  const scriptPath = scriptMatch ? scriptMatch[1] : null;
  let scriptCode = "";
  if (scriptPath) {
    try {
      scriptCode = await readFile(path.join(params.localDir, scriptPath), "utf-8");
    } catch {
      scriptCode = "";
    }
  }
  const contract = resolveExperimentContract({
    scriptName: scriptName || params.command,
    command: params.command,
    code: scriptCode,
    experimentPurpose: params.experimentPurpose,
    grounding: params.grounding,
    claimEligibility: params.claimEligibility,
    promotionPolicy: params.promotionPolicy,
    evidenceClass: params.evidenceClass,
  });
  const runtimeDependencies = scriptPath
    ? await extractRuntimeDependencies(params.localDir, scriptPath).catch(() => [] as RuntimeDependency[])
    : [];
  let lifecycleRunId: string | undefined;
  let lifecycleAttemptId: string | undefined;
  if (params.projectId) {
    const run = await createRunForSubmission({
      projectId: params.projectId,
      hypothesisId: params.hypothesisId || null,
      experimentPurpose: contract.experimentPurpose,
      grounding: contract.grounding,
      claimEligibility: contract.claimEligibility,
      promotionPolicy: contract.promotionPolicy,
      evidenceClass: contract.evidenceClass,
      requestedHostId: host.id,
      command: params.command,
      scriptName,
      scriptHash: params.scriptHash || null,
      idempotencyKey: params.idempotencyKey || null,
      metadata: { source: "submitRemoteJob", localDir: params.localDir, runDir: runName },
    });
    lifecycleRunId = run.runId;
  }

  const localBaseName = getWorkspaceBaseName(params.localDir);
  const projectedRemoteDir = `${config.workDir}/${localBaseName}`;
  const workspaceLeaseKey = buildWorkspaceLeaseKey(host.id, projectedRemoteDir);

  if (lifecycleRunId) {
    const attemptNumber = await reserveNextAttemptNumber(lifecycleRunId);
    lifecycleAttemptId = await createAttemptRecord({
      runId: lifecycleRunId,
      attemptNumber,
      hostId: host.id,
      localDir: params.localDir,
      remoteDir: projectedRemoteDir,
      runDir: runName,
      helperVersion: HELPER_VERSION,
    });
  }

  if (!params.ignoreActiveWorkspaceLock) {
    const activeWorkspaceJob = await findBlockingWorkspaceJob({
      hostId: host.id,
      projectedRemoteDir,
      localDir: params.localDir,
      leaseKey: workspaceLeaseKey,
      excludeAttemptId: lifecycleAttemptId,
    });

    if (activeWorkspaceJob) {
      if (lifecycleAttemptId) {
        await finalizeAttempt({
          attemptId: lifecycleAttemptId,
          exitCode: null,
          errorReason: "Workspace lock: active run in same host/workdir",
        }).catch(() => {});
      }
      if (lifecycleRunId) {
        await transitionRunState({
          runId: lifecycleRunId,
          toState: "BLOCKED",
          reason: "Workspace lock: active run in same host/workdir",
          attemptId: lifecycleAttemptId,
          payload: {
            hostId: host.id,
            hostAlias: host.alias,
            remoteDir: projectedRemoteDir,
            blockedByJobId: activeWorkspaceJob.id,
            blockedByStatus: activeWorkspaceJob.status,
            blockedByCommand: activeWorkspaceJob.command,
          },
        }).catch(() => {});
      }

      const blockedRunNote = lifecycleRunId ? ` (run ${lifecycleRunId.slice(0, 8)} blocked)` : "";
      throw new Error(
        `Workspace busy on ${host.alias}: active job ${activeWorkspaceJob.id.slice(0, 8)} ` +
        `(${activeWorkspaceJob.status}). Wait for completion before submitting another run in the same workspace.${blockedRunNote}`,
      );
    }
  }

  const leaseOwnerId = lifecycleAttemptId ? `attempt:${lifecycleAttemptId}` : `workspace:${host.id}:${Date.now()}`;
  const acquiredLease = await acquireExecutorLease({
    leaseKey: workspaceLeaseKey,
    owner: {
      ownerId: leaseOwnerId,
      scope: "workspace",
      runId: lifecycleRunId || null,
      attemptId: lifecycleAttemptId || null,
      hostId: host.id,
      projectId: params.projectId || null,
      metadata: {
        localDir: params.localDir,
        remoteDir: projectedRemoteDir,
        command: params.command,
      },
    },
  });
  if (!acquiredLease.acquired) {
    if (lifecycleAttemptId) {
      await finalizeAttempt({
        attemptId: lifecycleAttemptId,
        exitCode: null,
        errorReason: "Workspace lease acquisition failed: another attempt owns the workspace.",
      }).catch(() => {});
    }
    if (lifecycleRunId) {
      await transitionRunState({
        runId: lifecycleRunId,
        toState: "BLOCKED",
        reason: "Workspace lease acquisition failed",
        attemptId: lifecycleAttemptId,
        payload: {
          leaseKey: workspaceLeaseKey,
          blockingOwner: acquiredLease.blockingLease.ownerId,
          leaseExpiresAt: acquiredLease.blockingLease.leaseExpiresAt,
        },
      }).catch(() => {});
    }
    throw new Error(
      `Workspace busy on ${host.alias}: lease ${workspaceLeaseKey} is owned by ${acquiredLease.blockingLease.ownerId} until ${acquiredLease.blockingLease.leaseExpiresAt.toISOString()}.`,
    );
  }

  const workspaceLease: WorkspaceLeaseBinding = {
    leaseKey: workspaceLeaseKey,
    leaseToken: acquiredLease.lease.leaseToken,
    attemptId: lifecycleAttemptId || null,
  };

  let job;
  try {
    job = await prisma.remoteJob.create({
      data: {
        hostId: host.id,
        stepId: params.stepId || null,
        projectId: params.projectId || null,
        runId: lifecycleRunId || null,
        localDir: params.localDir,
        remoteDir: projectedRemoteDir,
        command: params.command,
        scriptHash: params.scriptHash || null,
        hypothesisId: params.hypothesisId || null,
        experimentPurpose: contract.experimentPurpose,
        grounding: contract.grounding,
        claimEligibility: contract.claimEligibility,
        promotionPolicy: contract.promotionPolicy,
        evidenceClass: contract.evidenceClass,
        diagnostics: params.diagnostics || null,
        runDir: runName,
        status: "SYNCING",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create remote job record";
    await releaseWorkspaceLease(workspaceLease, "Remote job creation failed and released workspace lease.", {
      error: message,
    });
    if (lifecycleAttemptId) {
      await finalizeAttempt({
        attemptId: lifecycleAttemptId,
        exitCode: null,
        errorReason: message,
      }).catch(() => {});
    }
    if (lifecycleRunId) {
      await transitionRunState({
        runId: lifecycleRunId,
        toState: "FAILED",
        reason: message,
        attemptId: lifecycleAttemptId,
      }).catch(() => {});
    }
    throw err;
  }

  if (lifecycleRunId) {
    await linkRunToRemoteJob(lifecycleRunId, job.id);
    await transitionRunState({
      runId: lifecycleRunId,
      toState: "STARTING",
      reason: "Remote job created, syncing workspace",
      attemptId: lifecycleAttemptId,
    });
    await syncLegacyRemoteJobProjection({ runId: lifecycleRunId, remoteJobId: job.id });
  }

  if (params.mock?.enabled) {
    const mode = params.mock.mode === "failure" ? "failure" : "success";
    const now = new Date();
    const isSuccess = mode === "success";
    const terminalStatus = isSuccess ? "COMPLETED" : "FAILED";
    const exitCode = isSuccess ? 0 : 1;

    const stdout = [
      "[mock-executor] Deterministic execution mode enabled.",
      `[mock-executor] host=${host.alias} run=${runName} command=${params.command}`,
      `[mock-executor] status=${terminalStatus.toLowerCase()} exit=${exitCode}`,
    ].join("\n");
    const stderr = isSuccess
      ? ""
      : "[mock-executor] Simulated failure for deterministic test coverage.";

    await prisma.remoteJob.update({
      where: { id: job.id },
      data: {
        status: terminalStatus,
        remotePid: 0,
        startedAt: now,
        completedAt: now,
        exitCode,
        stdout,
        stderr,
        resultsSynced: true,
      },
    });

    if (lifecycleAttemptId) {
      await setAttemptRunning({ attemptId: lifecycleAttemptId, remotePid: 0 }).catch(() => {});
      await finalizeAttempt({
        attemptId: lifecycleAttemptId,
        exitCode,
        stdoutTail: stdout,
        stderrTail: stderr || undefined,
        errorClass: isSuccess ? null : "RESEARCH_FAILURE",
        errorReason: isSuccess ? null : "Mock executor simulated failure",
      }).catch(() => {});
    }

    if (lifecycleRunId) {
      await transitionRunState({
        runId: lifecycleRunId,
        toState: "RUNNING",
        reason: "Mock executor started run",
        attemptId: lifecycleAttemptId,
      }).catch(() => {});
      await transitionRunState({
        runId: lifecycleRunId,
        toState: isSuccess ? "SUCCEEDED" : "FAILED",
        reason: isSuccess ? "Mock executor completed run" : "Mock executor failed run",
        attemptId: lifecycleAttemptId,
      }).catch(() => {});
      await syncLegacyRemoteJobProjection({ runId: lifecycleRunId, remoteJobId: job.id }).catch(() => {});
    }

    if (isSuccess && params.mock.writeResultFile) {
      const hash = Array.from(params.command).reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 1000, 0);
      const f1 = Number((0.65 + hash / 10000).toFixed(4));
      const accuracy = Number((f1 + 0.08).toFixed(4));
      const payload = {
        version: 1,
        mock: true,
        command: params.command,
        run: runName,
        verdict: "better",
        summary: `${runName} completed in deterministic mock mode.`,
        condition: "mock",
        metrics: { f1, accuracy },
        raw_metrics: { f1, accuracy },
        generatedAt: now.toISOString(),
      };
      try {
        await mkdir(path.join(params.localDir, "results"), { recursive: true });
        await writeFile(
          path.join(params.localDir, "results", "arcana_result.json"),
          JSON.stringify(payload, null, 2),
          "utf-8",
        );
      } catch {
        // Non-fatal: job record already captures outcome.
      }
    }

    if (isSuccess) {
      await importExperimentResultFromRemoteJob(job.id).catch((err) => {
        console.warn(`[remote-executor] mock result import failed for ${job.id}:`, err);
      });
    }

    await releaseWorkspaceLease(workspaceLease, "Mock executor released workspace lease.", {
      jobId: job.id,
      terminalStatus,
    });

    return { jobId: job.id, runId: lifecycleRunId };
  }

  // Sync files synchronously so errors propagate to caller
  let remoteDir: string;
  try {
    remoteDir = await backend.syncUp(params.localDir, config);
    await prisma.remoteJob.update({
      where: { id: job.id },
      data: { remoteDir, status: "RUNNING", startedAt: new Date() },
    });
    if (lifecycleAttemptId) {
      await prisma.experimentAttempt.update({
        where: { id: lifecycleAttemptId },
        data: { remoteDir, heartbeatAt: new Date() },
      });
    }
    if (lifecycleRunId) {
      await syncLegacyRemoteJobProjection({ runId: lifecycleRunId, remoteJobId: job.id });
    }
    await heartbeatWorkspaceLease(workspaceLease);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Sync failed";
    await prisma.remoteJob.update({
      where: { id: job.id },
      data: { status: "FAILED", stderr: `Sync failed: ${message}`, completedAt: new Date() },
    });
    if (lifecycleAttemptId) {
      await finalizeAttempt({
        attemptId: lifecycleAttemptId,
        exitCode: null,
        stderrTail: `Sync failed: ${message}`,
        errorClass: "RESOURCE_ERROR",
        errorReason: message,
      }).catch(() => {});
    }
    if (lifecycleRunId) {
      await transitionRunState({
        runId: lifecycleRunId,
        toState: "FAILED",
        reason: `syncUp failed: ${message}`,
        attemptId: lifecycleAttemptId,
      }).catch(() => {});
      await syncLegacyRemoteJobProjection({ runId: lifecycleRunId, remoteJobId: job.id }).catch(() => {});
    }
    await releaseWorkspaceLease(workspaceLease, "syncUp failed and released workspace lease.", {
      jobId: job.id,
      error: message,
    });
    throw new Error(`File sync to ${host.alias} failed: ${message}`);
  }

  // Write base requirements to remote ONLY if no pre-configured environment exists.
  // When conda/venv is configured on the host, the host env is authoritative —
  // writing base_requirements.txt would trigger the helper's merge+pip logic,
  // which can break the environment by attempting to build packages from source.
  if (host.baseRequirements && !config.conda) {
    try {
      await sshExec(config,
        `mkdir -p ${remoteDir}/.arcana && cat > ${remoteDir}/.arcana/base_requirements.txt << 'ARCANA_EOF'\n${host.baseRequirements}\nARCANA_EOF`
      );
    } catch (err) {
      console.warn(`[remote-executor] Failed to write base requirements:`, (err as Error).message);
    }
  }

  if (runtimeDependencies.length > 0) {
    try {
      const probeMessages: string[] = [];
      for (const dependency of runtimeDependencies) {
        const probe = await probeRuntimeDependency(config, remoteDir, dependency);
        probeMessages.push(
          `${dependency.kind}:${dependency.name}${probe.detail ? ` — ${probe.detail}` : ""}`,
        );
      }
      await prisma.remoteJob.update({
        where: { id: job.id },
        data: {
          diagnostics: [params.diagnostics, ...probeMessages].filter(Boolean).join("\n"),
        },
      }).catch(() => {});
    } catch (err) {
      const message = err instanceof Error ? err.message : "Runtime dependency probe failed";
      const warning = `Runtime dependency probe warning: ${message}`;
      await prisma.remoteJob.update({
        where: { id: job.id },
        data: {
          diagnostics: [params.diagnostics, warning].filter(Boolean).join("\n"),
        },
      }).catch(() => {});
      if (params.projectId) {
        await createOrUpdateHelpRequest({
          projectId: params.projectId,
          category: "env_issue",
          title: `Runtime dependency probe warning on ${host.alias}`,
          detail: warning,
          suggestion: "Use validate_environment or diagnose_remote_host if the experiment later fails for environment reasons.",
          metadata: { hostAlias: host.alias, remoteJobId: job.id, runtimeProbe: true },
        }).catch(() => {});
      }
      console.warn(`[remote-executor] ${warning}`);
    }
  }

  // Start the experiment + poll in the background
  runAndPoll(job.id, config, backend, remoteDir, params.command, params.localDir, runName, lifecycleRunId, lifecycleAttemptId, workspaceLease).catch((err) => {
    console.error(`[remote-executor] Job ${job.id} background error:`, err);
  });

  return { jobId: job.id, runId: lifecycleRunId };
}

async function runAndPoll(
  jobId: string,
  config: HostConfig,
  backend: ExecutorBackend,
  remoteDir: string,
  command: string,
  localDir?: string,
  runName?: string,
  runId?: string,
  attemptId?: string,
  workspaceLease?: WorkspaceLeaseBinding,
) {
  try {
    // 1. Start the command on the remote (via helper — handles venv, supervision, OOM detection)
    const pid = await backend.run(remoteDir, command, config, runName);
    await prisma.remoteJob.update({
      where: { id: jobId },
      data: { remotePid: pid },
    });
    if (attemptId) {
      await setAttemptRunning({ attemptId, remotePid: pid }).catch(() => {});
    }
    if (runId) {
      await transitionRunState({
        runId,
        toState: "RUNNING",
        reason: "Remote process started",
        attemptId,
      }).catch(() => {});
      await syncLegacyRemoteJobProjection({ runId, remoteJobId: jobId }).catch(() => {});
    }

    // 2. Poll via helper status — SSH ControlMaster reuses connections
    // With connection multiplexing + retry, transient failures are handled automatically.
    // We use adaptive polling: 10s initially, backing off to 30s after SSH issues.
    let done = false;
    let consecutiveSshFailures = 0;
    const MAX_SSH_FAILURES = 36; // ~30 min of unreachability (SSH has retries + ControlMaster)
    let pollInterval = 10_000; // Start at 10s, increase on SSH issues
    let finalStatus: HelperStatus | null = null;

    while (!done) {
      await new Promise((r) => setTimeout(r, pollInterval));

      // Re-check job hasn't been cancelled
      const current = await prisma.remoteJob.findUnique({ where: { id: jobId } });
      if (!current || current.status === "CANCELLED") {
        try { await killViaHelper(config, remoteDir); } catch { /* best effort */ }
        if (attemptId) {
          await finalizeAttempt({
            attemptId,
            exitCode: null,
            errorClass: "RESOURCE_ERROR",
            errorReason: "Cancelled while running",
          }).catch(() => {});
        }
        if (runId) {
          await transitionRunState({
            runId,
            toState: "CANCELLED",
            reason: "Remote job was cancelled",
            attemptId,
          }).catch(() => {});
          await syncLegacyRemoteJobProjection({ runId, remoteJobId: jobId }).catch(() => {});
        }
        await releaseWorkspaceLease(workspaceLease, "Remote job cancelled and released workspace lease.", {
          jobId,
        });
        return;
      }

      try {
        const status = await getHelperStatus(config, remoteDir);
        consecutiveSshFailures = 0;
        pollInterval = 10_000; // Reset to fast polling on success

        // Update logs from helper response
        await prisma.remoteJob.update({
          where: { id: jobId },
          data: { stdout: status.stdout_tail, stderr: status.stderr_tail },
        });
        if (attemptId) {
          await prisma.experimentAttempt.update({
            where: { id: attemptId },
            data: {
              heartbeatAt: new Date(),
              stdoutTail: status.stdout_tail,
              stderrTail: status.stderr_tail,
            },
          }).catch(() => {});
          await heartbeatAttemptExecutorLeases({ attemptId }).catch(() => {});
        }

        if (status.status !== "running" && status.status !== "setup") {
          done = true;
          finalStatus = status;
        }
      } catch (err) {
        consecutiveSshFailures++;
        // Back off polling interval: 10s → 20s → 30s (caps at 30s)
        pollInterval = Math.min(30_000, 10_000 + consecutiveSshFailures * 5_000);
        console.warn(`[remote-executor] Job ${jobId}: SSH failure #${consecutiveSshFailures} (next poll in ${pollInterval / 1000}s): ${err instanceof Error ? err.message.slice(0, 100) : err}`);
        if (consecutiveSshFailures >= MAX_SSH_FAILURES) {
          console.error(`[remote-executor] Job ${jobId}: ${MAX_SSH_FAILURES} consecutive SSH failures (~30min), marking as indeterminate`);
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

    // Prepend structured diagnosis so the agent sees actionable suggestions first
    if (finalStatus?.diagnosis) {
      finalStderr = `[DIAGNOSIS] ${finalStatus.diagnosis}\n\n${finalStderr}`;
    }

    const failed = oomDetected || (exitCode !== null && exitCode !== 0);
    // If we couldn't determine exit code at all (SSH failures, no status file),
    // don't guess — mark as FAILED so the user knows to check manually.
    const indeterminate = exitCode === null && !finalStatus;

    // ── Auto-fix layer: classify error and attempt fix for code bugs ──
    // Classifies ALL failures and stores errorClass on the job.
    // CODE_ERROR: attempts auto-fix + resubmit. RESOURCE_ERROR: creates help request.
    // RESEARCH_FAILURE: recorded as a real failure requiring reflection.
    let classifiedErrorClass: string | null = null;
    if (failed && !indeterminate && localDir) {
      try {
        const { classifyAndFix } = await import("./auto-fix");
        const fixResult = await classifyAndFix(
          jobId, exitCode, finalStderr, finalStdout, localDir, command,
        );
        classifiedErrorClass = fixResult.fixed ? "AUTO_FIXED" : fixResult.errorClass;

        if (fixResult.fixed && fixResult.resubmitJobId) {
          // Code error was auto-fixed and resubmitted
          await prisma.remoteJob.update({
            where: { id: jobId },
            data: {
              status: "CANCELLED",
              exitCode,
              stdout: finalStdout,
              stderr: `${finalStderr}\n\n[AUTO-FIXED] ${fixResult.reason}. Resubmitted as job ${fixResult.resubmitJobId.slice(0, 8)}.`,
              errorClass: "AUTO_FIXED",
              resultsSynced: true,
              completedAt: new Date(),
            },
          });

          if (attemptId) {
            await finalizeAttempt({
              attemptId,
              exitCode,
              stdoutTail: finalStdout,
              stderrTail: finalStderr,
              errorClass: "AUTO_FIXED",
              errorReason: `${fixResult.reason}; resubmitted as ${fixResult.resubmitJobId}`,
            }).catch(() => {});
          }
          if (runId) {
            await transitionRunState({
              runId,
              toState: "CANCELLED",
              reason: `Auto-fixed and superseded by run ${fixResult.resubmitJobId}`,
              attemptId,
              payload: { resubmitJobId: fixResult.resubmitJobId },
            }).catch(() => {});
            await syncLegacyRemoteJobProjection({ runId, remoteJobId: jobId }).catch(() => {});
          }

          await releaseWorkspaceLease(workspaceLease, "Remote job auto-fixed and superseded; released workspace lease before resubmit handoff.", {
            jobId,
            resubmitJobId: fixResult.resubmitJobId,
          });

          if (localDir) {
            import("./workspace").then(({ invalidateWorkspace }) => {
              const job2 = prisma.remoteJob.findUnique({ where: { id: jobId }, select: { projectId: true } });
              job2.then(j => { if (j?.projectId) invalidateWorkspace(j.projectId); });
            }).catch(() => {});
          }
          return; // Exit runAndPoll — new job takes over
        }
      } catch (fixErr) {
        console.warn("[auto-fix] Error in auto-fix layer:", fixErr);
      }
    }

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
        ...(classifiedErrorClass ? { errorClass: classifiedErrorClass } : {}),
        resultsSynced: true,
        completedAt: new Date(),
      },
    });

    if (attemptId) {
      await finalizeAttempt({
        attemptId,
        exitCode,
        stdoutTail: finalStdout,
        stderrTail: indeterminate
          ? `${finalStderr}\n\n[INDETERMINATE] Could not determine job outcome`
          : finalStderr,
        errorClass: classifiedErrorClass,
        errorReason: failed || indeterminate ? "Experiment execution failed" : null,
      }).catch(() => {});
    }
    if (runId) {
      await transitionRunState({
        runId,
        toState: finalJobStatus === "COMPLETED" ? "SUCCEEDED" : "FAILED",
        reason: finalJobStatus === "COMPLETED" ? "Run completed successfully" : "Run failed",
        attemptId,
        payload: { jobId, exitCode, classifiedErrorClass, indeterminate },
      }).catch(() => {});
      await syncLegacyRemoteJobProjection({ runId, remoteJobId: jobId }).catch(() => {});
    }
    await releaseWorkspaceLease(workspaceLease, "Remote job reached terminal state and released workspace lease.", {
      jobId,
      finalJobStatus,
      exitCode,
    });

    if (finalJobStatus === "COMPLETED") {
      await importExperimentResultFromRemoteJob(jobId).catch((err) => {
        console.warn(`[remote-executor] result import failed for ${jobId}:`, err);
      });
    }

    // Archive the run on the remote host (best-effort, post-sync, only on success)
    if (runName && localDir && !failed && !indeterminate) {
      const hostRecord2 = await prisma.remoteHost.findFirst({
        where: { jobs: { some: { id: jobId } } },
        select: { cleanupPolicy: true },
      });
      const policy = hostRecord2?.cleanupPolicy || "archive";
      await archiveRun(jobId, config, remoteDir, runName, policy);
    }

    // Auto-create help requests for user-fixable failures
    const jobRecord = await prisma.remoteJob.findUnique({ where: { id: jobId }, select: { projectId: true } });
    if (finalJobStatus === "FAILED" && jobRecord?.projectId) {
      const diag = finalStatus?.diagnosis || "";
      if (diag.includes("IMPORT ERROR") || diag.includes("OOM KILL")) {
        const category = diag.includes("OOM") ? "env_issue" : "package";
        const title = diag.includes("OOM")
          ? "Experiment OOM — needs smaller model or quantization"
          : `Missing package on ${config.host}`;
        createOrUpdateHelpRequest({
          projectId: jobRecord.projectId,
          category,
          title,
          detail: diag,
          suggestion: diag.split("Suggestions:")[1]?.trim() || "",
          metadata: {
            ...(jobId ? { jobId } : {}),
            hostAlias: config.host,
            remoteDir,
          },
        }).catch(() => {});
      }
    }

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

      // ── Auto-visualization: dispatch visualizer after successful experiments ──
      if (!failed && !indeterminate && job.projectId) {
        try {
          const completedCount = await prisma.remoteJob.count({
            where: { projectId: job.projectId, status: "COMPLETED" },
          });
          const vizCount = await prisma.agentTask.count({
            where: { projectId: job.projectId, role: "visualizer" },
          });
          // Auto-dispatch every ~2 new successful experiments
          if (completedCount >= 2 && completedCount > vizCount * 2) {
            const vizTask = await prisma.agentTask.create({
              data: {
                projectId: job.projectId,
                role: "visualizer",
                goal: "Auto-visualization: create publication-quality figures comparing all completed experiment results",
                status: "PENDING",
                input: JSON.stringify({ workDir: localDir }),
              },
            });
            void launchSubAgentTask(vizTask.id, "auto-viz")
              .then(() => {
                if (!localDir) return;
                import("./figure-captioner").then(({ captionNewFigures }) => {
                  captionNewFigures(job.projectId!, localDir).catch(() => {});
                }).catch(() => {});
              })
              .catch((e) => console.error("[auto-viz] Visualizer sub-agent failed:", e));

            await prisma.researchLogEntry.create({
              data: {
                projectId: job.projectId,
                type: "observation",
                content: `Auto-dispatched visualizer after ${completedCount} completed experiments`,
              },
            });
          }
        } catch (vizErr) {
          console.warn("[auto-viz] Failed to dispatch visualizer:", vizErr);
        }
      }
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

    if (attemptId) {
      await finalizeAttempt({
        attemptId,
        exitCode: null,
        stderrTail: message,
        errorClass: "RESOURCE_ERROR",
        errorReason: message,
      }).catch(() => {});
    }
    if (runId) {
      await transitionRunState({
        runId,
        toState: "FAILED",
        reason: `runAndPoll exception: ${message}`,
        attemptId,
      }).catch(() => {});
      await syncLegacyRemoteJobProjection({ runId, remoteJobId: jobId }).catch(() => {});
    }
    await releaseWorkspaceLease(workspaceLease, "runAndPoll exception released workspace lease.", {
      jobId,
      error: message,
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
  if (!projectId) {
    if (staleCleanupAllProjects) return staleCleanupAllProjects;
    staleCleanupAllProjects = (async () => {
      if (staleCleanupByProject.size > 0) {
        await Promise.allSettled(Array.from(staleCleanupByProject.values()));
      }
      return cleanupStaleJobsInternal();
    })().finally(() => {
      staleCleanupAllProjects = null;
    });
    return staleCleanupAllProjects;
  }

  if (staleCleanupAllProjects) {
    return staleCleanupAllProjects;
  }

  const existing = staleCleanupByProject.get(projectId);
  if (existing) return existing;

  const promise = cleanupStaleJobsInternal(projectId).finally(() => {
    staleCleanupByProject.delete(projectId);
  });
  staleCleanupByProject.set(projectId, promise);
  return promise;
}

async function cleanupStaleJobsInternal(projectId?: string): Promise<number> {
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
    const config: HostConfig | null = job.host ? hostToConfig(job.host) : null;

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
            const latestAttempt = job.runId
              ? await prisma.experimentAttempt.findFirst({
                  where: { runId: job.runId },
                  orderBy: [{ attemptNumber: "desc" }, { createdAt: "desc" }],
                  select: { id: true },
                })
              : null;
            if (latestAttempt?.id) {
              await heartbeatAttemptExecutorLeases({ attemptId: latestAttempt.id }).catch(() => {});
            } else {
              const lease = await loadExecutorLease(buildWorkspaceLeaseKey(job.hostId, job.remoteDir));
              if (lease) {
                await heartbeatExecutorLease({
                  leaseKey: lease.leaseKey,
                  leaseToken: lease.leaseToken,
                }).catch(() => {});
              }
            }
            continue; // Still alive, let it run
          }
        }
        if (helperResult.status === "unknown") {
          helperResult = null;
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

    // Prepend structured diagnosis so the agent sees actionable suggestions first
    if (helperResult?.diagnosis) {
      finalStderr = `[DIAGNOSIS] ${helperResult.diagnosis}\n\n${finalStderr}`;
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

    if (job.runId) {
      const latestAttempt = await prisma.experimentAttempt.findFirst({
        where: { runId: job.runId },
        orderBy: [{ attemptNumber: "desc" }, { createdAt: "desc" }],
        select: { id: true },
      });

      if (latestAttempt) {
        await finalizeAttempt({
          attemptId: latestAttempt.id,
          exitCode: exitCodeFromRemote,
          stdoutTail: finalStdout,
          stderrTail: finalStderr,
          errorClass: failed || indeterminate ? "RESOURCE_ERROR" : null,
          errorReason: failed || indeterminate ? "Recovered by stale-job cleanup" : null,
        }).catch(() => {});
      }

      await transitionRunState({
        runId: job.runId,
        toState: finalStatus === "COMPLETED" ? "SUCCEEDED" : "FAILED",
        reason: "Recovered by stale-job cleanup",
        attemptId: latestAttempt?.id || null,
      }).catch(() => {});

      await syncLegacyRemoteJobProjection({ runId: job.runId, remoteJobId: job.id }).catch(() => {});
      if (latestAttempt?.id) {
        await releaseAttemptExecutorLeases({
          attemptId: latestAttempt.id,
          reason: "Stale-job cleanup released workspace lease.",
          payload: { jobId: job.id, finalStatus },
        }).catch(() => {});
      } else if (job.remoteDir) {
        await releaseExecutorLease({
          leaseKey: buildWorkspaceLeaseKey(job.hostId, job.remoteDir),
          reason: "Stale-job cleanup released standalone workspace lease.",
          payload: { jobId: job.id, finalStatus },
        }).catch(() => {});
      }
    }

    // Sync results back if possible
    if (config && job.remoteDir && job.localDir) {
      try {
        await sshExecutor.syncDown(job.remoteDir, job.localDir, config);
      } catch {
        // Non-critical
      }
    }

    if (finalStatus === "COMPLETED") {
      await importExperimentResultFromRemoteJob(job.id).catch((err) => {
        console.warn(`[remote-executor] result import failed during stale cleanup for ${job.id}:`, err);
      });
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

// ── Workspace lifecycle ──────────────────────────────────────────

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
      await sshExec(config, `rm -rf ${remoteDir}/${runName}`);
      console.log(`[remote-executor] Deleted ${runName} on remote (policy=delete)`);
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
    console.warn(`[remote-executor] archiveRun failed for ${runName}:`, err instanceof Error ? err.message : err);
  }
}

// ── Script analysis ─────────────────────────────────────────────

/**
 * Run pyright static analysis on a script via the remote helper.
 * Returns structured diagnostics, or null on any failure (non-blocking).
 */
export async function analyzeScript(
  host: HostConfig,
  remoteDir: string,
  scriptName: string,
  hostId?: string,
): Promise<ScriptDiagnostics | null> {
  try {
    const raw = await invokeHelper(host, `check ${remoteDir} ${scriptName}`);
    const result = parseHelperResponse<ScriptDiagnostics & { ok: boolean; errors?: Record<string, unknown>[] }>(raw);
    const normalizedErrors = Array.isArray(result.errors) ? result.errors.map(normalizePyrightDiagnostic) : [];
    const errorCount = normalizedErrors.filter(d => d.severity === "error").length;
    const warningCount = normalizedErrors.filter(d => d.severity === "warning").length;

    const diagnosticsResult: ScriptDiagnostics = {
      errors: normalizedErrors,
      errorCount,
      warningCount,
      pyrightVersion: result.pyrightVersion,
      unavailable: result.unavailable,
      timeout: result.timeout,
      reason: result.reason,
    };

    // Cache pyrightInstalled on the host record if this is a successful analysis
    if (hostId && !diagnosticsResult.unavailable && !diagnosticsResult.timeout) {
      prisma.remoteHost.update({
        where: { id: hostId },
        data: { pyrightInstalled: true },
      }).catch(() => {}); // Best-effort, don't block
    }

    return diagnosticsResult;
  } catch (err) {
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

  lines.push(`\nFix these issues in the script and resubmit. (Attempt ${attempt}.)`);

  return lines.join("\n");
}

// ── Utility ───────────────────────────────────────────────────────

/** Cancel a running remote job */
export async function cancelRemoteJob(jobId: string): Promise<void> {
  const job = await prisma.remoteJob.findUnique({
    where: { id: jobId },
    include: { host: true },
  });
  if (!job) return;
  if (job.status === "COMPLETED" || job.status === "FAILED" || job.status === "CANCELLED") return;

  const config = hostToConfig(job.host);

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
    data: {
      status: "CANCELLED",
      completedAt: new Date(),
      stderr: `${job.stderr || ""}\n\n[CANCELLED] Cancelled by control plane.`.trim(),
    },
  });

  const latestAttempt = await findLatestAttempt(job.runId);
  if (latestAttempt && latestAttempt.state !== "TERMINAL") {
    await finalizeAttempt({
      attemptId: latestAttempt.id,
      exitCode: job.exitCode ?? null,
      stdoutTail: job.stdout || "",
      stderrTail: `${job.stderr || ""}\n\n[CANCELLED] Cancelled by control plane.`.trim(),
      errorReason: "Remote job cancelled",
    }).catch(() => {});
  }
  if (job.runId) {
    await transitionRunState({
      runId: job.runId,
      toState: "CANCELLED",
      reason: "Remote job cancelled",
      attemptId: latestAttempt?.id || null,
      payload: { jobId },
    }).catch(() => {});
    await syncLegacyRemoteJobProjection({ runId: job.runId, remoteJobId: job.id }).catch(() => {});
  }
  if (latestAttempt?.id) {
    await releaseAttemptExecutorLeases({
      attemptId: latestAttempt.id,
      reason: "Remote job cancelled and released workspace lease.",
      payload: { jobId, cancelled: true },
    }).catch(() => {});
  } else if (job.remoteDir) {
    await releaseExecutorLease({
      leaseKey: buildWorkspaceLeaseKey(job.hostId, job.remoteDir),
      reason: "Remote job cancelled and released standalone workspace lease.",
      payload: { jobId, cancelled: true },
    }).catch(() => {});
  }
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
