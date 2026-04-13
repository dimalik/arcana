// ---------------------------------------------------------------------------
// FSM Type Definitions
// Shared types for the project/run/hypothesis finite-state machines used by
// the research agent lifecycle system.
// ---------------------------------------------------------------------------

// ---- Project FSM ----------------------------------------------------------

export const PROJECT_STATES = [
  "DISCOVERY",
  "HYPOTHESIS",
  "DESIGN",
  "EXECUTION",
  "ANALYSIS",
  "DECISION",
  "COMPLETE",
] as const;

export type ProjectState = (typeof PROJECT_STATES)[number];

export const PROJECT_TRANSITIONS: Record<ProjectState, readonly ProjectState[]> = {
  DISCOVERY: ["HYPOTHESIS"],
  HYPOTHESIS: ["DESIGN", "DISCOVERY"],
  DESIGN: ["EXECUTION", "HYPOTHESIS"],
  EXECUTION: ["ANALYSIS"],
  ANALYSIS: ["DECISION"],
  DECISION: ["DESIGN", "HYPOTHESIS", "COMPLETE"],
  COMPLETE: [],
} as const;

// ---- Run FSM --------------------------------------------------------------

export const RUN_STATES = [
  "DRAFT",
  "READY",
  "QUEUED",
  "RUNNING",
  "IMPORTING",
  "DONE",
  "FAILED",
  "CANCELLED",
] as const;

export type RunState = (typeof RUN_STATES)[number];

export type FailureClass = "INFRA" | "CODE" | "POLICY" | "VALIDATION" | "IMPORT";

export const RUN_TERMINAL_STATES: readonly RunState[] = [
  "DONE",
  "FAILED",
  "CANCELLED",
] as const;

// ---- Hypothesis FSM -------------------------------------------------------

export const HYPOTHESIS_STATES = [
  "PROPOSED",
  "ACTIVE",
  "EVALUATING",
  "SUPPORTED",
  "CONTESTED",
  "REVISED",
  "RETIRED",
] as const;

export type HypothesisState = (typeof HYPOTHESIS_STATES)[number];

export const HYPOTHESIS_TERMINAL_STATES: readonly HypothesisState[] = [
  "SUPPORTED",
  "CONTESTED",
  "REVISED",
  "RETIRED",
] as const;

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
