import { prisma } from "@/lib/prisma";

export const CLAIM_COORDINATOR_STEP_TYPES = [
  "claim_needs_evidence",
  "claim_review_required",
  "claim_reproduction_required",
  "claim_experiment_required",
  "claim_memory_ready",
] as const;

export type ClaimCoordinatorStepType = (typeof CLAIM_COORDINATOR_STEP_TYPES)[number];

export interface ClaimCoordinatorTaskRef {
  id: string;
  role: string;
  status: string;
  createdAt: Date;
  completedAt: Date | null;
  claimIds: string[];
}

export interface ParsedCoordinatorStepInput {
  coordinatorKey: string | null;
  claimId: string | null;
  obligationType: string | null;
  experimentReason: string | null;
  taskRole: "reviewer" | "reproducer" | null;
  taskId: string | null;
  priority: number | null;
  blocking: boolean;
}

export function parseAgentTaskClaimIds(input: string | null): string[] {
  if (!input) return [];
  try {
    const parsed = JSON.parse(input) as {
      claimIds?: unknown;
      claims?: Array<{ id?: unknown }>;
      coordinator?: { claimId?: unknown };
    };
    const explicitClaimIds = Array.isArray(parsed.claimIds)
      ? parsed.claimIds.filter((value): value is string => typeof value === "string")
      : [];
    const embeddedClaimIds = Array.isArray(parsed.claims)
      ? parsed.claims
          .map((claim) => (typeof claim?.id === "string" ? claim.id : null))
          .filter((value): value is string => Boolean(value))
      : [];
    const coordinatorClaimId = typeof parsed.coordinator?.claimId === "string"
      ? [parsed.coordinator.claimId]
      : [];
    return Array.from(new Set([...explicitClaimIds, ...embeddedClaimIds, ...coordinatorClaimId]));
  } catch {
    return [];
  }
}

export function parseCoordinatorStepKey(input: string | null): string | null {
  return parseCoordinatorStepInput(input).coordinatorKey;
}

export function parseCoordinatorStepInput(input: string | null): ParsedCoordinatorStepInput {
  if (!input) {
    return {
      coordinatorKey: null,
      claimId: null,
      obligationType: null,
      experimentReason: null,
      taskRole: null,
      taskId: null,
      priority: null,
      blocking: false,
    };
  }
  try {
    const parsed = JSON.parse(input) as {
      coordinatorKey?: unknown;
      claimId?: unknown;
      obligationType?: unknown;
      experimentReason?: unknown;
      taskRole?: unknown;
      taskId?: unknown;
      priority?: unknown;
      blocking?: unknown;
    };
    return {
      coordinatorKey: typeof parsed.coordinatorKey === "string" ? parsed.coordinatorKey : null,
      claimId: typeof parsed.claimId === "string" ? parsed.claimId : null,
      obligationType: typeof parsed.obligationType === "string" ? parsed.obligationType : null,
      experimentReason: typeof parsed.experimentReason === "string" ? parsed.experimentReason : null,
      taskRole: parsed.taskRole === "reviewer" || parsed.taskRole === "reproducer" ? parsed.taskRole : null,
      taskId: typeof parsed.taskId === "string" ? parsed.taskId : null,
      priority: typeof parsed.priority === "number" ? parsed.priority : null,
      blocking: parsed.blocking === true,
    };
  } catch {
    return {
      coordinatorKey: null,
      claimId: null,
      obligationType: null,
      experimentReason: null,
      taskRole: null,
      taskId: null,
      priority: null,
      blocking: false,
    };
  }
}

export async function buildProjectClaimGraph(projectId: string, options?: { iterationId?: string }) {
  const project = await prisma.researchProject.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      title: true,
      userId: true,
      outputFolder: true,
      currentPhase: true,
      iterations: {
        where: options?.iterationId
          ? { id: options.iterationId }
          : { status: "ACTIVE" },
        orderBy: { number: "desc" },
        take: 1,
        select: { id: true, number: true, status: true },
      },
      claims: {
        where: {
          status: { not: "RETRACTED" },
        },
        include: {
          result: { select: { id: true, scriptName: true, verdict: true, metrics: true, createdAt: true } },
          hypothesis: { select: { id: true, statement: true, status: true } },
          task: { select: { id: true, role: true, status: true } },
          memories: { select: { id: true, status: true, createdAt: true } },
          assessments: {
            orderBy: { createdAt: "desc" },
            select: {
              id: true,
              actorRole: true,
              verdict: true,
              confidence: true,
              notes: true,
              metadata: true,
              createdAt: true,
              task: { select: { id: true, role: true, status: true } },
            },
          },
          evidence: {
            orderBy: { createdAt: "asc" },
            include: {
              task: { select: { id: true, role: true, status: true } },
              result: { select: { id: true, scriptName: true, verdict: true } },
              artifact: { select: { id: true, filename: true, path: true, keyTakeaway: true } },
              logEntry: { select: { id: true, type: true, content: true } },
              remoteJob: { select: { id: true, command: true, status: true } },
              paper: { select: { id: true, title: true, year: true } },
              hypothesis: { select: { id: true, statement: true, status: true } },
            },
          },
        },
        orderBy: [{ updatedAt: "desc" }, { createdAt: "desc" }],
      },
    },
  });

  if (!project) return null;

  const iterationId = project.iterations[0]?.id || null;

  const [tasks, steps] = await Promise.all([
    prisma.agentTask.findMany({
      where: {
        projectId,
        role: { in: ["reviewer", "reproducer"] },
      },
      select: {
        id: true,
        role: true,
        status: true,
        input: true,
        createdAt: true,
        completedAt: true,
      },
      orderBy: { createdAt: "desc" },
    }),
    iterationId
      ? prisma.researchStep.findMany({
          where: {
            iterationId,
            type: { in: [...CLAIM_COORDINATOR_STEP_TYPES] },
          },
          orderBy: { sortOrder: "asc" },
        })
      : Promise.resolve([]),
  ]);

  return {
    project: {
      id: project.id,
      title: project.title,
      userId: project.userId,
      currentPhase: project.currentPhase,
      outputFolder: project.outputFolder,
    },
    activeIteration: project.iterations[0] || null,
    claims: project.claims,
    tasks: tasks.map((task) => ({
      id: task.id,
      role: task.role,
      status: task.status,
      createdAt: task.createdAt,
      completedAt: task.completedAt,
      claimIds: parseAgentTaskClaimIds(task.input),
    })) satisfies ClaimCoordinatorTaskRef[],
    steps: steps.map((step) => ({
      ...step,
      coordinator: parseCoordinatorStepInput(step.input),
    })),
  };
}
