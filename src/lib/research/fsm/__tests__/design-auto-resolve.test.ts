import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {},
}));

vi.mock("@prisma/client", () => ({
  Prisma: {},
}));

import { deriveDefaultProtocol } from "../../evaluation-protocol";

describe("deriveDefaultProtocol", () => {
  it("derives protocol from metric schema — primary = first metric, secondary = rest", () => {
    const metrics = [
      { name: "accuracy", direction: "higher" },
      { name: "f1_score" },
      { name: "latency_ms", direction: "lower" },
    ];

    const protocol = deriveDefaultProtocol(metrics);

    expect(protocol).not.toBeNull();
    expect(protocol!.primaryMetric).toBe("accuracy");
    expect(protocol!.secondaryMetrics).toEqual(["f1_score", "latency_ms"]);
    expect(protocol!.seeds).toEqual([42, 123, 456]);
    expect(protocol!.minRuns).toBe(1);
    expect(protocol!.datasets).toEqual([]);
    expect(protocol!.statisticalTest).toBe("bootstrap 95% CI");
    expect(protocol!.requiredBaselines).toEqual([]);
    expect(protocol!.notes).toContain("Auto-derived from project metrics");
  });

  it("returns null for empty metrics array", () => {
    const protocol = deriveDefaultProtocol([]);
    expect(protocol).toBeNull();
  });

  it('uses "decrease" for lower-is-better metrics', () => {
    const metrics = [{ name: "loss", direction: "lower" }];
    const protocol = deriveDefaultProtocol(metrics);

    expect(protocol).not.toBeNull();
    expect(protocol!.acceptanceCriteria).toContain("decrease");
    expect(protocol!.acceptanceCriteria).not.toContain("improvement");
  });

  it('uses "improvement" for higher-is-better or unspecified direction', () => {
    const metricsHigher = [{ name: "accuracy", direction: "higher" }];
    const protocolHigher = deriveDefaultProtocol(metricsHigher);
    expect(protocolHigher!.acceptanceCriteria).toContain("improvement");

    const metricsUnspecified = [{ name: "score" }];
    const protocolUnspecified = deriveDefaultProtocol(metricsUnspecified);
    expect(protocolUnspecified!.acceptanceCriteria).toContain("improvement");
  });
});
