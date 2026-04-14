import { describe, it, expect } from "vitest";
import {
  PROJECT_LIFECYCLE_STATES,
  PROJECT_OVERLAY_STATUSES,
  INTENT_LIFECYCLE_STATES,
  RUN_LIFECYCLE_STATES,
  RUN_OVERLAY_STATUSES,
  HYPOTHESIS_LIFECYCLE_STATES,
  APPROACH_LIFECYCLE_STATES,
  TRANSITION_TRIGGERS,
  TRANSITION_DOMAINS,
  INVARIANT_CLASSES,
  RUN_TERMINAL_STATES,
  INTENT_TERMINAL_STATES,
  HYPOTHESIS_TERMINAL_STATES,
  FAILURE_CLASSES,
  APPROACH_ROLES,
} from "../enums";

describe("Vocabulary freeze invariants", () => {
  it("no lifecycle term appears in the same domain's overlay", () => {
    const projectOverlap = PROJECT_LIFECYCLE_STATES.filter(
      (s) => (PROJECT_OVERLAY_STATUSES as readonly string[]).includes(s),
    );
    expect(projectOverlap).toEqual([]);

    const runOverlap = RUN_LIFECYCLE_STATES.filter(
      (s) => (RUN_OVERLAY_STATUSES as readonly string[]).includes(s),
    );
    expect(runOverlap).toEqual([]);
  });

  it("terminal states are subsets of their lifecycle arrays", () => {
    for (const t of RUN_TERMINAL_STATES) {
      expect((RUN_LIFECYCLE_STATES as readonly string[]).includes(t)).toBe(true);
    }
    for (const t of INTENT_TERMINAL_STATES) {
      expect((INTENT_LIFECYCLE_STATES as readonly string[]).includes(t)).toBe(true);
    }
    for (const t of HYPOTHESIS_TERMINAL_STATES) {
      expect((HYPOTHESIS_LIFECYCLE_STATES as readonly string[]).includes(t)).toBe(true);
    }
  });

  it("all domains are covered in TRANSITION_DOMAINS", () => {
    expect(TRANSITION_DOMAINS).toContain("project");
    expect(TRANSITION_DOMAINS).toContain("intent");
    expect(TRANSITION_DOMAINS).toContain("run");
    expect(TRANSITION_DOMAINS).toContain("hypothesis");
    expect(TRANSITION_DOMAINS).toContain("approach");
  });

  it("invariant_repair is a legal trigger", () => {
    expect(TRANSITION_TRIGGERS).toContain("invariant_repair");
  });

  it("approach roles are defined", () => {
    expect(APPROACH_ROLES.length).toBeGreaterThanOrEqual(4);
    expect(APPROACH_ROLES).toContain("primary");
    expect(APPROACH_ROLES).toContain("control");
  });

  it("FAILURE_CLASSES has 5 classes", () => {
    expect(FAILURE_CLASSES).toEqual(["INFRA", "CODE", "POLICY", "VALIDATION", "IMPORT"]);
  });
});
