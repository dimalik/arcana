// src/lib/research/fsm/why-layer.ts
import { prisma } from "@/lib/prisma";
import type { ProjectState, GuardResult } from "./types";
import { PROJECT_TRANSITIONS } from "./types";
import { evaluateTransitionGuard } from "./project-fsm";
import { fetchGuardContext } from "./transition-engine";

// ── explainTransition ───────────────────────────────────────────

export interface TransitionExplanation {
  transitionId: string;
  domain: string;
  entityId: string;
  from: string;
  to: string;
  trigger: string;
  causedByEvent: string | null;
  causedByEntity: { type: string; id: string } | null;
  agentSessionId: string | null;
  guardsEvaluated: Record<string, { passed: boolean; detail: string }> | null;
  guardContextSnapshot: Record<string, unknown> | null;
  summary: string;
  timestamp: Date;
}

export async function explainTransition(transitionId: string): Promise<TransitionExplanation | null> {
  const record = await prisma.transitionRecord.findUnique({ where: { id: transitionId } });
  if (!record) return null;

  let guards: Record<string, { passed: boolean; detail: string }> | null = null;
  try { guards = record.guardsEvaluated ? JSON.parse(record.guardsEvaluated) : null; } catch {}

  let snapshot: Record<string, unknown> | null = null;
  try { snapshot = record.guardContextSnapshot ? JSON.parse(record.guardContextSnapshot) : null; } catch {}

  return {
    transitionId: record.id, domain: record.domain, entityId: record.entityId,
    from: record.fromState, to: record.toState, trigger: record.trigger,
    causedByEvent: record.causedByEvent,
    causedByEntity: record.causedByEntityType && record.causedByEntityId
      ? { type: record.causedByEntityType, id: record.causedByEntityId } : null,
    agentSessionId: record.agentSessionId,
    guardsEvaluated: guards, guardContextSnapshot: snapshot,
    summary: record.basis, timestamp: record.createdAt,
  };
}

// ── explainBlocker ──────────────────────────────────────────────

export interface BlockerExplanation {
  entityType: string;
  entityId: string;
  currentState: string;
  targetState: string;
  isValidTransition: boolean;
  failingChecks: Array<{ check: string; detail: string; whatWouldSatisfy: string }>;
  passingChecks: Array<{ check: string; detail: string }>;
  relatedViolations: Array<{ invariantKey: string; class: string; message: string }>;
}

export function deriveWhatWouldSatisfy(check: string, _detail: string): string {
  const hints: Record<string, string> = {
    papers_or_scout: "Import 3+ papers or dispatch a scout",
    papers_processed: "Wait for paper processing to complete",
    synthesis_completed: "Dispatch a synthesizer",
    has_hypothesis: "Create at least 1 hypothesis with log_finding",
    has_approach: "Register at least 1 approach",
    metrics_defined: "Call define_metrics",
    evaluation_protocol: "Define an evaluation protocol (auto-created from metrics)",
    active_hypothesis: "At least 1 hypothesis must be in ACTIVE state",
    ready_intents: "Create experiment intents with create_intent",
    real_experiment_done: "Complete at least 1 non-SMOKE experiment",
    satisfied_intent: "At least 1 intent must be SATISFIED (criterion met with results)",
    hypothesis_updated: "Update hypotheses with evidence from experiments",
    evidence_recorded: "Record claims or update hypotheses to terminal states",
  };
  return hints[check] || `Satisfy the check: ${check}`;
}

export async function explainBlocker(
  entityType: string, entityId: string, targetState: string,
): Promise<BlockerExplanation | null> {
  if (entityType !== "project") return null;

  const project = await prisma.researchProject.findUnique({ where: { id: entityId }, select: { currentPhase: true } });
  if (!project) return null;

  const currentState = project.currentPhase as ProjectState;
  const validTargets = PROJECT_TRANSITIONS[currentState] || [];
  const isValid = (validTargets as readonly string[]).includes(targetState);

  if (!isValid) {
    return {
      entityType, entityId, currentState, targetState, isValidTransition: false,
      failingChecks: [{ check: "valid_transition", detail: `${currentState} -> ${targetState} is not valid`, whatWouldSatisfy: `Valid targets: ${validTargets.join(", ")}` }],
      passingChecks: [], relatedViolations: [],
    };
  }

  const context = await fetchGuardContext(entityId, currentState, targetState as ProjectState);
  const result = await evaluateTransitionGuard(entityId, currentState, targetState as ProjectState, context);

  const failingChecks = Object.entries(result.checks).filter(([, v]) => !v.passed)
    .map(([k, v]) => ({ check: k, detail: v.detail, whatWouldSatisfy: deriveWhatWouldSatisfy(k, v.detail) }));
  const passingChecks = Object.entries(result.checks).filter(([, v]) => v.passed)
    .map(([k, v]) => ({ check: k, detail: v.detail }));

  const violations = await prisma.invariantViolation.findMany({
    where: { projectId: entityId, status: { in: ["OPEN", "ESCALATED"] } },
    select: { invariantKey: true, class: true, message: true },
  });

  return { entityType, entityId, currentState, targetState, isValidTransition: true, failingChecks, passingChecks, relatedViolations: violations };
}

// ── getStateReport ──────────────────────────────────────────────

export interface StateReport {
  entityType: string;
  entityId: string;
  lifecycleState: string;
  operationalOverlay: string | null;
  possibleTransitions: Array<{ targetState: string; isAutoEligible: boolean; guardSatisfied: boolean; blockerSummary: string | null }>;
  openViolations: Array<{ invariantKey: string; class: string; message: string; firstSeenAt: Date; escalationPolicy: string | null }>;
  recentTransitions: Array<{ id: string; from: string; to: string; trigger: string; summary: string; timestamp: Date }>;
  context: Record<string, unknown>;
}

export async function getStateReport(entityType: string, entityId: string): Promise<StateReport | null> {
  if (entityType !== "project") return null;

  const project = await prisma.researchProject.findUnique({ where: { id: entityId }, select: { currentPhase: true, status: true } });
  if (!project) return null;

  const state = project.currentPhase as ProjectState;
  const targets = [...(PROJECT_TRANSITIONS[state] || [])];

  const guardResults: StateReport["possibleTransitions"] = [];
  for (const target of targets) {
    const ctx = await fetchGuardContext(entityId, state, target);
    const result = await evaluateTransitionGuard(entityId, state, target, ctx);
    const blockers = Object.entries(result.checks).filter(([, v]) => !v.passed).map(([k, v]) => `${k}: ${v.detail}`).join("; ");
    guardResults.push({ targetState: target, isAutoEligible: true, guardSatisfied: result.satisfied, blockerSummary: result.satisfied ? null : blockers });
  }

  const violations = await prisma.invariantViolation.findMany({
    where: { projectId: entityId, status: { in: ["OPEN", "ESCALATED"] } },
    select: { invariantKey: true, class: true, message: true, firstSeenAt: true, escalationPolicy: true },
    orderBy: { firstSeenAt: "desc" }, take: 10,
  });

  const transitions = await prisma.transitionRecord.findMany({
    where: { projectId: entityId, domain: "project" },
    orderBy: { createdAt: "desc" }, take: 5,
    select: { id: true, fromState: true, toState: true, trigger: true, basis: true, createdAt: true },
  });

  const [intentCount, runCount, hypothesisCount, claimCount] = await Promise.all([
    prisma.experimentIntent.count({ where: { projectId: entityId } }),
    prisma.experimentRun.count({ where: { projectId: entityId } }),
    prisma.researchHypothesis.count({ where: { projectId: entityId } }),
    prisma.researchClaim.count({ where: { projectId: entityId } }),
  ]);

  return {
    entityType: "project", entityId, lifecycleState: state, operationalOverlay: project.status,
    possibleTransitions: guardResults, openViolations: violations,
    recentTransitions: transitions.map((t) => ({ id: t.id, from: t.fromState, to: t.toState, trigger: t.trigger, summary: t.basis, timestamp: t.createdAt })),
    context: { intentCount, runCount, hypothesisCount, claimCount },
  };
}
