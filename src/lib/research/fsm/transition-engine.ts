// ---------------------------------------------------------------------------
// FSM Transition Engine
// DB-backed transition engine that fetches guard context, evaluates guards,
// and executes auto-transitions for project state advancement.
// ---------------------------------------------------------------------------

import { prisma } from "@/lib/prisma";
import { withFsmBypassAsync } from "./state-guard";
import type {
  ProjectState,
  GuardResult,
  TransitionRecord,
} from "./types";
import { PROJECT_TRANSITIONS } from "./types";
import {
  evaluateTransitionGuard,
  AUTO_TRANSITIONS,
  type DiscoveryToHypothesisContext,
  type HypothesisToDesignContext,
  type DesignToExecutionContext,
  type ExecutionToAnalysisContext,
  type AnalysisToDecisionContext,
  type DecisionToCompleteContext,
  type DecisionToDesignContext,
  type GuardContext,
} from "./project-fsm";
import { getEvaluationProtocol } from "../evaluation-protocol";

// ---- Guard Context Fetching -----------------------------------------------

/**
 * Fetch the guard context for a specific project transition from the database.
 *
 * Uses `Promise.all` for parallel queries within each transition. Returns the
 * context object that the pure guard evaluator needs.
 *
 * Backward transitions return an empty object (guards always pass).
 */
export async function fetchGuardContext(
  projectId: string,
  from: ProjectState,
  to: ProjectState,
): Promise<GuardContext> {
  const key = `${from}->${to}`;

  switch (key) {
    case "DISCOVERY->HYPOTHESIS": {
      // Fetch project to get collectionId for paper counts
      const project = await prisma.researchProject.findUnique({
        where: { id: projectId },
        select: { collectionId: true },
      });

      const [paperCount, unprocessedPaperCount, scoutCount, completedSynthesisCount] =
        await Promise.all([
          // Papers in the project's collection
          project?.collectionId
            ? prisma.collectionPaper.count({
                where: { collectionId: project.collectionId },
              })
            : Promise.resolve(0),
          // Unprocessed papers in the collection
          project?.collectionId
            ? prisma.collectionPaper.count({
                where: {
                  collectionId: project.collectionId,
                  paper: { processingStatus: { not: "COMPLETED" } },
                },
              })
            : Promise.resolve(0),
          // Scout tasks for this project
          prisma.agentTask.count({
            where: { projectId, role: "scout" },
          }),
          // Completed synthesizer tasks
          prisma.agentTask.count({
            where: { projectId, role: "synthesizer", status: "COMPLETED" },
          }),
        ]);

      return {
        paperCount,
        unprocessedPaperCount,
        scoutCount,
        completedSynthesisCount,
      } satisfies DiscoveryToHypothesisContext;
    }

    case "HYPOTHESIS->DESIGN": {
      const [hypothesisCount, approachCount] = await Promise.all([
        prisma.researchHypothesis.count({ where: { projectId } }),
        prisma.approachBranch.count({ where: { projectId } }),
      ]);

      return {
        hypothesisCount,
        approachCount,
      } satisfies HypothesisToDesignContext;
    }

    case "DESIGN->EXECUTION": {
      const [project, evalProtocol, activeHypothesisCount, readyIntentCount] = await Promise.all([
        prisma.researchProject.findUnique({
          where: { id: projectId },
          select: { metricSchema: true },
        }),
        getEvaluationProtocol(projectId),
        prisma.researchHypothesis.count({
          where: {
            projectId,
            status: { in: ["ACTIVE", "TESTING", "PROPOSED"] },
          },
        }),
        prisma.experimentIntent.count({
          where: { projectId, status: "READY" },
        }),
      ]);

      return {
        metricSchemaDefined: project?.metricSchema != null && project.metricSchema !== "",
        evaluationProtocolExists: evalProtocol != null,
        activeHypothesisCount,
        readyIntentCount,
      } satisfies DesignToExecutionContext;
    }

    case "EXECUTION->ANALYSIS": {
      // Find when we last entered EXECUTION to only count NEW completed jobs
      const lastExecutionEntry = await prisma.researchLogEntry.findFirst({
        where: {
          projectId,
          type: "fsm_transition",
          content: { contains: "-> EXECUTION" },
        },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      });
      const sinceDate = lastExecutionEntry?.createdAt || new Date(0);

      const [doneRunCount, doneNonSmokeRunCount, newDoneNonSmokeRunCount, satisfiedIntentCount] = await Promise.all([
        prisma.remoteJob.count({
          where: { projectId, status: "COMPLETED" },
        }),
        prisma.remoteJob.count({
          where: { projectId, status: "COMPLETED", experimentPurpose: { not: "SMOKE" } },
        }),
        prisma.remoteJob.count({
          where: {
            projectId,
            status: "COMPLETED",
            experimentPurpose: { not: "SMOKE" },
            completedAt: { gt: sinceDate },
          },
        }),
        prisma.experimentIntent.count({
          where: { projectId, status: "SATISFIED" },
        }),
      ]);
      return { doneRunCount, doneNonSmokeRunCount, newDoneNonSmokeRunCount, satisfiedIntentCount } satisfies ExecutionToAnalysisContext;
    }

    case "ANALYSIS->DECISION": {
      const [updatedHypothesisCount, terminalHypothesisCount, claimCount] =
        await Promise.all([
          // Hypotheses NOT in initial states (have been updated/adjudicated)
          prisma.researchHypothesis.count({
            where: {
              projectId,
              status: { notIn: ["PROPOSED", "ACTIVE", "TESTING"] },
            },
          }),
          // Hypotheses in terminal/decided states
          prisma.researchHypothesis.count({
            where: {
              projectId,
              status: { in: ["SUPPORTED", "REFUTED", "REVISED"] },
            },
          }),
          prisma.researchClaim.count({ where: { projectId } }),
        ]);

      return {
        updatedHypothesisCount,
        terminalHypothesisCount,
        claimCount,
      } satisfies AnalysisToDecisionContext;
    }

    case "DECISION->COMPLETE": {
      const [activeOrEvaluatingHypothesisCount, supportedOrRetiredCount] =
        await Promise.all([
          // Hypotheses still in active/testing/proposed state
          prisma.researchHypothesis.count({
            where: {
              projectId,
              status: { in: ["ACTIVE", "TESTING", "PROPOSED"] },
            },
          }),
          // Hypotheses that reached a final verdict
          prisma.researchHypothesis.count({
            where: {
              projectId,
              status: { in: ["SUPPORTED", "REFUTED"] },
            },
          }),
        ]);

      return {
        activeOrEvaluatingHypothesisCount,
        openCoordinatorObligations: 0, // No coordinator obligation tracking yet
        supportedOrRetiredCount,
      } satisfies DecisionToCompleteContext;
    }

    case "DECISION->DESIGN": {
      const viableHypothesisCount = await prisma.researchHypothesis.count({
        where: {
          projectId,
          status: { in: ["ACTIVE", "TESTING", "REVISED"] },
        },
      });

      return {
        viableHypothesisCount,
        coordinatorRequiredExperiments: 0, // No coordinator tracking yet
      } satisfies DecisionToDesignContext;
    }

    // Backward transitions — no context needed
    case "HYPOTHESIS->DISCOVERY":
    case "DESIGN->HYPOTHESIS":
    default:
      return {} as GuardContext;
  }
}

// ---- Auto-Transition Engine -----------------------------------------------

/**
 * Attempt to automatically advance the project to the next state.
 *
 * Called after relevant DB writes (e.g., paper import, hypothesis creation).
 * Checks all valid forward transitions from the current state, evaluates
 * guards, and executes the first one that passes.
 *
 * Returns the TransitionRecord if a transition fired, or null if nothing changed.
 */
export async function attemptAutoTransition(
  projectId: string,
): Promise<TransitionRecord | null> {
  const project = await prisma.researchProject.findUnique({
    where: { id: projectId },
    select: { currentPhase: true, status: true },
  });

  if (!project) return null;

  // Only auto-transition active projects
  if (project.status !== "ACTIVE") return null;

  const currentState = project.currentPhase as ProjectState;

  // Terminal state — nothing to do
  if (currentState === "COMPLETE") return null;

  const validTargets = PROJECT_TRANSITIONS[currentState];

  for (const targetState of validTargets) {
    const transitionKey = `${currentState}->${targetState}`;

    // Skip transitions not eligible for auto-advancement
    if (!AUTO_TRANSITIONS[transitionKey]) continue;

    const context = await fetchGuardContext(projectId, currentState, targetState);
    const guardResult = await evaluateTransitionGuard(
      projectId,
      currentState,
      targetState,
      context,
    );

    if (!guardResult.satisfied) continue;

    // Guard passed — execute the transition inside a transaction
    const record: TransitionRecord = {
      projectId,
      domain: "project",
      entityId: projectId,
      from: currentState,
      to: targetState,
      trigger: "auto",
      basis: `Guards satisfied for ${transitionKey}`,
      guardsEvaluated: Object.fromEntries(
        Object.entries(guardResult.checks).map(([k, v]) => [k, v.passed]),
      ),
    };

    await withFsmBypassAsync(() =>
      prisma.$transaction([
        prisma.researchProject.update({
          where: { id: projectId },
          data: { currentPhase: targetState },
        }),
        prisma.researchLogEntry.create({
          data: {
            projectId,
            type: "fsm_transition",
            content: `Auto-transition: ${currentState} -> ${targetState}`,
            metadata: JSON.stringify(record),
          },
        }),
      ]),
    );

    return record;
  }

  return null;
}

// ---- Diagnostic Report ----------------------------------------------------

export interface ProjectStateReport {
  state: ProjectState;
  nextStates: ProjectState[];
  guardResults: Record<string, GuardResult>;
}

/**
 * Generate a diagnostic report of the project's current state and which
 * transitions are available (and whether their guards are satisfied).
 */
export async function getProjectStateReport(
  projectId: string,
): Promise<ProjectStateReport> {
  const project = await prisma.researchProject.findUnique({
    where: { id: projectId },
    select: { currentPhase: true },
  });

  if (!project) {
    return {
      state: "DISCOVERY" as ProjectState,
      nextStates: [],
      guardResults: {},
    };
  }

  const currentState = project.currentPhase as ProjectState;
  const validTargets = PROJECT_TRANSITIONS[currentState] ?? [];

  const guardEntries = await Promise.all(
    validTargets.map(async (target) => {
      const context = await fetchGuardContext(projectId, currentState, target);
      const result = await evaluateTransitionGuard(
        projectId,
        currentState,
        target,
        context,
      );
      return [`${currentState}->${target}`, result] as const;
    }),
  );

  return {
    state: currentState,
    nextStates: [...validTargets],
    guardResults: Object.fromEntries(guardEntries),
  };
}
