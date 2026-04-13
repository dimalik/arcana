/**
 * Static invariant tests for the FSM architecture.
 *
 * These tests grep the codebase to catch violations that would
 * silently bypass the FSM — the exact class of bug that caused
 * the 95% agent failure rate.
 *
 * Run as part of CI to prevent regressions.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import path from "path";

const ROOT = path.resolve(__dirname, "../../../../..");
const AGENT_PATH = path.join(ROOT, "src/lib/research/agent.ts");

describe("FSM invariant: tool-set completeness", () => {
  it("every tool defined in agent.ts appears in at least one state's tool set", async () => {
    const agentSource = readFileSync(AGENT_PATH, "utf-8");

    // Extract tool names from "    toolName: tool({" patterns
    const toolPattern = /^\s+(\w+): tool\(\{/gm;
    const definedTools = new Set<string>();
    let match;
    while ((match = toolPattern.exec(agentSource)) !== null) {
      definedTools.add(match[1]);
    }

    expect(definedTools.size).toBeGreaterThan(20); // sanity check — we know there are 50+ tools

    const { getToolsForState } = await import("../tool-sets");
    const { PROJECT_STATES } = await import("../types");

    const allAvailable = new Set<string>();
    for (const state of PROJECT_STATES) {
      for (const tool of getToolsForState(state)) {
        allAvailable.add(tool);
      }
    }

    const missing = Array.from(definedTools).filter((tool) => !allAvailable.has(tool));

    if (missing.length > 0) {
      console.error("MISSING from tool-sets.ts — these tools exist in agent.ts but are not in any state:");
      missing.forEach((t) => console.error(`  - ${t}`));
    }
    expect(missing).toEqual([]);
  });
});
