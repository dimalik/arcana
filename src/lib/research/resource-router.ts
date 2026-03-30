/**
 * Resource Router — determines WHERE a script should run.
 *
 * Like Ray's @ray.remote(num_gpus=1), scripts declare what they need
 * and the system routes them automatically. The agent never decides
 * where to run — the infrastructure handles placement.
 *
 * Routing priority (highest to lowest):
 *   1. Exact filename match in ResourceRule
 *   2. Pattern match in ResourceRule (e.g., "analysis_*")
 *   3. Taxonomy defaults (exp_/poc_ → remote, analysis_ → local)
 *   4. Project-wide default (remote if hosts configured, else local)
 */

import { prisma } from "@/lib/prisma";

// ── Types ──────────────────────────────────────────────────────────

export type Runtime =
  | { type: "local" }
  | { type: "remote"; hostAlias?: string };

export interface RoutingDecision {
  runtime: Runtime;
  reason: string;       // human-readable explanation
  ruleId?: string;      // which ResourceRule matched (if any)
}

// ── Taxonomy defaults ──────────────────────────────────────────────

/**
 * Built-in routing defaults based on the naming taxonomy.
 * These apply when no ResourceRule matches.
 */
const TAXONOMY_DEFAULTS: { pattern: RegExp; runtime: Runtime; reason: string }[] = [
  {
    pattern: /^exp_\d+/,
    runtime: { type: "remote" },
    reason: "Full experiments (exp_*) default to remote GPU execution",
  },
  {
    pattern: /^poc_\d+/,
    runtime: { type: "remote" },
    reason: "Proof-of-concept scripts (poc_*) default to remote GPU execution",
  },
  {
    pattern: /^sweep_\d+/,
    runtime: { type: "remote" },
    reason: "Parameter sweeps (sweep_*) default to remote GPU execution",
  },
  {
    pattern: /^analysis_\d+/,
    runtime: { type: "local" },
    reason: "Analysis scripts (analysis_*) default to local execution",
  },
];

// ── Pattern matching ───────────────────────────────────────────────

/**
 * Convert a glob-like pattern to a regex.
 * Supports: * (any chars), ? (single char), exact match.
 */
function patternToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")  // escape regex specials
    .replace(/\*/g, ".*")                    // * → .*
    .replace(/\?/g, ".");                    // ? → .
  return new RegExp(`^${escaped}$`, "i");
}

/**
 * Check if a script name matches a pattern.
 */
function matchesPattern(scriptName: string, pattern: string): boolean {
  // Exact match (fast path)
  if (pattern === scriptName) return true;
  if (pattern === "*") return true;

  // Glob match
  return patternToRegex(pattern).test(scriptName);
}

// ── Router ─────────────────────────────────────────────────────────

/**
 * Determine where a script should run.
 *
 * @param projectId - The research project
 * @param scriptName - The script filename (e.g., "exp_003_lora.py")
 * @param hasRemoteHosts - Whether any remote hosts are configured
 * @returns The routing decision with reason
 */
export async function routeScript(
  projectId: string,
  scriptName: string,
  hasRemoteHosts: boolean,
): Promise<RoutingDecision> {
  // 1. Check project-specific ResourceRules (ordered by priority desc)
  const rules = await prisma.resourceRule.findMany({
    where: { projectId },
    orderBy: { priority: "desc" },
  });

  // Find the best matching rule
  for (const rule of rules) {
    if (matchesPattern(scriptName, rule.pattern)) {
      const runtime = parseRuntime(rule.runtime);
      return {
        runtime,
        reason: rule.reason || `Matched rule: "${rule.pattern}" → ${rule.runtime}`,
        ruleId: rule.id,
      };
    }
  }

  // 2. Fall back to taxonomy defaults
  for (const def of TAXONOMY_DEFAULTS) {
    if (def.pattern.test(scriptName)) {
      // If the default says remote but no hosts are configured, fall back to local
      if (def.runtime.type === "remote" && !hasRemoteHosts) {
        return {
          runtime: { type: "local" },
          reason: `${def.reason}, but no remote hosts configured — running locally`,
        };
      }
      return {
        runtime: def.runtime,
        reason: def.reason,
      };
    }
  }

  // 3. Project-wide default
  if (hasRemoteHosts) {
    return {
      runtime: { type: "remote" },
      reason: "No matching rule or taxonomy — defaulting to remote (hosts available)",
    };
  }

  return {
    runtime: { type: "local" },
    reason: "No matching rule, no remote hosts — running locally",
  };
}

// ── Rule management ────────────────────────────────────────────────

/**
 * Create or update a resource rule for a project.
 * If a rule with the same pattern exists, it's updated.
 */
export async function upsertResourceRule(
  projectId: string,
  pattern: string,
  runtime: string,
  reason?: string,
  needs?: string[],
  priority?: number,
): Promise<string> {
  // Check for existing rule with same pattern
  const existing = await prisma.resourceRule.findFirst({
    where: { projectId, pattern },
  });

  if (existing) {
    await prisma.resourceRule.update({
      where: { id: existing.id },
      data: {
        runtime,
        reason: reason || existing.reason,
        needs: needs ? JSON.stringify(needs) : existing.needs,
        priority: priority ?? existing.priority,
      },
    });
    return existing.id;
  }

  const rule = await prisma.resourceRule.create({
    data: {
      projectId,
      pattern,
      runtime,
      reason,
      needs: needs ? JSON.stringify(needs) : null,
      priority: priority ?? 0,
    },
  });

  return rule.id;
}

// ── Helpers ────────────────────────────────────────────────────────

function parseRuntime(runtime: string): Runtime {
  if (runtime === "local") return { type: "local" };
  if (runtime.startsWith("remote:")) {
    return { type: "remote", hostAlias: runtime.slice("remote:".length) };
  }
  return { type: "remote" };
}
