import { prisma } from "@/lib/prisma";
import {
  repairDerivedResultClaims,
  repairDuplicateClaims,
  repairLegacyClaimAssessments,
  repairResultBackedClaimProvenance,
} from "./claim-ledger";
import { isPlanningNotebookEntry } from "./research-log-policy";

function parseMetadata(raw: string | null | undefined) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isFailureReflectionMetadata(metadata: Record<string, unknown> | null | undefined, jobId?: string | null) {
  if (!metadata || metadata.kind !== "failure_reflection") return false;
  if (!jobId) return true;
  return metadata.jobId === jobId;
}

export function buildFailureReflectionMetadata(params: {
  jobId: string;
  scriptName: string;
  rootCause?: string;
  lesson?: string;
  nextApproach?: string;
  migratedFromResultId?: string;
}) {
  return JSON.stringify({
    kind: "failure_reflection",
    jobId: params.jobId,
    scriptName: params.scriptName,
    ...(params.rootCause ? { rootCause: params.rootCause } : {}),
    ...(params.lesson ? { lesson: params.lesson } : {}),
    ...(params.nextApproach ? { nextApproach: params.nextApproach } : {}),
    ...(params.migratedFromResultId ? { migratedFromResultId: params.migratedFromResultId } : {}),
  });
}

export async function getReflectedFailureJobIds(projectId: string) {
  const [logs, steps, legacyResults, remoteJobs] = await Promise.all([
    prisma.researchLogEntry.findMany({
      where: { projectId, type: "dead_end" },
      select: { metadata: true },
    }),
    prisma.researchStep.findMany({
      where: {
        iteration: { projectId },
        type: "analyze_results",
        status: "COMPLETED",
      },
      select: { output: true },
    }),
    prisma.experimentResult.findMany({
      where: {
        projectId,
        verdict: "error",
        jobId: { not: null },
      },
      select: { jobId: true },
    }),
    prisma.remoteJob.findMany({
      where: {
        projectId,
        status: { in: ["FAILED", "CANCELLED"] },
      },
      select: { id: true },
    }),
  ]);

  const jobIds = new Set<string>();
  const failedJobIds = new Set(remoteJobs.map((job) => job.id));

  for (const log of logs) {
    const metadata = parseMetadata(log.metadata);
    if (isFailureReflectionMetadata(metadata) && typeof metadata?.jobId === "string") {
      jobIds.add(metadata.jobId);
    }
  }

  for (const step of steps) {
    const output = parseMetadata(step.output);
    if (output?.kind === "failure_reflection" && typeof output.jobId === "string") {
      jobIds.add(output.jobId);
    }
  }

  for (const result of legacyResults) {
    if (result.jobId && failedJobIds.has(result.jobId)) jobIds.add(result.jobId);
  }

  return jobIds;
}

export async function repairPlanningDecisionLogs(projectId?: string) {
  const candidates = await prisma.researchLogEntry.findMany({
    where: {
      type: "decision",
      ...(projectId ? { projectId } : {}),
    },
    select: { id: true, content: true },
  });

  let reclassified = 0;
  for (const entry of candidates) {
    if (!isPlanningNotebookEntry(entry.content)) continue;
    await prisma.researchLogEntry.update({
      where: { id: entry.id },
      data: { type: "planning_note" },
    });
    reclassified += 1;
  }

  return { reclassified };
}

export async function repairFailureReflectionResults(projectId?: string) {
  const candidates = await prisma.experimentResult.findMany({
    where: {
      verdict: "error",
      jobId: { not: null },
      ...(projectId ? { projectId } : {}),
    },
    include: {
      artifacts: { select: { id: true } },
      claims: { select: { id: true } },
      claimEvidence: { select: { id: true } },
    },
  });

  if (candidates.length === 0) return { repaired: 0, skipped: 0 };

  const jobs = await prisma.remoteJob.findMany({
    where: { id: { in: candidates.map((candidate) => candidate.jobId!).filter(Boolean) } },
    select: { id: true, status: true },
  });
  const jobStatusById = new Map(jobs.map((job) => [job.id, job.status]));

  const deadEnds = await prisma.researchLogEntry.findMany({
    where: {
      type: "dead_end",
      ...(projectId ? { projectId } : {}),
    },
    select: { projectId: true, metadata: true },
  });

  const reflectedJobKeys = new Set<string>();
  for (const entry of deadEnds) {
    const metadata = parseMetadata(entry.metadata);
    if (isFailureReflectionMetadata(metadata) && typeof metadata?.jobId === "string") {
      reflectedJobKeys.add(`${entry.projectId}:${metadata.jobId}`);
    }
  }

  let repaired = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    const jobId = candidate.jobId;
    if (!jobId) {
      skipped += 1;
      continue;
    }

    const jobStatus = jobStatusById.get(jobId);
    if (jobStatus !== "FAILED" && jobStatus !== "CANCELLED") {
      skipped += 1;
      continue;
    }

    const safeToDelete = candidate.artifacts.length === 0
      && candidate.claims.length === 0
      && candidate.claimEvidence.length === 0;
    if (!safeToDelete) {
      skipped += 1;
      continue;
    }

    const deadEndKey = `${candidate.projectId}:${jobId}`;
    if (!reflectedJobKeys.has(deadEndKey)) {
      await prisma.researchLogEntry.create({
        data: {
          projectId: candidate.projectId,
          type: "dead_end",
          content: candidate.reflection
            ? `Failure reflection (${candidate.scriptName}): ${candidate.reflection}`
            : `Failure reflection (${candidate.scriptName}): execution failure was previously stored as an ExperimentResult and has been migrated back into the notebook.`,
          metadata: buildFailureReflectionMetadata({
            jobId,
            scriptName: candidate.scriptName,
            migratedFromResultId: candidate.id,
          }),
        },
      });
      reflectedJobKeys.add(deadEndKey);
    }

    await prisma.experimentResult.delete({ where: { id: candidate.id } });
    repaired += 1;
  }

  return { repaired, skipped };
}

export async function repairResearchProjectReadModel(projectId: string) {
  const failureResults = await repairFailureReflectionResults(projectId);
  const planningLogs = await repairPlanningDecisionLogs(projectId);
  const derivedResultClaims = await repairDerivedResultClaims(projectId);
  const duplicateClaims = await repairDuplicateClaims(projectId);
  const legacyAssessments = await repairLegacyClaimAssessments(projectId);
  const claimProvenance = await repairResultBackedClaimProvenance(projectId);

  return {
    failureResults,
    planningLogs,
    derivedResultClaims,
    duplicateClaims,
    legacyAssessments,
    claimProvenance,
  };
}
