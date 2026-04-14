// ---------------------------------------------------------------------------
// Project FSM Guard Evaluators
// Pure-function guards for each project state transition. Guards receive
// pre-fetched context (no DB access) and return a GuardResult.
// ---------------------------------------------------------------------------

import type { ProjectState, GuardResult } from "./types";
import { PROJECT_TRANSITIONS } from "./types";

// ---- Guard Context Types --------------------------------------------------

export interface DiscoveryToHypothesisContext {
  paperCount: number;
  unprocessedPaperCount: number;
  completedSynthesisCount: number;
  scoutCount: number;
}

export interface HypothesisToDesignContext {
  hypothesisCount: number;
  approachCount: number;
}

export interface DesignToExecutionContext {
  metricSchemaDefined: boolean;
  evaluationProtocolExists: boolean;
  activeHypothesisCount: number;
  readyIntentCount: number;
}

export interface ExecutionToAnalysisContext {
  doneRunCount: number;
  doneNonSmokeRunCount: number;
  /** Jobs completed since the last time we entered EXECUTION (prevents instant re-transition) */
  newDoneNonSmokeRunCount: number;
  satisfiedIntentCount: number;
}

export interface AnalysisToDecisionContext {
  updatedHypothesisCount: number;
  claimCount: number;
  terminalHypothesisCount: number;
}

export interface DecisionToCompleteContext {
  activeOrEvaluatingHypothesisCount: number;
  openCoordinatorObligations: number;
  supportedOrRetiredCount: number;
  groundedSummaryCompiled: boolean;
  memoryPromotionsPending: number;
}

export interface DecisionToDesignContext {
  viableHypothesisCount: number;
  coordinatorRequiredExperiments: number;
}

export type GuardContext =
  | DiscoveryToHypothesisContext
  | HypothesisToDesignContext
  | DesignToExecutionContext
  | ExecutionToAnalysisContext
  | AnalysisToDecisionContext
  | DecisionToCompleteContext
  | DecisionToDesignContext;

// ---- Auto-Transition Map --------------------------------------------------

/**
 * Transitions eligible for automatic advancement (no explicit agent/user
 * action required beyond satisfying guards).
 */
export const AUTO_TRANSITIONS: Record<string, boolean> = {
  "DISCOVERY->HYPOTHESIS": true,
  "HYPOTHESIS->DESIGN": true,
  "DESIGN->EXECUTION": true,
  "EXECUTION->ANALYSIS": true,
  "ANALYSIS->DECISION": true,
  "DECISION->COMPLETE": true,
  "DECISION->DESIGN": true,
  "DECISION->HYPOTHESIS": false,
  // Backward transitions are NEVER auto — they require explicit agent/user decision
};

// ---- Guard Evaluators -----------------------------------------------------

function evaluateDiscoveryToHypothesis(
  ctx: DiscoveryToHypothesisContext,
): GuardResult {
  const checks: GuardResult["checks"] = {
    papers_or_scout: {
      passed: ctx.paperCount >= 3 || ctx.scoutCount > 0,
      detail:
        ctx.paperCount >= 3 || ctx.scoutCount > 0
          ? `${ctx.paperCount} papers, ${ctx.scoutCount} scouts`
          : `Need at least 3 papers or 1 scout (have ${ctx.paperCount} papers, ${ctx.scoutCount} scouts)`,
    },
    papers_processed: {
      passed: ctx.paperCount - ctx.unprocessedPaperCount >= 3,
      detail:
        ctx.paperCount - ctx.unprocessedPaperCount >= 3
          ? `${ctx.paperCount - ctx.unprocessedPaperCount} papers processed (${ctx.unprocessedPaperCount} still pending — OK to proceed)`
          : `Only ${ctx.paperCount - ctx.unprocessedPaperCount} papers processed (need 3+, ${ctx.unprocessedPaperCount} still pending)`,
    },
    synthesis_completed: {
      passed: ctx.completedSynthesisCount > 0,
      detail:
        ctx.completedSynthesisCount > 0
          ? `${ctx.completedSynthesisCount} syntheses completed`
          : "No synthesis completed yet",
    },
  };

  return {
    satisfied: Object.values(checks).every((c) => c.passed),
    checks,
  };
}

function evaluateHypothesisToDesign(
  ctx: HypothesisToDesignContext,
): GuardResult {
  const checks: GuardResult["checks"] = {
    has_hypothesis: {
      passed: ctx.hypothesisCount > 0,
      detail:
        ctx.hypothesisCount > 0
          ? `${ctx.hypothesisCount} hypotheses defined`
          : "No hypotheses defined",
    },
    has_approach: {
      passed: ctx.approachCount > 0,
      detail:
        ctx.approachCount > 0
          ? `${ctx.approachCount} approaches defined`
          : "No approaches defined",
    },
  };

  return {
    satisfied: Object.values(checks).every((c) => c.passed),
    checks,
  };
}

function evaluateDesignToExecution(
  ctx: DesignToExecutionContext,
): GuardResult {
  const checks: GuardResult["checks"] = {
    metrics_defined: {
      passed: ctx.metricSchemaDefined,
      detail: ctx.metricSchemaDefined
        ? "Metric schema defined"
        : "Metric schema not yet defined",
    },
    evaluation_protocol: {
      passed: ctx.evaluationProtocolExists,
      detail: ctx.evaluationProtocolExists
        ? "Evaluation protocol exists"
        : "No evaluation protocol defined",
    },
    active_hypothesis: {
      passed: ctx.activeHypothesisCount > 0,
      detail:
        ctx.activeHypothesisCount > 0
          ? `${ctx.activeHypothesisCount} active hypotheses`
          : "No active hypotheses",
    },
    ready_intents: {
      passed: ctx.readyIntentCount > 0,
      detail: ctx.readyIntentCount > 0
        ? `${ctx.readyIntentCount} intents ready for execution`
        : "No intents in READY state — create intents in DESIGN first",
    },
  };

  return {
    satisfied: Object.values(checks).every((c) => c.passed),
    checks,
  };
}

function evaluateExecutionToAnalysis(
  ctx: ExecutionToAnalysisContext,
): GuardResult {
  const checks: GuardResult["checks"] = {
    real_experiment_done: {
      passed: ctx.newDoneNonSmokeRunCount > 0,
      detail: ctx.newDoneNonSmokeRunCount > 0
        ? `${ctx.newDoneNonSmokeRunCount} new experiments completed this iteration`
        : `No new non-SMOKE experiments since entering EXECUTION (${ctx.doneRunCount} total historical)`,
    },
    satisfied_intent: {
      passed: ctx.satisfiedIntentCount > 0,
      detail: ctx.satisfiedIntentCount > 0
        ? `${ctx.satisfiedIntentCount} intents satisfied with results`
        : "No intents satisfied yet",
    },
  };

  return {
    satisfied: Object.values(checks).every((c) => c.passed),
    checks,
  };
}

function evaluateAnalysisToDecision(
  ctx: AnalysisToDecisionContext,
): GuardResult {
  const checks: GuardResult["checks"] = {
    hypothesis_updated: {
      passed:
        ctx.updatedHypothesisCount > 0 || ctx.terminalHypothesisCount > 0,
      detail:
        ctx.updatedHypothesisCount > 0 || ctx.terminalHypothesisCount > 0
          ? `${ctx.updatedHypothesisCount} updated, ${ctx.terminalHypothesisCount} terminal`
          : "No hypotheses updated or reached terminal state",
    },
    evidence_recorded: {
      passed: ctx.claimCount > 0 || ctx.terminalHypothesisCount > 0,
      detail:
        ctx.claimCount > 0 || ctx.terminalHypothesisCount > 0
          ? `${ctx.claimCount} claims, ${ctx.terminalHypothesisCount} terminal hypotheses`
          : "No claims recorded and no terminal hypotheses",
    },
  };

  return {
    satisfied: Object.values(checks).every((c) => c.passed),
    checks,
  };
}

function evaluateDecisionToComplete(
  ctx: DecisionToCompleteContext,
): GuardResult {
  const checks: GuardResult["checks"] = {
    all_adjudicated: {
      passed: ctx.activeOrEvaluatingHypothesisCount === 0,
      detail:
        ctx.activeOrEvaluatingHypothesisCount === 0
          ? "All hypotheses adjudicated"
          : `${ctx.activeOrEvaluatingHypothesisCount} hypotheses still active or evaluating`,
    },
    no_open_obligations: {
      passed: ctx.openCoordinatorObligations === 0,
      detail:
        ctx.openCoordinatorObligations === 0
          ? "No open coordinator obligations"
          : `${ctx.openCoordinatorObligations} open obligations remain`,
    },
    has_conclusion: {
      passed: ctx.supportedOrRetiredCount > 0,
      detail:
        ctx.supportedOrRetiredCount > 0
          ? `${ctx.supportedOrRetiredCount} hypotheses supported or retired`
          : "No hypotheses have been supported or retired",
    },
    grounded_summary: {
      passed: ctx.groundedSummaryCompiled,
      detail: ctx.groundedSummaryCompiled
        ? "Grounded summary compiled"
        : "No grounded summary compiled yet",
    },
    memory_promotions: {
      passed: ctx.memoryPromotionsPending === 0,
      detail:
        ctx.memoryPromotionsPending === 0
          ? "All memory candidates adjudicated"
          : `${ctx.memoryPromotionsPending} memory candidates pending`,
    },
  };

  return {
    satisfied: Object.values(checks).every((c) => c.passed),
    checks,
  };
}

function evaluateDecisionToDesign(
  ctx: DecisionToDesignContext,
): GuardResult {
  const checks: GuardResult["checks"] = {
    viable_hypothesis: {
      passed: ctx.viableHypothesisCount > 0,
      detail:
        ctx.viableHypothesisCount > 0
          ? `${ctx.viableHypothesisCount} viable hypotheses`
          : "No viable hypotheses remain",
    },
    has_work: {
      passed:
        ctx.viableHypothesisCount > 0 ||
        ctx.coordinatorRequiredExperiments > 0,
      detail:
        ctx.viableHypothesisCount > 0 ||
        ctx.coordinatorRequiredExperiments > 0
          ? `${ctx.viableHypothesisCount} viable hypotheses, ${ctx.coordinatorRequiredExperiments} required experiments`
          : "No viable hypotheses or required experiments",
    },
  };

  return {
    satisfied: Object.values(checks).every((c) => c.passed),
    checks,
  };
}

function backwardTransitionGuard(): GuardResult {
  return {
    satisfied: true,
    checks: {},
  };
}

// ---- Main Evaluator -------------------------------------------------------

/**
 * Evaluate whether a project transition's guards are satisfied.
 *
 * Pure function — takes pre-fetched context, returns a GuardResult.
 * The caller is responsible for fetching the appropriate context from the DB.
 */
export async function evaluateTransitionGuard(
  _projectId: string,
  from: ProjectState,
  to: ProjectState,
  context: GuardContext,
): Promise<GuardResult> {
  // Check the transition is valid in the state machine
  const validTargets = PROJECT_TRANSITIONS[from];
  if (!validTargets.includes(to)) {
    return {
      satisfied: false,
      checks: {
        valid_transition: {
          passed: false,
          detail: `Transition ${from} -> ${to} is not defined in PROJECT_TRANSITIONS`,
        },
      },
    };
  }

  const key = `${from}->${to}`;

  switch (key) {
    case "DISCOVERY->HYPOTHESIS":
      return evaluateDiscoveryToHypothesis(
        context as DiscoveryToHypothesisContext,
      );
    case "HYPOTHESIS->DESIGN":
      return evaluateHypothesisToDesign(context as HypothesisToDesignContext);
    case "DESIGN->EXECUTION":
      return evaluateDesignToExecution(context as DesignToExecutionContext);
    case "EXECUTION->ANALYSIS":
      return evaluateExecutionToAnalysis(context as ExecutionToAnalysisContext);
    case "ANALYSIS->DECISION":
      return evaluateAnalysisToDecision(context as AnalysisToDecisionContext);
    case "DECISION->COMPLETE":
      return evaluateDecisionToComplete(context as DecisionToCompleteContext);
    case "DECISION->DESIGN":
      return evaluateDecisionToDesign(context as DecisionToDesignContext);

    // Backward transitions — no guards
    case "HYPOTHESIS->DISCOVERY":
    case "DESIGN->HYPOTHESIS":
      return backwardTransitionGuard();

    default:
      return {
        satisfied: false,
        checks: {
          valid_transition: {
            passed: false,
            detail: `No guard evaluator defined for ${key}`,
          },
        },
      };
  }
}
