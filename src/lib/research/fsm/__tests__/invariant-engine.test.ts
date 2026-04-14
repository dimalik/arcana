import { describe, it, expect } from "vitest";
import { getInvariantsForDomain, INVARIANT_CATALOG } from "../invariant-catalog";

describe("invariant catalog", () => {
  it("has at least 10 invariants", () => {
    expect(INVARIANT_CATALOG.length).toBeGreaterThanOrEqual(10);
  });

  it("all invariants have key, class, and domain", () => {
    for (const inv of INVARIANT_CATALOG) {
      expect(inv.key).toBeTruthy();
      expect(["HARD", "SOFT", "AUDIT"]).toContain(inv.class);
      expect(inv.domain).toBeTruthy();
    }
  });

  it("getInvariantsForDomain returns correct subsets", () => {
    const proj = getInvariantsForDomain("project");
    expect(proj.length).toBeGreaterThan(0);
    expect(proj.every((i) => i.domain === "project")).toBe(true);
    const run = getInvariantsForDomain("run");
    expect(run.length).toBeGreaterThan(0);
  });

  it("SOFT invariants have escalation policy and TTL", () => {
    for (const inv of INVARIANT_CATALOG.filter((i) => i.class === "SOFT")) {
      expect(inv.escalationPolicy).toBeTruthy();
      expect(inv.ttlSeconds).toBeGreaterThan(0);
    }
  });

  it("covers all five domains", () => {
    const domains = new Set(INVARIANT_CATALOG.map((i) => i.domain));
    expect(domains.has("project")).toBe(true);
    expect(domains.has("run")).toBe(true);
    expect(domains.has("intent")).toBe(true);
    expect(domains.has("hypothesis")).toBe(true);
    expect(domains.has("approach")).toBe(true);
  });
});
