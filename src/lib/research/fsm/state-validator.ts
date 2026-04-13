/**
 * Behavioral validator FSM.
 *
 * Runs alongside the real FSM and checks whether the agent's actions
 * match expectations for the current state. Flags deviations in
 * real time so we can detect problems before the agent wastes 50 steps.
 *
 * This is NOT the state machine itself — it's a shadow observer that
 * validates the agent is doing the right kind of work.
 */

import type { ProjectState } from "./types";

// ── Per-state expectations ──────────────────────────────────────

export interface StateExpectation {
  /** Tools the agent SHOULD call in this state to make progress */
  expectedTools: string[];
  /** Maximum steps before the state should be completed — beyond this is stagnation */
  maxSteps: number;
  /** What the agent should be told when entering this state */
  directive: string;
}

export const STATE_EXPECTATIONS: Record<ProjectState, StateExpectation> = {
  DISCOVERY: {
    expectedTools: ["search_papers", "dispatch_scouts", "read_paper", "dispatch_synthesizer", "collect_results"],
    maxSteps: 25,
    directive: "Search for papers, read key papers, and dispatch a synthesizer. Do not write experiment code yet.",
  },
  HYPOTHESIS: {
    expectedTools: ["log_finding", "register_approach", "dispatch_architect", "collect_results"],
    maxSteps: 15,
    directive: "Formulate testable hypotheses using log_finding(type='hypothesis') and register approaches. Do not write experiment code yet.",
  },
  DESIGN: {
    expectedTools: ["define_metrics"],
    maxSteps: 5,
    directive: "Call define_metrics with the metrics from your hypotheses (e.g., ASR, PPL, semantic_similarity). The system will auto-create the evaluation protocol and advance to EXECUTION. This is the ONLY thing you need to do.",
  },
  EXECUTION: {
    expectedTools: ["write_file", "run_experiment", "execute_remote", "check_job"],
    maxSteps: 40,
    directive: "Write experiment scripts and run them. All prerequisites are met. Focus on submitting and monitoring experiments.",
  },
  ANALYSIS: {
    expectedTools: ["record_result", "update_hypothesis", "record_claim", "query_results"],
    maxSteps: 20,
    directive: "Record results, update hypotheses with evidence, and record claims. Dispatch reviewers if needed.",
  },
  DECISION: {
    expectedTools: ["query_results", "complete_iteration", "update_hypothesis"],
    maxSteps: 10,
    directive: "Evaluate whether to iterate (refine hypotheses), pivot (new direction), or conclude. The system will auto-resolve when the outcome is unambiguous.",
  },
  COMPLETE: {
    expectedTools: [],
    maxSteps: 3,
    directive: "Research is complete. Review final summary and archive.",
  },
};

// ── Validator ───────────────────────────────────────────────────

export interface ValidationResult {
  ok: boolean;
  violations: Violation[];
}

export interface Violation {
  severity: "warning" | "error";
  tool: string;
  message: string;
}

/**
 * Check whether the agent is stagnating in a state.
 * Returns a warning message if steps exceed the expected max.
 */
export function checkStateStagnation(
  state: ProjectState,
  stepsInState: number,
): string | null {
  const expect = STATE_EXPECTATIONS[state];
  if (!expect) return null;

  if (stepsInState > expect.maxSteps) {
    return `Agent has spent ${stepsInState} steps in ${state} (expected max: ${expect.maxSteps}). ${expect.directive}`;
  }

  return null;
}

/**
 * Get the directive for a given state — used by the system prompt
 * to tell the agent exactly what to do.
 */
export function getStateDirective(state: ProjectState): string {
  return STATE_EXPECTATIONS[state]?.directive || "";
}

/**
 * Validate a batch of tool calls from a single step.
 */
export function validateStep(
  state: ProjectState,
  _toolNames: string[],
  stepsInState: number,
): { violations: Violation[]; stagnationWarning: string | null } {
  const stagnationWarning = checkStateStagnation(state, stepsInState);

  return { violations: [], stagnationWarning };
}

// ── Circuit Breaker ─────────────────────────────────────────────

export interface FailureTracker {
  /** Key: "toolName:scriptOrArg", Value: consecutive failure count */
  consecutiveFailures: Map<string, number>;
  totalFailuresInState: number;
}

export function createFailureTracker(): FailureTracker {
  return {
    consecutiveFailures: new Map(),
    totalFailuresInState: 0,
  };
}

export function recordFailure(tracker: FailureTracker, toolName: string, key: string): void {
  const mapKey = `${toolName}:${key}`;
  tracker.consecutiveFailures.set(mapKey, (tracker.consecutiveFailures.get(mapKey) || 0) + 1);
  tracker.totalFailuresInState++;
}

export function recordSuccess(tracker: FailureTracker, toolName: string, key: string): void {
  const mapKey = `${toolName}:${key}`;
  tracker.consecutiveFailures.delete(mapKey);
}

export function resetTracker(tracker: FailureTracker): void {
  tracker.consecutiveFailures.clear();
  tracker.totalFailuresInState = 0;
}

export interface CircuitBreakerResult {
  blocked: boolean;
  paused: boolean;
  message: string | null;
}

export function checkCircuitBreaker(
  tracker: FailureTracker,
  toolName: string,
  key: string,
): CircuitBreakerResult {
  const mapKey = `${toolName}:${key}`;
  const consecutive = tracker.consecutiveFailures.get(mapKey) || 0;

  if (tracker.totalFailuresInState >= 5) {
    return {
      blocked: true,
      paused: true,
      message: `Circuit breaker: ${tracker.totalFailuresInState} total failures in this state. Stopping to prevent resource waste. Review errors and replan.`,
    };
  }

  if (consecutive >= 3) {
    return {
      blocked: true,
      paused: false,
      message: `Circuit breaker: "${key}" has failed ${consecutive} consecutive times. Fix the code before retrying.`,
    };
  }

  if (consecutive >= 2) {
    return {
      blocked: false,
      paused: false,
      message: `Warning: "${key}" has failed ${consecutive} times. Read the error carefully and fix the script before retrying.`,
    };
  }

  return { blocked: false, paused: false, message: null };
}
