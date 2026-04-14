import { describe, it, expect } from "vitest";
import {
  PROJECT_STATES,
  PROJECT_TRANSITIONS,
  RUN_STATES,
  RUN_TERMINAL_STATES,
  HYPOTHESIS_STATES,
  HYPOTHESIS_TERMINAL_STATES,
} from "../types";
import type { ProjectState } from "../types";
import {
  evaluateTransitionGuard,
  AUTO_TRANSITIONS,
} from "../project-fsm";
import type {
  DiscoveryToHypothesisContext,
  DesignToExecutionContext,
} from "../project-fsm";

describe("FSM type definitions", () => {
  it("every project state has a transition entry", () => {
    for (const state of PROJECT_STATES) {
      expect(PROJECT_TRANSITIONS).toHaveProperty(state);
    }
  });

  it("all transition targets are valid project states", () => {
    const stateSet = new Set<string>(PROJECT_STATES);
    for (const [source, targets] of Object.entries(PROJECT_TRANSITIONS)) {
      for (const target of targets) {
        expect(
          stateSet.has(target),
          `${source} -> ${target}: target is not a valid ProjectState`,
        ).toBe(true);
      }
    }
  });

  it("COMPLETE has no outgoing transitions", () => {
    expect(PROJECT_TRANSITIONS.COMPLETE).toEqual([]);
  });

  it("run terminal states are a subset of run states", () => {
    const runStateSet = new Set<string>(RUN_STATES);
    for (const terminal of RUN_TERMINAL_STATES) {
      expect(
        runStateSet.has(terminal),
        `${terminal} is not a valid RunState`,
      ).toBe(true);
    }
  });

  it("hypothesis terminal states are a subset of hypothesis states", () => {
    const hypothesisStateSet = new Set<string>(HYPOTHESIS_STATES);
    for (const terminal of HYPOTHESIS_TERMINAL_STATES) {
      expect(
        hypothesisStateSet.has(terminal),
        `${terminal} is not a valid HypothesisState`,
      ).toBe(true);
    }
  });
});

describe("evaluateTransitionGuard", () => {
  it("DISCOVERY -> HYPOTHESIS fails when paperCount < 3 and scoutCount === 0", async () => {
    const ctx: DiscoveryToHypothesisContext = {
      paperCount: 2,
      unprocessedPaperCount: 0,
      completedSynthesisCount: 1,
      scoutCount: 0,
    };
    const result = await evaluateTransitionGuard(
      "proj-1",
      "DISCOVERY",
      "HYPOTHESIS",
      ctx,
    );
    expect(result.satisfied).toBe(false);
    expect(result.checks.papers_or_scout.passed).toBe(false);
  });

  it("DISCOVERY -> HYPOTHESIS passes with 3+ papers and synthesis", async () => {
    const ctx: DiscoveryToHypothesisContext = {
      paperCount: 5,
      unprocessedPaperCount: 0,
      completedSynthesisCount: 2,
      scoutCount: 0,
    };
    const result = await evaluateTransitionGuard(
      "proj-1",
      "DISCOVERY",
      "HYPOTHESIS",
      ctx,
    );
    expect(result.satisfied).toBe(true);
    expect(result.checks.papers_or_scout.passed).toBe(true);
    expect(result.checks.papers_processed.passed).toBe(true);
    expect(result.checks.synthesis_completed.passed).toBe(true);
  });

  it("DESIGN -> EXECUTION fails without evaluation protocol", async () => {
    const ctx: DesignToExecutionContext = {
      metricSchemaDefined: true,
      evaluationProtocolExists: false,
      activeHypothesisCount: 1,
      readyIntentCount: 1,
    };
    const result = await evaluateTransitionGuard(
      "proj-1",
      "DESIGN",
      "EXECUTION",
      ctx,
    );
    expect(result.satisfied).toBe(false);
    expect(result.checks.evaluation_protocol.passed).toBe(false);
    expect(result.checks.metrics_defined.passed).toBe(true);
  });

  it("DESIGN -> EXECUTION passes with metrics + protocol + active hypothesis", async () => {
    const ctx: DesignToExecutionContext = {
      metricSchemaDefined: true,
      evaluationProtocolExists: true,
      activeHypothesisCount: 2,
      readyIntentCount: 1,
    };
    const result = await evaluateTransitionGuard(
      "proj-1",
      "DESIGN",
      "EXECUTION",
      ctx,
    );
    expect(result.satisfied).toBe(true);
    expect(result.checks.metrics_defined.passed).toBe(true);
    expect(result.checks.evaluation_protocol.passed).toBe(true);
    expect(result.checks.active_hypothesis.passed).toBe(true);
  });

  it("rejects transitions not in the transition table", async () => {
    const result = await evaluateTransitionGuard(
      "proj-1",
      "DISCOVERY",
      "EXECUTION",
      {} as any,
    );
    expect(result.satisfied).toBe(false);
    expect(result.checks.valid_transition.passed).toBe(false);
    expect(result.checks.valid_transition.detail).toContain(
      "DISCOVERY -> EXECUTION",
    );
  });

  it("backward transitions always pass (HYPOTHESIS -> DISCOVERY)", async () => {
    const result = await evaluateTransitionGuard(
      "proj-1",
      "HYPOTHESIS",
      "DISCOVERY",
      {} as any,
    );
    expect(result.satisfied).toBe(true);
    expect(Object.keys(result.checks)).toHaveLength(0);
  });
});
