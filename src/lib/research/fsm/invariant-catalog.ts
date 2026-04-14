// src/lib/research/fsm/invariant-catalog.ts
import type { InvariantClass } from "./enums";

export interface InvariantDefinition {
  key: string;
  class: InvariantClass;
  domain: string;
  description: string;
  escalationPolicy?: string;
  ttlSeconds?: number;
}

export const INVARIANT_CATALOG: InvariantDefinition[] = [
  // HARD
  { key: "project.analysis_requires_done_runs", class: "HARD", domain: "project", description: "Project in ANALYSIS with zero DONE runs is impossible" },
  { key: "project.execution_requires_live_intent", class: "HARD", domain: "project", description: "Project in EXECUTION with zero intents in READY, ACTIVE, or SATISFIED is impossible" },
  { key: "run.done_requires_result", class: "HARD", domain: "run", description: "Run in DONE with no linked ExperimentResult is impossible" },
  { key: "intent.active_requires_runs", class: "HARD", domain: "intent", description: "Intent in ACTIVE with zero child runs is impossible" },
  { key: "intent.satisfied_requires_criterion", class: "HARD", domain: "intent", description: "Intent in SATISFIED where completionCriterion is not actually met" },
  // SOFT
  { key: "hypothesis.active_requires_intent", class: "SOFT", domain: "hypothesis", description: "Hypothesis in ACTIVE with no linked intent", escalationPolicy: "blocking_soft", ttlSeconds: 60 },
  { key: "hypothesis.active_all_terminal", class: "SOFT", domain: "hypothesis", description: "Hypothesis in ACTIVE but all linked intents are terminal", escalationPolicy: "hard", ttlSeconds: 30 },
  { key: "hypothesis.evaluating_has_nonterminal", class: "SOFT", domain: "hypothesis", description: "Hypothesis in EVALUATING but a linked intent is non-terminal", escalationPolicy: "hard", ttlSeconds: 30 },
  { key: "run.running_requires_heartbeat", class: "SOFT", domain: "run", description: "Run in RUNNING with no attempt heartbeat for 10+ minutes", escalationPolicy: "hard", ttlSeconds: 600 },
  { key: "project.blocked_requires_reason", class: "SOFT", domain: "project", description: "Project overlay BLOCKED with no active blocking reason", escalationPolicy: "hard", ttlSeconds: 120 },
  { key: "run.blocked_requires_reason", class: "SOFT", domain: "run", description: "Run overlay BLOCKED with no active BlockingReason record", escalationPolicy: "hard", ttlSeconds: 60 },
  { key: "intent.active_stale", class: "SOFT", domain: "intent", description: "Intent in ACTIVE for 4+ hours with no run progress", escalationPolicy: "blocking_soft", ttlSeconds: 14400 },
  // AUDIT
  { key: "project.many_intents_no_satisfied", class: "AUDIT", domain: "project", description: "5+ intents, zero SATISFIED — possible design problem" },
  { key: "hypothesis.many_revised", class: "AUDIT", domain: "hypothesis", description: "Same hypothesis revised 3+ times — possible scope problem" },
  { key: "run.many_failures_same_script", class: "AUDIT", domain: "run", description: "Same script failed 3+ times — possible code/environment problem" },
  { key: "approach.orphan_no_hypothesis", class: "AUDIT", domain: "approach", description: "Approach with zero HypothesisApproachLink entries — orphan approach" },
];

export function getInvariantDefinition(key: string): InvariantDefinition | undefined {
  return INVARIANT_CATALOG.find((inv) => inv.key === key);
}

export function getInvariantsForDomain(domain: string): InvariantDefinition[] {
  return INVARIANT_CATALOG.filter((inv) => inv.domain === domain);
}
