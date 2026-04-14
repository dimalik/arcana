import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    experimentIntent: { create: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    researchHypothesis: { findUnique: vi.fn() },
    approachBranch: { findUnique: vi.fn() },
    researchProject: { findUnique: vi.fn() },
    researchLogEntry: { findFirst: vi.fn() },
  },
}));

import { validateIntentToReady, evaluateCompletionCriterion, deriveIntentState } from "../intent-lifecycle";
import type { CompletionCriterion, IntentLifecycleState } from "../enums";

describe("validateIntentToReady", () => {
  it("fails if hypothesis does not exist", async () => {
    const { prisma } = await import("@/lib/prisma");
    (prisma.researchHypothesis.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (prisma.approachBranch.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "a1" });

    const result = await validateIntentToReady({
      hypothesisId: "hyp_missing", approachId: "app_1", projectId: "proj_1",
      scriptName: "exp_001.py", scriptContent: "print('hello')",
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("Hypothesis");
  });
});

describe("evaluateCompletionCriterion", () => {
  it("single_successful_run: satisfied with 1 DONE run", () => {
    const c: CompletionCriterion = { type: "single_successful_run" };
    expect(evaluateCompletionCriterion(c, [{ state: "DONE", runKey: "default", resultId: "r1" }]).satisfied).toBe(true);
  });

  it("single_successful_run: not satisfied with 0 DONE", () => {
    const c: CompletionCriterion = { type: "single_successful_run" };
    expect(evaluateCompletionCriterion(c, [{ state: "FAILED", runKey: "default", resultId: null }]).satisfied).toBe(false);
  });

  it("all_seeds_complete: satisfied when all seeds DONE", () => {
    const c: CompletionCriterion = { type: "all_seeds_complete", seeds: [42, 123] };
    const runs = [
      { state: "DONE", runKey: "seed=42", resultId: "r1", seed: 42 },
      { state: "DONE", runKey: "seed=123", resultId: "r2", seed: 123 },
    ];
    expect(evaluateCompletionCriterion(c, runs).satisfied).toBe(true);
  });

  it("all_seeds_complete: not satisfied with missing seed", () => {
    const c: CompletionCriterion = { type: "all_seeds_complete", seeds: [42, 123, 456] };
    const runs = [
      { state: "DONE", runKey: "seed=42", resultId: "r1", seed: 42 },
      { state: "FAILED", runKey: "seed=123", resultId: null, seed: 123 },
    ];
    expect(evaluateCompletionCriterion(c, runs).satisfied).toBe(false);
  });

  it("min_runs: satisfied with enough DONE runs", () => {
    const c: CompletionCriterion = { type: "min_runs", count: 3 };
    const runs = [
      { state: "DONE", runKey: "run_1", resultId: "r1" },
      { state: "DONE", runKey: "run_2", resultId: "r2" },
      { state: "DONE", runKey: "run_3", resultId: "r3" },
    ];
    expect(evaluateCompletionCriterion(c, runs).satisfied).toBe(true);
  });

  it("min_runs: not satisfied with insufficient DONE", () => {
    const c: CompletionCriterion = { type: "min_runs", count: 3 };
    const runs = [
      { state: "DONE", runKey: "run_1", resultId: "r1" },
      { state: "FAILED", runKey: "run_2", resultId: null },
    ];
    const r = evaluateCompletionCriterion(c, runs);
    expect(r.satisfied).toBe(false);
    expect(r.allTerminal).toBe(true);
  });

  it("all_conditions_complete: satisfied", () => {
    const c: CompletionCriterion = { type: "all_conditions_complete", conditions: ["grpo", "dpo"] };
    const runs = [
      { state: "DONE", runKey: "condition=grpo", resultId: "r1", condition: "grpo" },
      { state: "DONE", runKey: "condition=dpo", resultId: "r2", condition: "dpo" },
    ];
    expect(evaluateCompletionCriterion(c, runs).satisfied).toBe(true);
  });

  it("comparison_against seed: satisfied", () => {
    const c: CompletionCriterion = { type: "comparison_against", baselineIntentId: "int_0", matchBy: "seed", seeds: [42] };
    const runs = [{ state: "DONE", runKey: "seed=42", resultId: "r1", seed: 42 }];
    expect(evaluateCompletionCriterion(c, runs).satisfied).toBe(true);
  });

  it("comparison_against runKey: satisfied", () => {
    const c: CompletionCriterion = { type: "comparison_against", baselineIntentId: "int_0", matchBy: "runKey" };
    const runs = [{ state: "DONE", runKey: "default", resultId: "r1" }];
    expect(evaluateCompletionCriterion(c, runs).satisfied).toBe(true);
  });
});

describe("deriveIntentState", () => {
  it("returns DRAFT when no runs and currently DRAFT", () => {
    expect(deriveIntentState("DRAFT", { type: "single_successful_run" }, [])).toBe("DRAFT");
  });

  it("returns ACTIVE when has non-terminal runs", () => {
    expect(deriveIntentState("READY", { type: "single_successful_run" }, [
      { state: "RUNNING", runKey: "default", resultId: null },
    ])).toBe("ACTIVE");
  });

  it("returns SATISFIED when criterion met", () => {
    expect(deriveIntentState("ACTIVE", { type: "single_successful_run" }, [
      { state: "DONE", runKey: "default", resultId: "r1" },
    ])).toBe("SATISFIED");
  });

  it("returns EXHAUSTED when all terminal but criterion not met", () => {
    expect(deriveIntentState("ACTIVE", { type: "min_runs", count: 3 }, [
      { state: "DONE", runKey: "run_1", resultId: "r1" },
      { state: "FAILED", runKey: "run_2", resultId: null },
    ])).toBe("EXHAUSTED");
  });

  it("does not change terminal states", () => {
    expect(deriveIntentState("CANCELLED", { type: "single_successful_run" }, [])).toBe("CANCELLED");
    expect(deriveIntentState("SUPERSEDED", { type: "single_successful_run" }, [])).toBe("SUPERSEDED");
  });
});
