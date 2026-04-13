import path from "path";
import { prisma } from "@/lib/prisma";
import { getEvaluationProtocol, summarizeEvaluationProtocol } from "./evaluation-protocol";
import { attachClaimEvidence, syncClaimMemoryLifecycle } from "./claim-ledger";
import {
  claimEvidenceStrengthForExperiment,
  isClaimBearingExperiment,
  resolveExperimentContract,
} from "./experiment-contracts";
import {
  buildProjectClaimGraph,
  CLAIM_COORDINATOR_STEP_TYPES,
  parseAgentTaskClaimIds,
  parseCoordinatorStepInput,
  type ClaimCoordinatorStepType,
} from "./claim-graph";
import {
  computeClaimCoordinatorObligations,
  isCoordinatorObligationResolved,
  summarizeClaimForTask,
} from "./claim-obligations";
import { launchSubAgentTask } from "./sub-agent-launcher";
import { reserveNextResearchStepSortOrder } from "./step-order";

export interface SyncClaimCoordinatorOptions {
  workDir?: string;
  activeIterationId?: string;
  autoDispatch?: boolean;
  launchTaskRunner?: boolean;
}

export interface SyncClaimCoordinatorResult {
  activeIterationId: string;
  obligations: Array<{
    coordinatorKey: string;
    type: ClaimCoordinatorStepType;
    claimId: string;
    experimentReason?: "resolve_contestation" | "direct_validation";
    taskRole?: "reviewer" | "reproducer";
  }>;
  createdTaskIds: string[];
  createdStepIds: string[];
  updatedStepIds: string[];
  resolvedStepIds: string[];
}

export interface ClaimCoordinatorQueueItem {
  stepId: string;
  coordinatorKey: string;
  type: ClaimCoordinatorStepType;
  status: string;
  title: string;
  description: string | null;
  claimId: string | null;
  claimStatement: string | null;
  claimStatus: string | null;
  claimConfidence: string | null;
  experimentReason: string | null;
  taskRole: "reviewer" | "reproducer" | null;
  taskId: string | null;
  taskStatus: string | null;
  blocking: boolean;
  priority: number | null;
}

export interface ReconcileExperimentResultOptions {
  projectId: string;
  resultId: string;
  remoteJobId?: string | null;
  hypothesisId?: string | null;
  baselineResultId?: string | null;
  verdict: "better" | "worse" | "inconclusive" | "error";
  scriptName: string;
  explicitClaimIds?: string[];
}

export interface ReconcileExperimentResultResult {
  matchedClaimIds: string[];
  updatedClaimIds: string[];
  ambiguousClaimIds: string[];
}

function slugifyProjectTitle(title: string) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "research";
}

function confidenceRank(value: string) {
  if (value === "STRONG") return 3;
  if (value === "MODERATE") return 2;
  return 1;
}

function strongerConfidence(current: string, candidate: "PRELIMINARY" | "MODERATE" | "STRONG") {
  return confidenceRank(candidate) > confidenceRank(current) ? candidate : current;
}

function appendNote(existing: string | null | undefined, note: string) {
  if (!existing) return note;
  if (existing.includes(note)) return existing;
  return `${existing}\n\n${note}`;
}

async function ensureActiveIteration(projectId: string, preferredIterationId?: string | null) {
  if (preferredIterationId) {
    const preferred = await prisma.researchIteration.findUnique({
      where: { id: preferredIterationId },
      select: { id: true, number: true, status: true, projectId: true },
    });
    if (preferred && preferred.projectId === projectId) return preferred;
  }

  const current = await prisma.researchIteration.findFirst({
    where: { projectId, status: "ACTIVE" },
    orderBy: { number: "desc" },
    select: { id: true, number: true, status: true },
  });
  if (current) return current;

  const latest = await prisma.researchIteration.findFirst({
    where: { projectId },
    orderBy: { number: "desc" },
    select: { number: true },
  });

  return prisma.researchIteration.create({
    data: {
      projectId,
      number: (latest?.number || 0) + 1,
      goal: "Credibility coordination",
      status: "ACTIVE",
    },
    select: { id: true, number: true, status: true },
  });
}

function buildTaskContent(
  role: "reviewer" | "reproducer",
  claim: NonNullable<Awaited<ReturnType<typeof buildProjectClaimGraph>>>["claims"][number],
) {
  const evidence = summarizeClaimForTask(claim);
  const lines = [
    `Claim ID: ${claim.id}`,
    `Statement: ${claim.statement}`,
    `Current status: ${claim.status}`,
    `Confidence: ${claim.confidence}`,
    `Type: ${claim.type}`,
  ];

  if (claim.summary) lines.push(`Summary: ${claim.summary}`);
  if (claim.hypothesis) lines.push(`Hypothesis: ${claim.hypothesis.statement} (${claim.hypothesis.status})`);
  if (claim.result) {
    lines.push(`Result: ${claim.result.scriptName} (${claim.result.verdict || "unknown verdict"})`);
    if (claim.result.metrics) lines.push(`Metrics JSON: ${claim.result.metrics}`);
  }
  if (evidence.supporting.length > 0) {
    lines.push("", "Supporting evidence:");
    for (const item of evidence.supporting.slice(0, 8)) lines.push(`- ${item}`);
  }
  if (evidence.rebuttals.length > 0) {
    lines.push("", "Rebuttal evidence:");
    for (const item of evidence.rebuttals.slice(0, 8)) lines.push(`- ${item}`);
  }

  if (role === "reviewer") {
    lines.push(
      "",
      "Task: decide whether this claim should remain SUPPORTED or be downgraded to CONTESTED/RETRACTED. Ground your verdict in the attached evidence and literature checks.",
    );
  } else {
    lines.push(
      "",
      "Task: audit whether this reviewed supported claim is actually reproducible from the recorded workspace, runs, and evidence. Issue REPRODUCED only if the trail is strong enough.",
    );
  }

  return lines.join("\n");
}

async function launchAgentTask(taskId: string) {
  await launchSubAgentTask(taskId, "claim-coordinator");
}

function buildExperimentPrompt(params: {
  claim: NonNullable<Awaited<ReturnType<typeof buildProjectClaimGraph>>>["claims"][number];
  experimentReason: "resolve_contestation" | "direct_validation";
  protocolSummary: string | null;
}) {
  const { claim, experimentReason, protocolSummary } = params;
  const evidence = summarizeClaimForTask(claim);
  const lines = [
    `Design a targeted experiment for claim ${claim.id}.`,
    `Claim: ${claim.statement}`,
    `Current status: ${claim.status}`,
    `Type: ${claim.type}`,
  ];

  if (claim.summary) lines.push(`Summary: ${claim.summary}`);
  if (claim.hypothesis) lines.push(`Hypothesis: ${claim.hypothesis.statement}`);
  if (claim.result) lines.push(`Prior result: ${claim.result.scriptName} (${claim.result.verdict || "unknown verdict"})`);
  if (evidence.supporting.length > 0) {
    lines.push("Supporting evidence:");
    for (const item of evidence.supporting.slice(0, 5)) lines.push(`- ${item}`);
  }
  if (evidence.rebuttals.length > 0) {
    lines.push("Rebuttal evidence:");
    for (const item of evidence.rebuttals.slice(0, 5)) lines.push(`- ${item}`);
  }

  if (experimentReason === "resolve_contestation") {
    lines.push(
      "",
      "Design a follow-up experiment that resolves the contestation.",
      "Requirements:",
      "- isolate the disputed factor instead of broad reimplementation",
      "- include the most relevant baseline or previous method for direct comparison",
      "- define the exact metric outcome that would move the claim back to supported or force retraction",
      "- prefer the cheapest experiment that can falsify the disagreement",
    );
  } else {
    lines.push(
      "",
      "Design a direct validation experiment for this reviewed claim.",
      "Requirements:",
      "- measure the claim with direct experimental evidence rather than literature or notebook reasoning",
      "- choose a focused proof-of-concept if full training is unnecessary",
      "- include at least one comparison or ablation that would make the evidence interpretable",
    );
  }

  if (protocolSummary) {
    lines.push("", "Evaluation protocol:", protocolSummary);
  }

  lines.push(
    "",
    "Return publication-quality Python experiment code that fits the active protocol and updates this claim with quantitative evidence.",
    `When the result is recorded, pass claim_ids=["${claim.id}"] to record_result so the coordinator can reconcile the right claim deterministically.`,
  );

  return lines.join("\n");
}

export async function reconcileExperimentResultWithClaimCoordinator(
  params: ReconcileExperimentResultOptions,
): Promise<ReconcileExperimentResultResult> {
  if (params.verdict === "error") {
    return { matchedClaimIds: [], updatedClaimIds: [], ambiguousClaimIds: [] };
  }

  const resultRecord = await prisma.experimentResult.findUnique({
    where: { id: params.resultId },
    select: {
      experimentPurpose: true,
      grounding: true,
      claimEligibility: true,
      promotionPolicy: true,
      evidenceClass: true,
      scriptName: true,
    },
  });
  const resultContract = resolveExperimentContract({
    scriptName: resultRecord?.scriptName || params.scriptName,
    experimentPurpose: resultRecord?.experimentPurpose,
    grounding: resultRecord?.grounding,
    claimEligibility: resultRecord?.claimEligibility,
    promotionPolicy: resultRecord?.promotionPolicy,
    evidenceClass: resultRecord?.evidenceClass,
  });
  const claimBearingResult = isClaimBearingExperiment(resultContract);

  const graph = await buildProjectClaimGraph(params.projectId);
  if (!graph?.activeIteration?.id) {
    return { matchedClaimIds: [], updatedClaimIds: [], ambiguousClaimIds: [] };
  }

  const explicitClaimIds = Array.from(new Set((params.explicitClaimIds || []).filter(Boolean)));
  const activeExperimentSteps = graph.steps.filter((step) =>
    step.type === "claim_experiment_required"
    && !["COMPLETED", "FAILED", "SKIPPED"].includes(step.status)
    && step.coordinator.claimId
    && step.coordinator.experimentReason
  );
  if (activeExperimentSteps.length === 0) {
    return { matchedClaimIds: [], updatedClaimIds: [], ambiguousClaimIds: [] };
  }

  const claimById = new Map(graph.claims.map((claim) => [claim.id, claim]));
  const candidates = activeExperimentSteps.filter((step) => {
    const claimId = step.coordinator.claimId;
    const claim = claimId ? claimById.get(claimId) : undefined;
    if (!claim || !claimId) return false;
    if (explicitClaimIds.length > 0) return explicitClaimIds.includes(claimId);
    if (params.hypothesisId && claim.hypothesisId === params.hypothesisId) return true;
    if (params.baselineResultId && claim.resultId === params.baselineResultId) return true;
    return false;
  });

  if (explicitClaimIds.length === 0 && candidates.length > 1) {
    return {
      matchedClaimIds: [],
      updatedClaimIds: [],
      ambiguousClaimIds: Array.from(new Set(candidates.map((step) => step.coordinator.claimId!).filter(Boolean))),
    };
  }

  const matchedClaimIds: string[] = [];
  const updatedClaimIds: string[] = [];

  for (const step of candidates) {
    const claimId = step.coordinator.claimId!;
    const claim = claimById.get(claimId);
    const experimentReason = step.coordinator.experimentReason as "resolve_contestation" | "direct_validation";
    if (!claim) continue;

    const existingEvidence = claim.evidence.find((evidence) =>
      evidence.kind === "experiment_result"
      && evidence.resultId === params.resultId
    );
    if (!existingEvidence) {
      const supports = params.verdict === "better";
      await attachClaimEvidence(claim.id, {
        kind: "experiment_result",
        resultId: params.resultId,
        supports,
        strength: claimEvidenceStrengthForExperiment(resultContract, supports),
        rationale: experimentReason === "resolve_contestation"
          ? `${params.scriptName} ${supports ? "supported" : "challenged"} the contested claim via a targeted follow-up experiment.`
          : `${params.scriptName} ${supports ? "provided direct validation for" : "challenged"} the claim during coordinator-requested validation.`,
        locator: JSON.stringify({
          source: "claim_coordinator",
          coordinatorKey: step.coordinator.coordinatorKey,
          experimentReason,
          resultId: params.resultId,
          evidenceClass: resultContract.evidenceClass,
          claimEligibility: resultContract.claimEligibility,
        }),
      });
    }

    matchedClaimIds.push(claim.id);

    if (!claimBearingResult) {
      continue;
    }

    if (experimentReason === "direct_validation") {
      if (params.verdict === "better") {
        const nextConfidence = strongerConfidence(claim.confidence, "MODERATE");
        if (claim.status !== "SUPPORTED" || nextConfidence !== claim.confidence) {
          await prisma.researchClaim.update({
            where: { id: claim.id },
            data: {
              status: "SUPPORTED",
              confidence: nextConfidence,
              notes: appendNote(claim.notes, `Direct validation recorded via ${params.scriptName}.`),
            },
          });
          await syncClaimMemoryLifecycle(claim.id, "SUPPORTED");
          updatedClaimIds.push(claim.id);
        }
      } else {
        await prisma.researchClaim.update({
          where: { id: claim.id },
          data: {
            status: "CONTESTED",
            notes: appendNote(claim.notes, `Direct validation via ${params.scriptName} did not support the claim (${params.verdict}).`),
          },
        });
        await syncClaimMemoryLifecycle(claim.id, "CONTESTED");
        updatedClaimIds.push(claim.id);
      }
      continue;
    }

    if (params.verdict === "better") {
      await prisma.researchClaim.update({
        where: { id: claim.id },
        data: {
          status: "SUPPORTED",
          confidence: strongerConfidence(claim.confidence, "MODERATE"),
          notes: appendNote(claim.notes, `Contestation resolved in favor of the claim via ${params.scriptName}.`),
        },
      });
      await syncClaimMemoryLifecycle(claim.id, "SUPPORTED");
      updatedClaimIds.push(claim.id);
      continue;
    }

    if (params.verdict === "worse") {
      await prisma.researchClaim.update({
        where: { id: claim.id },
        data: {
          status: "RETRACTED",
          notes: appendNote(claim.notes, `Contestation resolved against the claim via ${params.scriptName}.`),
        },
      });
      await syncClaimMemoryLifecycle(claim.id, "RETRACTED");
      updatedClaimIds.push(claim.id);
    }
  }

  return {
    matchedClaimIds: Array.from(new Set(matchedClaimIds)),
    updatedClaimIds: Array.from(new Set(updatedClaimIds)),
    ambiguousClaimIds: [],
  };
}

export async function syncClaimCoordinator(
  projectId: string,
  options?: SyncClaimCoordinatorOptions,
): Promise<SyncClaimCoordinatorResult> {
  const iteration = await ensureActiveIteration(projectId, options?.activeIterationId);
  const graph = await buildProjectClaimGraph(projectId, { iterationId: iteration.id });
  if (!graph) {
    throw new Error(`Project not found: ${projectId}`);
  }

  const workDir = options?.workDir
    || graph.project.outputFolder
    || path.join(process.cwd(), "output", "research", `${slugifyProjectTitle(graph.project.title)}-${projectId.slice(0, 8)}`);
  const protocol = await getEvaluationProtocol(projectId);
  const protocolSummary = protocol ? summarizeEvaluationProtocol(protocol.protocol) : null;

  const obligations = computeClaimCoordinatorObligations(graph);
  const desiredByKey = new Map(obligations.map((obligation) => [obligation.coordinatorKey, obligation]));
  const createdTaskIds: string[] = [];
  const createdStepIds: string[] = [];
  const updatedStepIds: string[] = [];
  const resolvedStepIds: string[] = [];

  const allSteps = graph.steps;
  const openSteps = allSteps.filter((step) => !["COMPLETED", "FAILED", "SKIPPED"].includes(step.status));
  const stepByKey = new Map(
    openSteps
      .filter((step) => step.coordinator.coordinatorKey)
      .map((step) => [step.coordinator.coordinatorKey!, step]),
  );
  const claimById = new Map(graph.claims.map((claim) => [claim.id, claim]));
  const assignedTaskByKey = new Map<string, string>();
  for (const task of graph.tasks) {
    for (const claimId of task.claimIds) {
      assignedTaskByKey.set(`claim_review_required:${claimId}:${task.role}`, task.id);
      assignedTaskByKey.set(`claim_reproduction_required:${claimId}:${task.role}`, task.id);
    }
  }

  for (const obligation of obligations) {
    const claim = claimById.get(obligation.claimId);
    if (!claim) continue;

    let taskId: string | null = null;
    if (options?.autoDispatch && obligation.taskRole) {
      const assignedKey = `${obligation.type}:${obligation.claimId}:${obligation.taskRole}`;
      taskId = assignedTaskByKey.get(assignedKey) || null;
      if (!taskId) {
        const task = await prisma.agentTask.create({
          data: {
            projectId,
            role: obligation.taskRole,
            goal: obligation.taskRole === "reviewer"
              ? `Coordinator review: ${claim.statement.slice(0, 120)}`
              : `Coordinator reproduction: ${claim.statement.slice(0, 120)}`,
            status: "PENDING",
            input: JSON.stringify({
              content: buildTaskContent(obligation.taskRole, claim),
              focus: obligation.taskRole === "reviewer" ? "results" : "replication",
              userId: graph.project.userId,
              workDir: obligation.taskRole === "reproducer" ? workDir : undefined,
              claimIds: [claim.id],
              claims: [{
                id: claim.id,
                statement: claim.statement,
                status: claim.status,
                summary: claim.summary,
              }],
              coordinator: {
                source: "claim_coordinator",
                claimId: claim.id,
                obligationType: obligation.type,
              },
            }),
          },
        });
        taskId = task.id;
        createdTaskIds.push(task.id);
        assignedTaskByKey.set(assignedKey, task.id);
      }
    }

    const shouldLaunchTask = !!taskId
      && createdTaskIds.includes(taskId)
      && options?.launchTaskRunner !== false;

    const stepInput = JSON.stringify({
      coordinatorKey: obligation.coordinatorKey,
      claimId: obligation.claimId,
      obligationType: obligation.type,
      experimentReason: obligation.experimentReason || null,
      taskRole: obligation.taskRole || null,
      taskId,
      priority: obligation.priority,
      blocking: obligation.blocking,
      prompt: obligation.type === "claim_experiment_required"
        ? buildExperimentPrompt({
            claim,
            experimentReason: obligation.experimentReason || "direct_validation",
            protocolSummary,
          })
        : undefined,
    });
    const stepOutput = taskId ? JSON.stringify({ taskId, autoDispatched: true }) : null;
    const existingStep = stepByKey.get(obligation.coordinatorKey);

    if (existingStep) {
      const patch: Record<string, unknown> = {};
      if (existingStep.title !== obligation.title) patch.title = obligation.title;
      if (existingStep.description !== obligation.description) patch.description = obligation.description;
      if (existingStep.status !== obligation.desiredStatus) patch.status = obligation.desiredStatus;
      if (existingStep.input !== stepInput) patch.input = stepInput;
      if (existingStep.output !== stepOutput) patch.output = stepOutput;
      if (Object.keys(patch).length > 0) {
        if (patch.status && patch.status !== "COMPLETED") patch.completedAt = null;
        await prisma.researchStep.update({
          where: { id: existingStep.id },
          data: patch,
        });
        updatedStepIds.push(existingStep.id);
      }
      if (shouldLaunchTask && taskId) {
        await launchAgentTask(taskId);
      }
      continue;
    }

    const sortOrder = await reserveNextResearchStepSortOrder(prisma, iteration.id);
    const created = await prisma.researchStep.create({
      data: {
        iterationId: iteration.id,
        type: obligation.type,
        title: obligation.title,
        description: obligation.description,
        input: stepInput,
        output: stepOutput,
        status: obligation.desiredStatus,
        sortOrder,
      },
    });
    createdStepIds.push(created.id);
    if (shouldLaunchTask && taskId) {
      await launchAgentTask(taskId);
    }
  }

  for (const step of openSteps) {
    const coordinatorKey = step.coordinator.coordinatorKey;
    if (!coordinatorKey || desiredByKey.has(coordinatorKey)) continue;
    if (!(CLAIM_COORDINATOR_STEP_TYPES as readonly string[]).includes(step.type)) continue;

    const inputClaimId = step.coordinator.claimId;
    const claim = inputClaimId ? claimById.get(inputClaimId) : undefined;
    const resolved = isCoordinatorObligationResolved(
      claim,
      step.type as ClaimCoordinatorStepType,
      step.coordinator.experimentReason,
    );

    await prisma.researchStep.update({
      where: { id: step.id },
      data: {
        status: resolved ? "COMPLETED" : "SKIPPED",
        output: JSON.stringify({
          resolution: resolved ? "resolved" : "dropped",
          resolvedAt: new Date().toISOString(),
          coordinatorKey,
        }),
        completedAt: new Date(),
      },
    });
    resolvedStepIds.push(step.id);
  }

  return {
    activeIterationId: iteration.id,
    obligations: obligations.map((obligation) => ({
      coordinatorKey: obligation.coordinatorKey,
      type: obligation.type,
      claimId: obligation.claimId,
      experimentReason: obligation.experimentReason,
      taskRole: obligation.taskRole,
    })),
    createdTaskIds,
    createdStepIds,
    updatedStepIds,
    resolvedStepIds,
  };
}

export function extractCoordinatorTaskClaimIds(input: string | null) {
  return parseAgentTaskClaimIds(input);
}

export function extractCoordinatorStepKey(input: string | null) {
  return parseCoordinatorStepInput(input).coordinatorKey;
}

export async function listClaimCoordinatorQueue(
  projectId: string,
  options?: { activeOnly?: boolean; iterationId?: string | null },
): Promise<ClaimCoordinatorQueueItem[]> {
  const graph = await buildProjectClaimGraph(projectId, { iterationId: options?.iterationId || undefined });
  if (!graph) return [];

  const taskById = new Map(graph.tasks.map((task) => [task.id, task]));
  const claimById = new Map(graph.claims.map((claim) => [claim.id, claim]));

  return graph.steps
    .filter((step) => (CLAIM_COORDINATOR_STEP_TYPES as readonly string[]).includes(step.type))
    .filter((step) => !options?.activeOnly || !["COMPLETED", "FAILED", "SKIPPED"].includes(step.status))
    .map((step) => {
      const coordinator = step.coordinator;
      const claim = coordinator.claimId ? claimById.get(coordinator.claimId) : undefined;
      const task = coordinator.taskId ? taskById.get(coordinator.taskId) : undefined;
      return {
        stepId: step.id,
        coordinatorKey: coordinator.coordinatorKey || `${step.type}:${step.id}`,
        type: step.type as ClaimCoordinatorStepType,
        status: step.status,
        title: step.title,
        description: step.description,
        claimId: coordinator.claimId,
        claimStatement: claim?.statement || null,
        claimStatus: claim?.status || null,
        claimConfidence: claim?.confidence || null,
        experimentReason: coordinator.experimentReason,
        taskRole: coordinator.taskRole,
        taskId: coordinator.taskId,
        taskStatus: task?.status || null,
        blocking: coordinator.blocking,
        priority: coordinator.priority,
      } satisfies ClaimCoordinatorQueueItem;
    })
    .sort((left, right) => (right.priority || 0) - (left.priority || 0));
}

export async function getBlockingClaimCoordinatorQueue(
  projectId: string,
  options?: { iterationId?: string | null },
) {
  const queue = await listClaimCoordinatorQueue(projectId, {
    activeOnly: true,
    iterationId: options?.iterationId,
  });
  return queue.filter((item) => item.blocking);
}

export function summarizeBlockingClaimCoordinatorQueue(queue: ClaimCoordinatorQueueItem[], limit = 2) {
  if (queue.length === 0) return "";
  const preview = queue
    .slice(0, limit)
    .map((item) => item.title)
    .join("; ");
  const remainder = queue.length > limit ? ` (+${queue.length - limit} more)` : "";
  return `${preview}${remainder}`;
}
