import { prisma } from "@/lib/prisma";
import {
  getEvaluationProtocol,
  validateCommandAgainstEvaluationProtocol,
} from "./evaluation-protocol";
import {
  formatWorkspaceBusySubmissionBlock,
  type WorkspaceBusyGuard,
} from "./execution-policy";

export type SubmissionReadinessIssueCode =
  | "HYPOTHESIS"
  | "PROTOCOL_COMMAND"
  | "ANALYSIS_BACKLOG"
  | "POC_REQUIRED"
  | "WORKSPACE_BUSY";

export interface SubmissionReadinessIssue {
  code: SubmissionReadinessIssueCode;
  message: string;
}

export interface SubmissionReadiness {
  ok: boolean;
  currentPhase: string;
  resolvedHypothesisId: string | null;
  autoAttachedHypothesis: boolean;
  hypothesisNote?: string;
  issues: SubmissionReadinessIssue[];
  workspaceGuard: WorkspaceBusyGuard | null;
}

type SubmissionHypothesisResolution =
  | { ok: true; hypothesisId: string | null; autoAttached: boolean; note?: string }
  | { ok: false; message: string };

function hypothesisPriority(status: string) {
  if (status === "TESTING") return 3;
  if (status === "REVISED") return 2;
  if (status === "PROPOSED") return 1;
  return 0;
}

export async function getActiveWorkspaceSubmissionGuard(
  projectId: string,
  hostId: string,
): Promise<WorkspaceBusyGuard | null> {
  const now = new Date();
  const [activeJob, activeLease] = await Promise.all([
    prisma.remoteJob.findFirst({
      where: {
        projectId,
        hostId,
        status: { in: ["SYNCING", "QUEUED", "RUNNING"] },
      },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        status: true,
        command: true,
      },
    }),
    prisma.executorLease.findFirst({
      where: {
        projectId,
        hostId,
        leaseExpiresAt: { gt: now },
      },
      orderBy: { leaseAcquiredAt: "desc" },
      select: {
        leaseKey: true,
        ownerId: true,
        leaseExpiresAt: true,
      },
    }),
  ]);

  if (!activeJob && !activeLease) return null;

  return {
    activeJobId: activeJob?.id,
    activeJobStatus: activeJob?.status,
    activeCommand: activeJob?.command,
    leaseKey: activeLease?.leaseKey,
    blockingOwner: activeLease?.ownerId,
    leaseExpiresAt: activeLease?.leaseExpiresAt,
  };
}

export async function resolveExperimentHypothesisLink(params: {
  projectId: string;
  hypothesisId?: string;
  requireHypothesis: boolean;
}): Promise<SubmissionHypothesisResolution> {
  const requestedHypothesisId = params.hypothesisId;
  if (!params.requireHypothesis) {
    return { ok: true, hypothesisId: requestedHypothesisId || null, autoAttached: false };
  }

  const hypotheses = await prisma.researchHypothesis.findMany({
    where: { projectId: params.projectId },
    select: { id: true, statement: true, status: true, updatedAt: true, createdAt: true },
    orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
  });

  if (hypotheses.length === 0) {
    return {
      ok: false,
      message: "No hypotheses exist. Before running a full experiment (exp_*), create one with log_finding(type='hypothesis').",
    };
  }

  if (requestedHypothesisId) {
    const matches = hypotheses.filter((hypothesis) =>
      hypothesis.id === requestedHypothesisId || hypothesis.id.startsWith(requestedHypothesisId),
    );
    if (matches.length === 0) {
      return {
        ok: false,
        message: `Hypothesis "${requestedHypothesisId}" not found. Available:\n${hypotheses.map((h) => `- ${h.id}: [${h.status}] ${h.statement.slice(0, 80)}`).join("\n")}`,
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        message: `Hypothesis "${requestedHypothesisId}" matches multiple hypotheses. Use a longer ID.\n\nMatches:\n${matches.map((h) => `- ${h.id}: [${h.status}] ${h.statement.slice(0, 80)}`).join("\n")}`,
      };
    }

    const selected = matches[0];
    if (selected.status === "PROPOSED" || selected.status === "REVISED") {
      await prisma.researchHypothesis.update({
        where: { id: selected.id },
        data: { status: "TESTING" },
      });
    }
    return { ok: true, hypothesisId: selected.id, autoAttached: false };
  }

  const liveCandidates = hypotheses
    .filter((hypothesis) => ["TESTING", "REVISED", "PROPOSED"].includes(hypothesis.status))
    .sort((left, right) => {
      const priorityDiff = hypothesisPriority(right.status) - hypothesisPriority(left.status);
      if (priorityDiff !== 0) return priorityDiff;
      return right.updatedAt.getTime() - left.updatedAt.getTime();
    });

  if (liveCandidates.length === 1) {
    const selected = liveCandidates[0];
    if (selected.status === "PROPOSED" || selected.status === "REVISED") {
      await prisma.researchHypothesis.update({
        where: { id: selected.id },
        data: { status: "TESTING" },
      });
    }
    return {
      ok: true,
      hypothesisId: selected.id,
      autoAttached: true,
      note: `Auto-attached hypothesis ${selected.id.slice(0, 8)} [${selected.status}]: ${selected.statement.slice(0, 120)}`,
    };
  }

  const candidateList = (liveCandidates.length > 0 ? liveCandidates : hypotheses)
    .map((hypothesis) => `- ${hypothesis.id}: [${hypothesis.status}] ${hypothesis.statement.slice(0, 100)}`)
    .join("\n");

  return {
    ok: false,
    message: liveCandidates.length > 1
      ? `Multiple live hypotheses could own this experiment. Pass hypothesis_id explicitly.\n${candidateList}`
      : `No live hypothesis is available for automatic attachment. Pass hypothesis_id explicitly or revise/create a hypothesis first.\n${candidateList}`,
  };
}

export async function computeExperimentSubmissionReadiness(params: {
  projectId: string;
  command: string;
  scriptName: string;
  requireHypothesis: boolean;
  hypothesisId?: string;
  hostId?: string;
}): Promise<SubmissionReadiness> {
  const { projectId, command, scriptName, requireHypothesis, hypothesisId, hostId } = params;

  const [project, hypothesisCount, protocol, completedExperimentCount, completedAnalysisCount] = await Promise.all([
    prisma.researchProject.findUnique({
      where: { id: projectId },
      select: { currentPhase: true },
    }),
    prisma.researchHypothesis.count({ where: { projectId } }),
    getEvaluationProtocol(projectId),
    prisma.remoteJob.count({ where: { projectId, status: "COMPLETED" } }),
    prisma.researchStep.count({
      where: {
        iteration: { projectId },
        type: "analyze_results",
        status: "COMPLETED",
      },
    }),
  ]);

  const currentPhase = project?.currentPhase || "DISCOVERY";
  const issues: SubmissionReadinessIssue[] = [];

  const hypothesisResolution = await resolveExperimentHypothesisLink({
    projectId,
    hypothesisId,
    requireHypothesis,
  });

  if (!hypothesisResolution.ok) {
    issues.push({ code: "HYPOTHESIS", message: hypothesisResolution.message });
  }

  if (requireHypothesis && hypothesisCount === 0) {
    issues.push({
      code: "HYPOTHESIS",
      message: "No hypotheses exist. Create at least one hypothesis before running managed experiments.",
    });
  }

  if (protocol) {
    const protocolCheck = validateCommandAgainstEvaluationProtocol(command, protocol.protocol);
    if (!protocolCheck.ok && protocolCheck.reason) {
      issues.push({
        code: "PROTOCOL_COMMAND",
        message: `${protocolCheck.reason}\n\nUse show_evaluation_protocol to review the active protocol.`,
      });
    }
  }

  if (completedExperimentCount >= 3) {
    const requiredAnalyses = Math.floor(completedExperimentCount / 3);
    if (completedAnalysisCount < requiredAnalyses) {
      issues.push({
        code: "ANALYSIS_BACKLOG",
        message:
          `${completedExperimentCount} experiments completed but only ${completedAnalysisCount} analysis steps recorded.\n` +
          "Use update_hypothesis and log_finding(type=\"finding\") before submitting more experiments.",
      });
    }
  }

  if (/^exp_\d+/i.test(scriptName)) {
    const successfulPocs = await prisma.remoteJob.count({
      where: { projectId, status: "COMPLETED", command: { contains: "poc_" } },
    });
    if (successfulPocs === 0) {
      issues.push({
        code: "POC_REQUIRED",
        message: "No successful PoC experiments exist yet. Run and complete a poc_NNN script before scaling to an exp_NNN experiment.",
      });
    }
  }

  let workspaceGuard: WorkspaceBusyGuard | null = null;
  if (hostId) {
    workspaceGuard = await getActiveWorkspaceSubmissionGuard(projectId, hostId);
    if (workspaceGuard) {
      issues.push({
        code: "WORKSPACE_BUSY",
        message: formatWorkspaceBusySubmissionBlock("the selected host", workspaceGuard),
      });
    }
  }

  return {
    ok: issues.length === 0,
    currentPhase,
    resolvedHypothesisId: hypothesisResolution.ok ? hypothesisResolution.hypothesisId : null,
    autoAttachedHypothesis: hypothesisResolution.ok ? hypothesisResolution.autoAttached : false,
    hypothesisNote: hypothesisResolution.ok ? hypothesisResolution.note : undefined,
    issues,
    workspaceGuard,
  };
}

export function formatExperimentSubmissionReadiness(readiness: SubmissionReadiness, extraIssues: string[] = []) {
  const issueMessages = [
    ...readiness.issues.map((issue) => issue.message),
    ...extraIssues,
  ];

  if (issueMessages.length === 0) return null;

  const sections = [
    "BLOCKED — Experiment submission is not ready.",
    `Current phase: ${readiness.currentPhase}.`,
  ];

  if (readiness.hypothesisNote) {
    sections.push(readiness.hypothesisNote);
  }

  sections.push("");
  issueMessages.forEach((message, index) => {
    sections.push(`Issue ${index + 1}:`);
    sections.push(message);
    sections.push("");
  });

  return sections.join("\n").trim();
}
