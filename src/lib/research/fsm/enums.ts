// src/lib/research/fsm/enums.ts
//
// Frozen state vocabularies for the research lifecycle FSM v2.
// This is the single source of truth. All other code imports from here.
// No raw string literals for states anywhere else in the codebase.

// ── Project Lifecycle ──────────────────────────────────────────────

export const PROJECT_LIFECYCLE_STATES = [
  "DISCOVERY",
  "HYPOTHESIS",
  "DESIGN",
  "EXECUTION",
  "ANALYSIS",
  "DECISION",
  "COMPLETE",
] as const;
export type ProjectLifecycleState = (typeof PROJECT_LIFECYCLE_STATES)[number];

export const PROJECT_OVERLAY_STATUSES = [
  "ACTIVE",
  "PAUSED",
  "BLOCKED",
  "FAILED",
  "ARCHIVED",
] as const;
export type ProjectOverlayStatus = (typeof PROJECT_OVERLAY_STATUSES)[number];

// ── Intent Lifecycle ───────────────────────────────────────────────

export const INTENT_LIFECYCLE_STATES = [
  "DRAFT",
  "READY",
  "ACTIVE",
  "SATISFIED",
  "EXHAUSTED",
  "SUPERSEDED",
  "CANCELLED",
] as const;
export type IntentLifecycleState = (typeof INTENT_LIFECYCLE_STATES)[number];

export const INTENT_TERMINAL_STATES: readonly IntentLifecycleState[] = [
  "SATISFIED",
  "EXHAUSTED",
  "SUPERSEDED",
  "CANCELLED",
];

export const INTENT_PURPOSES = [
  "BASELINE",
  "MAIN_EVAL",
  "TRAINING",
  "ANALYSIS",
] as const;
export type IntentPurpose = (typeof INTENT_PURPOSES)[number];

// ── Run Lifecycle ──────────────────────────────────────────────────

export const RUN_LIFECYCLE_STATES = [
  "DRAFT",
  "READY",
  "QUEUED",
  "RUNNING",
  "IMPORTING",
  "DONE",
  "FAILED",
  "CANCELLED",
] as const;
export type RunLifecycleState = (typeof RUN_LIFECYCLE_STATES)[number];

export const RUN_TERMINAL_STATES: readonly RunLifecycleState[] = [
  "DONE",
  "FAILED",
  "CANCELLED",
];

export const RUN_OVERLAY_STATUSES = [
  "ACTIVE",
  "BLOCKED",
] as const;
export type RunOverlayStatus = (typeof RUN_OVERLAY_STATUSES)[number];

export const RUN_KINDS = ["research", "infrastructure"] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export const INFRASTRUCTURE_PURPOSES = ["SMOKE", "CALIBRATION"] as const;
export type InfrastructurePurpose = (typeof INFRASTRUCTURE_PURPOSES)[number];

export const FAILURE_CLASSES = [
  "INFRA",
  "CODE",
  "POLICY",
  "VALIDATION",
  "IMPORT",
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

// ── Hypothesis Lifecycle ───────────────────────────────────────────

export const HYPOTHESIS_LIFECYCLE_STATES = [
  "PROPOSED",
  "ACTIVE",
  "EVALUATING",
  "SUPPORTED",
  "CONTESTED",
  "REVISED",
  "RETIRED",
] as const;
export type HypothesisLifecycleState = (typeof HYPOTHESIS_LIFECYCLE_STATES)[number];

export const HYPOTHESIS_TERMINAL_STATES: readonly HypothesisLifecycleState[] = [
  "SUPPORTED",
  "CONTESTED",
  "REVISED",
  "RETIRED",
];

// ── Approach Lifecycle ─────────────────────────────────────────────

export const APPROACH_LIFECYCLE_STATES = [
  "PROPOSED",
  "COMMITTED",
  "ACTIVE",
  "COMPLETED",
  "ABANDONED",
] as const;
export type ApproachLifecycleState = (typeof APPROACH_LIFECYCLE_STATES)[number];

// ── Transition Triggers ────────────────────────────────────────────

export const TRANSITION_TRIGGERS = [
  "auto",
  "agent",
  "user",
  "system",
  "reconciler",
  "invariant_repair",
] as const;
export type TransitionTrigger = (typeof TRANSITION_TRIGGERS)[number];

// ── Transition Domains ─────────────────────────────────────────────

export const TRANSITION_DOMAINS = [
  "project",
  "intent",
  "run",
  "hypothesis",
  "approach",
] as const;
export type TransitionDomain = (typeof TRANSITION_DOMAINS)[number];

// ── Invariant Classes ──────────────────────────────────────────────

export const INVARIANT_CLASSES = ["HARD", "SOFT", "AUDIT"] as const;
export type InvariantClass = (typeof INVARIANT_CLASSES)[number];

export const INVARIANT_VIOLATION_STATUSES = [
  "OPEN",
  "ESCALATED",
  "RESOLVED",
  "SUPPRESSED",
] as const;
export type InvariantViolationStatus = (typeof INVARIANT_VIOLATION_STATUSES)[number];

// ── Approach Roles (HypothesisApproachLink) ────────────────────────

export const APPROACH_ROLES = [
  "primary",
  "control",
  "ablation",
  "comparison",
] as const;
export type ApproachRole = (typeof APPROACH_ROLES)[number];

// ── Completion Criteria ────────────────────────────────────────────

export type CompletionCriterion =
  | { type: "single_successful_run" }
  | { type: "min_runs"; count: number }
  | { type: "all_seeds_complete"; seeds: number[] }
  | { type: "comparison_against"; baselineIntentId: string; matchBy: "runKey" }
  | { type: "comparison_against"; baselineIntentId: string; matchBy: "seed"; seeds: number[] }
  | { type: "all_conditions_complete"; conditions: string[] };

// ── RemoteJob Adapter Statuses (not lifecycle) ─────────────────────

export const REMOTE_JOB_ADAPTER_STATUSES = [
  "SYNCING",
  "POLLING",
  "COMPLETED",
  "ERROR",
] as const;
export type RemoteJobAdapterStatus = (typeof REMOTE_JOB_ADAPTER_STATUSES)[number];
