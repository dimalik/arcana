// ---------------------------------------------------------------------------
// FSM Type Definitions
// Shared types for the project/run/hypothesis finite-state machines used by
// the research agent lifecycle system.
// ---------------------------------------------------------------------------

// Re-export frozen vocabularies from the canonical source
export {
  type ProjectLifecycleState as ProjectState,
  type RunLifecycleState as RunState,
  type HypothesisLifecycleState as HypothesisState,
  type FailureClass,
  type TransitionTrigger,
  type TransitionDomain,
  type CompletionCriterion,
  PROJECT_LIFECYCLE_STATES as PROJECT_STATES,
  RUN_LIFECYCLE_STATES as RUN_STATES,
  RUN_TERMINAL_STATES,
  HYPOTHESIS_LIFECYCLE_STATES as HYPOTHESIS_STATES,
  HYPOTHESIS_TERMINAL_STATES,
} from "./enums";

// ---- Project FSM (transitions) --------------------------------------------

import type { ProjectLifecycleState } from "./enums";

export const PROJECT_TRANSITIONS: Record<ProjectLifecycleState, readonly ProjectLifecycleState[]> = {
  DISCOVERY: ["HYPOTHESIS"],
  HYPOTHESIS: ["DESIGN", "DISCOVERY"],
  DESIGN: ["EXECUTION", "HYPOTHESIS"],
  EXECUTION: ["ANALYSIS"],
  ANALYSIS: ["DECISION"],
  DECISION: ["DESIGN", "HYPOTHESIS", "COMPLETE"],
  COMPLETE: [],
} as const;

// ---- Operational Overlays -------------------------------------------------

export const OPERATIONAL_STATUSES = [
  "ACTIVE",
  "PAUSED",
  "BLOCKED",
  "FAILED",
  "ARCHIVED",
] as const;

export type OperationalStatus = (typeof OPERATIONAL_STATUSES)[number];

// ---- Transition Records ---------------------------------------------------

export interface TransitionRecord {
  projectId: string;
  domain: "project" | "run" | "hypothesis";
  entityId: string;
  from: string;
  to: string;
  trigger: "auto" | "agent" | "user" | "system";
  basis: string;
  guardsEvaluated: Record<string, boolean>;
}

export interface DecisionRecord extends TransitionRecord {
  decisionType: string;
  hypothesesConsidered: string[];
  evidenceSummary: string;
}

// ---- Guard Result ---------------------------------------------------------

export interface GuardResult {
  satisfied: boolean;
  checks: Record<string, { passed: boolean; detail: string }>;
}
