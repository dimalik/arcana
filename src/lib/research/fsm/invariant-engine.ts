import { prisma } from "@/lib/prisma";
import { getInvariantsForDomain, type InvariantDefinition } from "./invariant-catalog";
import { INTENT_TERMINAL_STATES } from "./enums";

export interface InvariantCheckResult {
  key: string;
  violated: boolean;
  class: string;
  message: string;
  context?: Record<string, unknown>;
}

export async function checkInvariants(
  domain: string, entityId: string, projectId: string,
): Promise<InvariantCheckResult[]> {
  const definitions = getInvariantsForDomain(domain);
  const results: InvariantCheckResult[] = [];
  for (const def of definitions) {
    const violated = await evaluateInvariant(def, entityId, projectId);
    if (violated) {
      results.push({ key: def.key, violated: true, class: def.class, message: def.description, context: { entityId, projectId, domain } });
    }
  }
  return results;
}

export async function persistViolation(
  violation: InvariantCheckResult, projectId: string, entityId: string, escalationPolicy?: string,
): Promise<void> {
  const existing = await prisma.invariantViolation.findFirst({
    where: { projectId, invariantKey: violation.key, entityId, status: { in: ["OPEN", "ESCALATED"] } },
  });
  if (existing) {
    await prisma.invariantViolation.update({
      where: { id: existing.id },
      data: { lastSeenAt: new Date(), occurrenceCount: { increment: 1 } },
    });
  } else {
    await prisma.invariantViolation.create({
      data: {
        projectId, invariantKey: violation.key, class: violation.class,
        domain: (violation.context?.domain as string) || "unknown",
        entityId, message: violation.message,
        context: violation.context ? JSON.stringify(violation.context) : null,
        status: "OPEN", escalationPolicy: escalationPolicy || null,
      },
    });
  }
}

export async function checkAndPersistInvariants(
  domain: string, entityId: string, projectId: string,
): Promise<InvariantCheckResult[]> {
  const violations = await checkInvariants(domain, entityId, projectId);
  for (const v of violations) {
    const def = getInvariantsForDomain(domain).find((d) => d.key === v.key);
    await persistViolation(v, projectId, entityId, def?.escalationPolicy);
  }
  const violatedKeys = new Set(violations.map((v) => v.key));
  for (const def of getInvariantsForDomain(domain)) {
    if (!violatedKeys.has(def.key)) {
      await prisma.invariantViolation.updateMany({
        where: { projectId, invariantKey: def.key, entityId, status: { in: ["OPEN", "ESCALATED"] } },
        data: { status: "RESOLVED", resolvedAt: new Date(), resolvedBy: "auto_clear" },
      });
    }
  }
  return violations;
}

async function evaluateInvariant(def: InvariantDefinition, entityId: string, projectId: string): Promise<boolean> {
  switch (def.key) {
    case "project.analysis_requires_done_runs": {
      const p = await prisma.researchProject.findUnique({ where: { id: projectId }, select: { currentPhase: true } });
      if (p?.currentPhase !== "ANALYSIS") return false;
      return (await prisma.experimentRun.count({ where: { projectId, state: "DONE" } })) === 0;
    }
    case "project.execution_requires_live_intent": {
      const p = await prisma.researchProject.findUnique({ where: { id: projectId }, select: { currentPhase: true } });
      if (p?.currentPhase !== "EXECUTION") return false;
      return (await prisma.experimentIntent.count({ where: { projectId, status: { in: ["READY", "ACTIVE", "SATISFIED"] } } })) === 0;
    }
    case "run.done_requires_result": {
      // ExperimentRun does not have a direct resultId field.
      // Results link through RemoteJob: ExperimentRun -> RemoteJob -> ExperimentResult (via jobId).
      const run = await prisma.experimentRun.findUnique({ where: { id: entityId }, select: { state: true, remoteJobs: { select: { id: true } } } });
      if (run?.state !== "DONE") return false;
      const jobIds = run.remoteJobs.map((j) => j.id);
      if (jobIds.length === 0) return true; // DONE with no jobs at all — violated
      const resultCount = await prisma.experimentResult.count({ where: { jobId: { in: jobIds } } });
      return resultCount === 0;
    }
    case "intent.active_requires_runs": {
      const intent = await prisma.experimentIntent.findUnique({ where: { id: entityId }, select: { status: true } });
      if (intent?.status !== "ACTIVE") return false;
      return (await prisma.experimentRun.count({ where: { intentId: entityId } })) === 0;
    }
    case "hypothesis.active_all_terminal": {
      const h = await prisma.researchHypothesis.findUnique({ where: { id: entityId }, select: { status: true } });
      if (h?.status !== "ACTIVE") return false;
      const intents = await prisma.experimentIntent.findMany({ where: { hypothesisId: entityId }, select: { status: true } });
      if (intents.length === 0) return false;
      return intents.every((i) => (INTENT_TERMINAL_STATES as readonly string[]).includes(i.status));
    }
    case "hypothesis.evaluating_has_nonterminal": {
      const h = await prisma.researchHypothesis.findUnique({ where: { id: entityId }, select: { status: true } });
      if (h?.status !== "EVALUATING") return false;
      const intents = await prisma.experimentIntent.findMany({ where: { hypothesisId: entityId }, select: { status: true } });
      return intents.some((i) => !(INTENT_TERMINAL_STATES as readonly string[]).includes(i.status));
    }
    case "project.blocked_requires_reason": {
      const p = await prisma.researchProject.findUnique({ where: { id: projectId }, select: { status: true } });
      if (p?.status !== "BLOCKED") return false;
      return (await prisma.blockingReason.count({ where: { projectId, domain: "project", entityId: projectId, resolvedAt: null } })) === 0;
    }
    case "run.blocked_requires_reason": {
      const run = await prisma.experimentRun.findUnique({ where: { id: entityId }, select: { overlay: true } });
      if (run?.overlay !== "BLOCKED") return false;
      return (await prisma.blockingReason.count({ where: { entityId, domain: "run", resolvedAt: null } })) === 0;
    }
    default:
      return false;
  }
}
