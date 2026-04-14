import { describe, it, expect } from "vitest";
import { determineNextRun } from "../run-materializer";
import type { CompletionCriterion } from "../enums";

interface ExistingRun {
  id: string;
  state: string;
  runKey: string | null;
  seed: number | null;
  condition: string | null;
  resultId: string | null;
}

describe("determineNextRun", () => {
  it("single_successful_run: creates default run when none exists", () => {
    const c: CompletionCriterion = { type: "single_successful_run" };
    const r = determineNextRun(c, []);
    expect(r.action).toBe("create");
    if (r.action === "create") expect(r.runKey).toBe("default");
  });

  it("single_successful_run: reopens FAILED run", () => {
    const c: CompletionCriterion = { type: "single_successful_run" };
    const runs: ExistingRun[] = [{ id: "r1", state: "FAILED", runKey: "default", seed: null, condition: null, resultId: null }];
    const r = determineNextRun(c, runs);
    expect(r.action).toBe("reopen");
    if (r.action === "reopen") expect(r.existingRunId).toBe("r1");
  });

  it("single_successful_run: rejects when in-flight", () => {
    const c: CompletionCriterion = { type: "single_successful_run" };
    const runs: ExistingRun[] = [{ id: "r1", state: "RUNNING", runKey: "default", seed: null, condition: null, resultId: null }];
    expect(determineNextRun(c, runs).action).toBe("reject");
  });

  it("single_successful_run: rejects when DONE", () => {
    const c: CompletionCriterion = { type: "single_successful_run" };
    const runs: ExistingRun[] = [{ id: "r1", state: "DONE", runKey: "default", seed: null, condition: null, resultId: "res1" }];
    const r = determineNextRun(c, runs);
    expect(r.action).toBe("reject");
    if (r.action === "reject") expect(r.reason).toContain("satisfied");
  });

  it("all_seeds_complete: targets first uncovered seed", () => {
    const c: CompletionCriterion = { type: "all_seeds_complete", seeds: [42, 123, 456] };
    const runs: ExistingRun[] = [{ id: "r1", state: "DONE", runKey: "seed=42", seed: 42, condition: null, resultId: "res1" }];
    const r = determineNextRun(c, runs);
    expect(r.action).toBe("create");
    if (r.action === "create") { expect(r.runKey).toBe("seed=123"); expect(r.seed).toBe(123); }
  });

  it("all_seeds_complete: reopens FAILED seed run", () => {
    const c: CompletionCriterion = { type: "all_seeds_complete", seeds: [42, 123] };
    const runs: ExistingRun[] = [
      { id: "r1", state: "DONE", runKey: "seed=42", seed: 42, condition: null, resultId: "res1" },
      { id: "r2", state: "FAILED", runKey: "seed=123", seed: 123, condition: null, resultId: null },
    ];
    const r = determineNextRun(c, runs);
    expect(r.action).toBe("reopen");
    if (r.action === "reopen") expect(r.existingRunId).toBe("r2");
  });

  it("min_runs: reopens FAILED before creating new", () => {
    const c: CompletionCriterion = { type: "min_runs", count: 3 };
    const runs: ExistingRun[] = [
      { id: "r1", state: "DONE", runKey: "run_1", seed: null, condition: null, resultId: "res1" },
      { id: "r2", state: "FAILED", runKey: "run_2", seed: null, condition: null, resultId: null },
      { id: "r3", state: "DONE", runKey: "run_3", seed: null, condition: null, resultId: "res3" },
    ];
    const r = determineNextRun(c, runs);
    expect(r.action).toBe("reopen");
    if (r.action === "reopen") expect(r.existingRunId).toBe("r2");
  });

  it("min_runs: creates new when no FAILED exist", () => {
    const c: CompletionCriterion = { type: "min_runs", count: 3 };
    const runs: ExistingRun[] = [{ id: "r1", state: "DONE", runKey: "run_1", seed: null, condition: null, resultId: "res1" }];
    const r = determineNextRun(c, runs);
    expect(r.action).toBe("create");
    if (r.action === "create") expect(r.runKey).toBe("run_2");
  });

  it("all_conditions_complete: targets first uncovered condition", () => {
    const c: CompletionCriterion = { type: "all_conditions_complete", conditions: ["grpo", "dpo"] };
    const runs: ExistingRun[] = [{ id: "r1", state: "DONE", runKey: "condition=grpo", seed: null, condition: "grpo", resultId: "res1" }];
    const r = determineNextRun(c, runs);
    expect(r.action).toBe("create");
    if (r.action === "create") { expect(r.runKey).toBe("condition=dpo"); expect(r.condition).toBe("dpo"); }
  });

  it("comparison_against runKey: creates default run", () => {
    const c: CompletionCriterion = { type: "comparison_against", baselineIntentId: "i0", matchBy: "runKey" };
    const r = determineNextRun(c, []);
    expect(r.action).toBe("create");
    if (r.action === "create") expect(r.runKey).toBe("default");
  });

  it("comparison_against seed: targets first uncovered seed", () => {
    const c: CompletionCriterion = { type: "comparison_against", baselineIntentId: "i0", matchBy: "seed", seeds: [42, 123] };
    const r = determineNextRun(c, []);
    expect(r.action).toBe("create");
    if (r.action === "create") { expect(r.runKey).toBe("seed=42"); expect(r.seed).toBe(42); }
  });
});
