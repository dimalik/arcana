import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    transitionRecord: { findUnique: vi.fn(), findMany: vi.fn() },
    researchProject: { findUnique: vi.fn() },
    invariantViolation: { findMany: vi.fn() },
    experimentIntent: { count: vi.fn() },
    experimentRun: { count: vi.fn() },
    researchHypothesis: { count: vi.fn() },
    researchClaim: { count: vi.fn() },
  },
}));

vi.mock("../transition-engine", () => ({
  fetchGuardContext: vi.fn().mockResolvedValue({}),
}));

describe("why-layer exports", () => {
  it("exports explainTransition", async () => {
    const mod = await import("../why-layer");
    expect(typeof mod.explainTransition).toBe("function");
  });
  it("exports explainBlocker", async () => {
    const mod = await import("../why-layer");
    expect(typeof mod.explainBlocker).toBe("function");
  });
  it("exports getStateReport", async () => {
    const mod = await import("../why-layer");
    expect(typeof mod.getStateReport).toBe("function");
  });
  it("exports deriveWhatWouldSatisfy", async () => {
    const mod = await import("../why-layer");
    expect(typeof mod.deriveWhatWouldSatisfy).toBe("function");
  });
  it("deriveWhatWouldSatisfy returns hints for known checks", async () => {
    const { deriveWhatWouldSatisfy } = await import("../why-layer");
    expect(deriveWhatWouldSatisfy("metrics_defined", "")).toContain("define_metrics");
    expect(deriveWhatWouldSatisfy("ready_intents", "")).toContain("create_intent");
    expect(deriveWhatWouldSatisfy("unknown_check", "some detail")).toContain("unknown_check");
  });
});
