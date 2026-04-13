import { claimHasAssessmentFromRole } from "./claim-ledger";
import type { buildProjectClaimGraph, ClaimCoordinatorStepType, ClaimCoordinatorTaskRef } from "./claim-graph";

type ClaimGraph = NonNullable<Awaited<ReturnType<typeof buildProjectClaimGraph>>>;
type ClaimNode = ClaimGraph["claims"][number];

export interface ClaimCoordinatorObligation {
  coordinatorKey: string;
  type: ClaimCoordinatorStepType;
  claimId: string;
  title: string;
  description: string;
  priority: number;
  desiredStatus: "PROPOSED" | "RUNNING";
  experimentReason?: "resolve_contestation" | "direct_validation";
  taskRole?: "reviewer" | "reproducer";
  blocking: boolean;
}

function directSupportCount(claim: ClaimNode) {
  return claim.evidence.filter((evidence) => evidence.supports && evidence.strength === "DIRECT").length;
}

function supportCount(claim: ClaimNode) {
  return claim.evidence.filter((evidence) => evidence.supports).length;
}

function rebuttalCount(claim: ClaimNode) {
  return claim.evidence.filter((evidence) => !evidence.supports).length;
}

function experimentalSupportCount(claim: ClaimNode) {
  const fromEvidence = claim.evidence.filter((evidence) => evidence.supports && evidence.kind === "experiment_result").length;
  return fromEvidence + (claim.resultId ? 1 : 0);
}

function confidenceWeight(confidence: string) {
  if (confidence === "STRONG") return 18;
  if (confidence === "MODERATE") return 10;
  return 4;
}

function claimPriorityScore(claim: ClaimNode) {
  let score = 0;
  if (claim.resultId) score += 22;
  if (claim.hypothesisId) score += 10;
  if (claim.type === "comparison") score += 10;
  if (claim.type === "hypothesis_assessment") score += 8;
  if (claim.type === "reproduction") score += 6;
  score += directSupportCount(claim) * 8;
  score += supportCount(claim) * 4;
  score += confidenceWeight(claim.confidence);
  score -= rebuttalCount(claim) * 20;
  score += Math.round(claim.updatedAt.getTime() / 1000000000);
  return score;
}

function claimShortTitle(claim: ClaimNode) {
  return claim.statement.length > 72 ? `${claim.statement.slice(0, 69).trimEnd()}...` : claim.statement;
}

function hasAssessmentFromRole(claim: ClaimNode, role: "reviewer" | "reproducer") {
  return claimHasAssessmentFromRole(claim, role);
}

function hasTaskAssignment(tasks: ClaimCoordinatorTaskRef[], claimId: string, role: "reviewer" | "reproducer") {
  return tasks.some((task) =>
    task.role === role
    && task.status !== "FAILED"
    && task.claimIds.includes(claimId)
  );
}

function isMemoryEligible(claim: ClaimNode) {
  const hasApprovedMemory = claim.memories.some((memory) => memory.status === "APPROVED");
  const hasCandidateMemory = claim.memories.some((memory) => memory.status === "CANDIDATE");
  if (supportCount(claim) === 0) return false;
  if (rebuttalCount(claim) > 0) return false;
  if (claim.status === "REPRODUCED") return !hasApprovedMemory;
  if (claim.status !== "SUPPORTED") return false;
  if (!hasAssessmentFromRole(claim, "reviewer")) return false;
  return !hasCandidateMemory && !hasApprovedMemory;
}

function contestedExperimentCandidate(claim: ClaimNode) {
  if (claim.status !== "CONTESTED") return false;
  if (!claim.hypothesisId && !claim.resultId) return false;
  return true;
}

function directValidationCandidate(claim: ClaimNode) {
  if (claim.status !== "SUPPORTED") return false;
  if (!claim.hypothesisId) return false;
  if (supportCount(claim) === 0) return false;
  if (!hasAssessmentFromRole(claim, "reviewer")) return false;
  if (experimentalSupportCount(claim) > 0) return false;
  return true;
}

function reviewCandidate(claim: ClaimNode, tasks: ClaimCoordinatorTaskRef[]) {
  if (claim.status !== "SUPPORTED") return false;
  if (supportCount(claim) === 0) return false;
  if (hasAssessmentFromRole(claim, "reviewer") || hasAssessmentFromRole(claim, "reproducer")) return false;
  if (hasTaskAssignment(tasks, claim.id, "reviewer")) return false;
  return true;
}

function reproductionCandidate(claim: ClaimNode, tasks: ClaimCoordinatorTaskRef[]) {
  if (claim.status !== "SUPPORTED") return false;
  if (supportCount(claim) === 0) return false;
  if (!hasAssessmentFromRole(claim, "reviewer")) return false;
  if (hasAssessmentFromRole(claim, "reproducer")) return false;
  if (hasTaskAssignment(tasks, claim.id, "reproducer")) return false;
  if (rebuttalCount(claim) > 0) return false;
  return true;
}

function groupKey(claim: ClaimNode) {
  if (claim.hypothesisId) return `hypothesis:${claim.hypothesisId}`;
  if (claim.resultId) return `result:${claim.resultId}`;
  return "project";
}

export function computeClaimCoordinatorObligations(graph: ClaimGraph): ClaimCoordinatorObligation[] {
  const obligations: ClaimCoordinatorObligation[] = [];
  const claims = graph.claims;

  for (const claim of claims) {
    if (
      ["SUPPORTED", "REPRODUCED"].includes(claim.status)
      && supportCount(claim) === 0
    ) {
      obligations.push({
        coordinatorKey: `claim_needs_evidence:${claim.id}`,
        type: "claim_needs_evidence",
        claimId: claim.id,
        title: `Evidence required: ${claimShortTitle(claim)}`,
        description: "This claim is marked supported but has no supporting evidence rows. Attach direct evidence before it can advance.",
        priority: claimPriorityScore(claim) + 100,
        desiredStatus: "PROPOSED",
        blocking: true,
      });
    }
  }

  const reviewObligations = claims
    .filter((claim) => reviewCandidate(claim, graph.tasks))
    .sort((left, right) => claimPriorityScore(right) - claimPriorityScore(left))
    .slice(0, 3)
    .map((claim, index) => ({
      coordinatorKey: `claim_review_required:${claim.id}`,
      type: "claim_review_required" as const,
      claimId: claim.id,
      title: `Review required: ${claimShortTitle(claim)}`,
      description: "The coordinator selected this supported claim for adversarial review before reflection or promotion.",
      priority: 300 - index,
      desiredStatus: "RUNNING" as const,
      taskRole: "reviewer" as const,
      blocking: true,
    }));
  obligations.push(...reviewObligations);

  const reproductionByGroup = new Map<string, ClaimNode>();
  for (const claim of claims
    .filter((candidate) => reproductionCandidate(candidate, graph.tasks))
    .sort((left, right) => claimPriorityScore(right) - claimPriorityScore(left))) {
    const key = groupKey(claim);
    if (!reproductionByGroup.has(key)) reproductionByGroup.set(key, claim);
  }
  Array.from(reproductionByGroup.values())
    .slice(0, 3)
    .forEach((claim, index) => {
      obligations.push({
        coordinatorKey: `claim_reproduction_required:${claim.id}`,
        type: "claim_reproduction_required",
        claimId: claim.id,
        title: `Reproduction required: ${claimShortTitle(claim)}`,
        description: "This is the strongest reviewed supported claim in its group and should be audited by a reproducer.",
        priority: 200 - index,
        desiredStatus: "RUNNING",
        taskRole: "reproducer",
        blocking: true,
      });
    });

  const contestedExperimentObligations = claims
    .filter((claim) => contestedExperimentCandidate(claim))
    .sort((left, right) => claimPriorityScore(right) - claimPriorityScore(left))
    .slice(0, 3)
    .map((claim, index) => ({
      coordinatorKey: `claim_experiment_required:${claim.id}:resolve_contestation`,
      type: "claim_experiment_required" as const,
      claimId: claim.id,
      title: `Experiment required: resolve ${claimShortTitle(claim)}`,
      description: "This claim is contested. Design a targeted follow-up experiment that isolates the disputed factor, reruns the relevant baseline, and updates the claim with quantitative evidence.",
      priority: 170 - index,
      desiredStatus: "PROPOSED" as const,
      experimentReason: "resolve_contestation" as const,
      blocking: true,
    }));
  obligations.push(...contestedExperimentObligations);

  const directValidationObligations = claims
    .filter((claim) => directValidationCandidate(claim))
    .sort((left, right) => claimPriorityScore(right) - claimPriorityScore(left))
    .slice(0, 3)
    .map((claim, index) => ({
      coordinatorKey: `claim_experiment_required:${claim.id}:direct_validation`,
      type: "claim_experiment_required" as const,
      claimId: claim.id,
      title: `Experiment required: validate ${claimShortTitle(claim)}`,
      description: "This claim has been reviewed, but it still lacks direct experimental evidence. Design a focused validation experiment before treating it as durable knowledge.",
      priority: 160 - index,
      desiredStatus: "PROPOSED" as const,
      experimentReason: "direct_validation" as const,
      blocking: true,
    }));
  obligations.push(...directValidationObligations);

  for (const claim of claims
    .filter((candidate) => isMemoryEligible(candidate))
    .sort((left, right) => claimPriorityScore(right) - claimPriorityScore(left))
    .slice(0, 5)) {
    obligations.push({
      coordinatorKey: `claim_memory_ready:${claim.id}`,
      type: "claim_memory_ready",
      claimId: claim.id,
      title: `Ready for memory: ${claimShortTitle(claim)}`,
      description: claim.status === "REPRODUCED"
        ? "This reproduced claim is ready for durable approved memory."
        : "This reviewed supported claim is ready to be distilled into candidate memory.",
      priority: claimPriorityScore(claim),
      desiredStatus: "PROPOSED",
      blocking: false,
    });
  }

  return obligations.sort((left, right) => right.priority - left.priority);
}

export function isCoordinatorObligationResolved(
  claim: ClaimNode | undefined,
  stepType: ClaimCoordinatorStepType,
  experimentReason?: string | null,
) {
  if (!claim) return true;

  if (stepType === "claim_needs_evidence") {
    return !["SUPPORTED", "REPRODUCED"].includes(claim.status) || supportCount(claim) > 0;
  }
  if (stepType === "claim_review_required") {
    return claim.status !== "SUPPORTED" || hasAssessmentFromRole(claim, "reviewer") || hasAssessmentFromRole(claim, "reproducer");
  }
  if (stepType === "claim_reproduction_required") {
    return claim.status !== "SUPPORTED" || hasAssessmentFromRole(claim, "reproducer");
  }
  if (stepType === "claim_experiment_required") {
    if (experimentReason === "resolve_contestation") {
      if (claim.status === "CONTESTED") return false;
      if (claim.status === "SUPPORTED") return experimentalSupportCount(claim) > 0;
      return true;
    }
    return claim.status !== "SUPPORTED" || experimentalSupportCount(claim) > 0;
  }
  return !isMemoryEligible(claim);
}

export function summarizeClaimForTask(claim: ClaimNode) {
  const supporting = claim.evidence
    .filter((evidence) => evidence.supports)
    .map((evidence) => {
      if (evidence.kind === "experiment_result" && evidence.result) {
        return `${evidence.kind}: ${evidence.result.scriptName} (${evidence.result.verdict || "unknown verdict"})`;
      }
      if (evidence.kind === "artifact" && evidence.artifact) {
        return `${evidence.kind}: ${evidence.artifact.filename}`;
      }
      if (evidence.kind === "remote_job" && evidence.remoteJob) {
        return `${evidence.kind}: ${evidence.remoteJob.command}`;
      }
      if (evidence.kind === "log_entry" && evidence.logEntry) {
        return `${evidence.kind}: ${evidence.logEntry.content.slice(0, 160)}`;
      }
      if (evidence.kind === "paper" && evidence.paper) {
        return `${evidence.kind}: ${evidence.paper.title}`;
      }
      if (evidence.kind === "hypothesis" && evidence.hypothesis) {
        return `${evidence.kind}: ${evidence.hypothesis.statement}`;
      }
      if (evidence.kind === "agent_task" && evidence.task) {
        return `${evidence.kind}: ${evidence.task.role} (${evidence.task.status})`;
      }
      return evidence.kind;
    });
  const rebuttals = claim.evidence
    .filter((evidence) => !evidence.supports)
    .map((evidence) => evidence.rationale || evidence.kind);

  return {
    supportCount: supporting.length,
    rebuttalCount: rebuttals.length,
    supporting,
    rebuttals,
  };
}
