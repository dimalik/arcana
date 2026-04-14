import { prisma } from "@/lib/prisma";
import { createHash } from "crypto";
import {
  type CompletionCriterion,
  type IntentLifecycleState,
  INTENT_TERMINAL_STATES,
  RUN_TERMINAL_STATES,
} from "./enums";
import { getEvaluationProtocol } from "../evaluation-protocol";

interface ValidationInput {
  hypothesisId: string;
  approachId: string;
  projectId: string;
  scriptName: string;
  scriptContent: string;
}

interface ValidationResult {
  valid: boolean;
  reason?: string;
  scriptHash?: string;
  protocolId?: string;
  protocolHash?: string;
}

export async function validateIntentToReady(input: ValidationInput): Promise<ValidationResult> {
  const [hypothesis, approach, protocol] = await Promise.all([
    prisma.researchHypothesis.findUnique({ where: { id: input.hypothesisId }, select: { id: true } }),
    prisma.approachBranch.findUnique({ where: { id: input.approachId }, select: { id: true } }),
    getEvaluationProtocol(input.projectId),
  ]);

  if (!hypothesis) return { valid: false, reason: `Hypothesis ${input.hypothesisId} does not exist.` };
  if (!approach) return { valid: false, reason: `Approach ${input.approachId} does not exist.` };
  if (!protocol) return { valid: false, reason: "No evaluation protocol defined for this project." };

  const scriptHash = createHash("sha256").update(input.scriptContent).digest("hex");
  const protocolHash = createHash("sha256").update(JSON.stringify(protocol.protocol)).digest("hex");

  return { valid: true, scriptHash, protocolId: protocol.id, protocolHash };
}

interface RunSummary {
  state: string;
  runKey: string | null;
  resultId: string | null;
  seed?: number | null;
  condition?: string | null;
}

interface CriterionResult {
  satisfied: boolean;
  allTerminal: boolean;
  doneCount: number;
  totalCount: number;
  detail: string;
}

export function evaluateCompletionCriterion(criterion: CompletionCriterion, runs: RunSummary[]): CriterionResult {
  const doneRuns = runs.filter((r) => r.state === "DONE" && r.resultId);
  const terminalRuns = runs.filter((r) => (RUN_TERMINAL_STATES as readonly string[]).includes(r.state));
  const allTerminal = runs.length > 0 && terminalRuns.length === runs.length;
  const doneCount = doneRuns.length;

  switch (criterion.type) {
    case "single_successful_run":
      return { satisfied: doneCount >= 1, allTerminal, doneCount, totalCount: runs.length, detail: doneCount >= 1 ? "1 DONE run (criterion met)" : `0 DONE runs of ${runs.length} total` };

    case "min_runs":
      return { satisfied: doneCount >= criterion.count, allTerminal, doneCount, totalCount: runs.length, detail: `${doneCount}/${criterion.count} DONE runs` };

    case "all_seeds_complete": {
      const doneSeedSet = new Set(doneRuns.map((r) => r.seed ?? (r.runKey?.match(/seed=(\d+)/)?.[1] ? Number(r.runKey!.match(/seed=(\d+)/)![1]) : null)).filter((s): s is number => s !== null));
      const allCovered = criterion.seeds.every((s) => doneSeedSet.has(s));
      return { satisfied: allCovered, allTerminal, doneCount, totalCount: runs.length, detail: allCovered ? `All ${criterion.seeds.length} seeds complete` : `${doneSeedSet.size}/${criterion.seeds.length} seeds complete` };
    }

    case "all_conditions_complete": {
      const doneCondSet = new Set(doneRuns.map((r) => r.condition ?? r.runKey?.match(/condition=(.+)/)?.[1]).filter((c): c is string => c != null));
      const allCovered = criterion.conditions.every((c) => doneCondSet.has(c));
      return { satisfied: allCovered, allTerminal, doneCount, totalCount: runs.length, detail: allCovered ? `All ${criterion.conditions.length} conditions complete` : `${doneCondSet.size}/${criterion.conditions.length} conditions complete` };
    }

    case "comparison_against": {
      if (criterion.matchBy === "seed") {
        const doneSeedSet = new Set(doneRuns.map((r) => r.seed ?? (r.runKey?.match(/seed=(\d+)/)?.[1] ? Number(r.runKey!.match(/seed=(\d+)/)![1]) : null)).filter((s): s is number => s !== null));
        const allCovered = criterion.seeds.every((s) => doneSeedSet.has(s));
        return { satisfied: allCovered, allTerminal, doneCount, totalCount: runs.length, detail: allCovered ? `All ${criterion.seeds.length} comparison seeds complete` : `${doneSeedSet.size}/${criterion.seeds.length} comparison seeds complete` };
      }
      return { satisfied: doneCount >= 1, allTerminal, doneCount, totalCount: runs.length, detail: doneCount >= 1 ? "Comparison run complete" : "No DONE comparison run yet" };
    }

    default:
      return { satisfied: false, allTerminal, doneCount, totalCount: runs.length, detail: "Unknown criterion type" };
  }
}

export function deriveIntentState(currentStatus: IntentLifecycleState, criterion: CompletionCriterion, runs: RunSummary[]): IntentLifecycleState {
  if ((INTENT_TERMINAL_STATES as readonly string[]).includes(currentStatus)) return currentStatus;
  if (runs.length === 0) return currentStatus === "DRAFT" ? "DRAFT" : "READY";
  const hasNonTerminal = runs.some((r) => !(RUN_TERMINAL_STATES as readonly string[]).includes(r.state));
  if (hasNonTerminal) return "ACTIVE";
  const evaluation = evaluateCompletionCriterion(criterion, runs);
  if (evaluation.satisfied) return "SATISFIED";
  return "EXHAUSTED";
}
