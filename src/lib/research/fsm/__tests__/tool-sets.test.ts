import { describe, it, expect } from "vitest";
import {
  CROSS_CUTTING_TOOLS,
  STATE_TOOLS,
  getToolsForState,
  isToolAvailable,
} from "../tool-sets";
import { PROJECT_STATES } from "../types";
import type { ProjectState } from "../types";

describe("tool-sets", () => {
  describe("DISCOVERY state", () => {
    it("includes search_papers but not run_experiment", () => {
      const tools = getToolsForState("DISCOVERY");
      expect(tools).toContain("search_papers");
      expect(tools).not.toContain("run_experiment");
    });
  });

  describe("EXECUTION state", () => {
    it("includes run_experiment but not define_metrics", () => {
      const tools = getToolsForState("EXECUTION");
      expect(tools).toContain("run_experiment");
      expect(tools).not.toContain("define_metrics");
    });
  });

  describe("DESIGN state", () => {
    it("includes define_metrics and define_evaluation_protocol", () => {
      const tools = getToolsForState("DESIGN");
      expect(tools).toContain("define_metrics");
      expect(tools).toContain("define_evaluation_protocol");
    });
  });

  describe("cross-cutting tools in all states", () => {
    it.each(PROJECT_STATES.map((s) => [s]))(
      "%s includes all cross-cutting tools",
      (state) => {
        const tools = getToolsForState(state as ProjectState);
        for (const crossCutting of CROSS_CUTTING_TOOLS) {
          expect(tools).toContain(crossCutting);
        }
      },
    );
  });

  describe("COMPLETE state", () => {
    it("has only cross-cutting tools", () => {
      const tools = getToolsForState("COMPLETE");
      expect(tools).not.toContain("run_experiment");
      expect(tools).not.toContain("search_papers");
      expect(tools).not.toContain("define_metrics");
      expect(tools).not.toContain("record_result");
      expect(tools).not.toContain("write_file");
      // COMPLETE has read-only tools + cross-cutting
      expect(tools).toContain("read_file");
      expect(tools).toContain("view_figures");
    });
  });

  describe("isToolAvailable", () => {
    it("returns true for cross-cutting tools in any state", () => {
      expect(isToolAvailable("read_file", "DISCOVERY")).toBe(true);
      expect(isToolAvailable("read_file", "COMPLETE")).toBe(true);
      expect(isToolAvailable("request_help", "DESIGN")).toBe(true);
    });

    it("returns true for state-specific tools in the correct state", () => {
      expect(isToolAvailable("search_papers", "DISCOVERY")).toBe(true);
      expect(isToolAvailable("run_experiment", "EXECUTION")).toBe(true);
      expect(isToolAvailable("define_metrics", "DESIGN")).toBe(true);
      expect(isToolAvailable("record_result", "ANALYSIS")).toBe(true);
      expect(isToolAvailable("query_results", "DECISION")).toBe(true);
    });

    it("returns false for state-specific tools in the wrong state", () => {
      expect(isToolAvailable("search_papers", "EXECUTION")).toBe(false);
      expect(isToolAvailable("run_experiment", "DISCOVERY")).toBe(false);
      expect(isToolAvailable("define_metrics", "EXECUTION")).toBe(false);
      expect(isToolAvailable("run_experiment", "COMPLETE")).toBe(false);
    });

    it("returns false for unknown tools", () => {
      expect(isToolAvailable("nonexistent_tool", "DISCOVERY")).toBe(false);
      expect(isToolAvailable("nonexistent_tool", "COMPLETE")).toBe(false);
    });
  });
});
