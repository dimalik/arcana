import path from "path";
import { prisma } from "@/lib/prisma";
import { classifyRemoteFailureRecovery } from "./execution-policy";

export interface ExperimentConvergenceState {
  scriptsWithHistory: string[];
  recordedScripts: string[];
  pendingResultScripts: string[];
  failedCodeScripts: string[];
}

function normalizeScriptName(scriptName: string) {
  return path.basename(scriptName.trim());
}

export function isManagedExperimentScript(scriptName: string) {
  return /^(poc|exp|sweep)_\d{3}_.+\.py$/i.test(normalizeScriptName(scriptName));
}

export function extractManagedScriptFromCommand(command: string | null | undefined) {
  const match = (command || "").match(/python3?\s+(\S+\.py)\b/);
  const scriptName = match?.[1] ? normalizeScriptName(match[1]) : null;
  if (!scriptName || !isManagedExperimentScript(scriptName)) return null;
  return scriptName;
}

export async function getExperimentConvergenceState(projectId: string): Promise<ExperimentConvergenceState> {
  const [jobs, results] = await Promise.all([
    prisma.remoteJob.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        command: true,
        status: true,
        errorClass: true,
        createdAt: true,
      },
    }),
    prisma.experimentResult.findMany({
      where: { projectId },
      select: {
        jobId: true,
        scriptName: true,
      },
    }),
  ]);

  const recordedJobIds = new Set(
    results.map((result) => result.jobId).filter((jobId): jobId is string => Boolean(jobId)),
  );
  const recordedScripts = Array.from(new Set(
    results
      .map((result) => normalizeScriptName(result.scriptName))
      .filter((scriptName) => isManagedExperimentScript(scriptName)),
  )).sort();

  const latestJobByScript = new Map<string, typeof jobs[number]>();
  const scriptsWithHistory = new Set<string>();
  const pendingResultScripts = new Set<string>();

  for (const job of jobs) {
    const scriptName = extractManagedScriptFromCommand(job.command);
    if (!scriptName) continue;
    scriptsWithHistory.add(scriptName);
    if (!latestJobByScript.has(scriptName)) {
      latestJobByScript.set(scriptName, job);
    }
    if (job.status === "COMPLETED" && !recordedJobIds.has(job.id)) {
      pendingResultScripts.add(scriptName);
    }
  }

  const failedCodeScripts = Array.from(latestJobByScript.entries())
    .filter(([, job]) => job.status === "FAILED" && classifyRemoteFailureRecovery(job.errorClass).mode === "fix_code")
    .map(([scriptName]) => scriptName)
    .sort();

  return {
    scriptsWithHistory: Array.from(scriptsWithHistory).sort(),
    recordedScripts,
    pendingResultScripts: Array.from(pendingResultScripts).sort(),
    failedCodeScripts,
  };
}

export async function getManagedScriptCreationBarrier(projectId: string, targetScript: string) {
  const normalizedTarget = normalizeScriptName(targetScript);
  if (!isManagedExperimentScript(normalizedTarget)) return null;

  const state = await getExperimentConvergenceState(projectId);

  if (state.pendingResultScripts.length > 0) {
    return [
      `BLOCKED — Completed experiment output still needs to become a canonical ExperimentResult: ${state.pendingResultScripts.join(", ")}.`,
      "Do not create a new managed experiment script until completed work is imported and analyzed.",
      "Inspect the existing result artifact or reload the project so automatic result recovery can ingest it.",
    ].join("\n");
  }

  const unresolvedCodeScripts = state.failedCodeScripts.filter((scriptName) => scriptName !== normalizedTarget);
  if (unresolvedCodeScripts.length > 0) {
    return [
      `BLOCKED — Existing experiment scripts still have unresolved code failures: ${unresolvedCodeScripts.join(", ")}.`,
      "Fix the failing script in place instead of forking to a new filename.",
    ].join("\n");
  }

  const isKnownScript = state.scriptsWithHistory.includes(normalizedTarget) || state.recordedScripts.includes(normalizedTarget);
  if (!isKnownScript && state.recordedScripts.length === 0 && state.scriptsWithHistory.length >= 2) {
    return [
      `BLOCKED — This project already has ${state.scriptsWithHistory.length} managed experiment scripts with execution history and still has 0 canonical results.`,
      `Existing scripts: ${state.scriptsWithHistory.join(", ")}.`,
      "Do not create a third script. Reuse or overwrite an existing script until one experiment produces a recorded result.",
    ].join("\n");
  }

  return null;
}

export async function getManagedScriptDeletionBarrier(projectId: string, targetScript: string) {
  const normalizedTarget = normalizeScriptName(targetScript);
  if (!isManagedExperimentScript(normalizedTarget)) return null;

  const [jobCount, resultCount] = await Promise.all([
    prisma.remoteJob.count({
      where: {
        projectId,
        command: { contains: normalizedTarget },
      },
    }),
    prisma.experimentResult.count({
      where: {
        projectId,
        scriptName: normalizedTarget,
      },
    }),
  ]);

  if (jobCount === 0 && resultCount === 0) return null;

  return [
    `BLOCKED — Do not delete ${normalizedTarget}; it already has persisted experiment history (${jobCount} remote job(s), ${resultCount} recorded result(s)).`,
    "Keep experiment scripts inspectable. Overwrite the script in place if you need to iterate, but do not delete the historical file.",
  ].join("\n");
}

export async function getExperimentSubmissionConvergenceBarrier(projectId: string, targetScript: string) {
  const normalizedTarget = normalizeScriptName(targetScript);
  if (!isManagedExperimentScript(normalizedTarget)) return null;

  const state = await getExperimentConvergenceState(projectId);

  if (state.pendingResultScripts.length > 0) {
    return [
      `BLOCKED — Completed experiment output still needs analysis before another run: ${state.pendingResultScripts.join(", ")}.`,
      "Do not submit another experiment until completed work has been imported into ExperimentResult and reviewed.",
    ].join("\n");
  }

  const unresolvedCodeScripts = state.failedCodeScripts.filter((scriptName) => scriptName !== normalizedTarget);
  if (unresolvedCodeScripts.length > 0) {
    return [
      `BLOCKED — Fix the existing failed experiment script(s) before starting a different one: ${unresolvedCodeScripts.join(", ")}.`,
      `If you are iterating on ${unresolvedCodeScripts[0]}, overwrite that script in place and resubmit it.`,
    ].join("\n");
  }

  const isKnownScript = state.scriptsWithHistory.includes(normalizedTarget) || state.recordedScripts.includes(normalizedTarget);
  if (!isKnownScript && state.recordedScripts.length === 0 && state.scriptsWithHistory.length >= 2) {
    return [
      `BLOCKED — The project already has ${state.scriptsWithHistory.length} managed experiment scripts in flight without any canonical result.`,
      `Existing scripts: ${state.scriptsWithHistory.join(", ")}.`,
      "Do not start a third script. Converge on the existing scripts until one yields a recorded result.",
    ].join("\n");
  }

  return null;
}
