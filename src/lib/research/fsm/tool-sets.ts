// ---------------------------------------------------------------------------
// Tool Sets Per State
// Maps each ProjectState to its available tool subset. The research agent uses
// this to restrict which tools the LLM can invoke in each phase of the
// project lifecycle.
// ---------------------------------------------------------------------------

import type { ProjectState } from "./types";

/**
 * Tools available in ALL states. These provide basic workspace operations,
 * knowledge management, and help facilities that are always relevant.
 */
/**
 * Tools available in ALL states. Only truly universal operations.
 * Everything else is state-specific to keep the agent focused.
 */
export const CROSS_CUTTING_TOOLS = [
  "read_file",
  "list_files",
  "get_workspace",
  "request_help",
  "run_infrastructure",
] as const;

/**
 * State-specific tools. Each state has a curated subset of tools that make
 * sense for the work happening in that phase.
 */
export const STATE_TOOLS: Record<ProjectState, readonly string[]> = {
  DISCOVERY: [
    "search_papers",
    "remove_paper",
    "read_paper",
    "dispatch_scouts",
    "dispatch_synthesizer",
    "collect_results",
    "search_library",
    "query_insights",
    "query_skills",
    "log_finding",
    "web_search",
    "fetch_webpage",
    "view_approach_tree",
  ],
  HYPOTHESIS: [
    "read_paper",
    "search_library",
    "query_insights",
    "log_finding",
    "register_approach",
    "commit_to_approach",
    "abandon_approach",
    "dispatch_architect",
    "collect_results",
    "search_papers",
    "web_search",
    "fetch_webpage",
    "view_approach_tree",
  ],
  DESIGN: [
    // Locked down: define metrics, refine protocol, that's it.
    "define_metrics",
    "define_evaluation_protocol",
    "show_evaluation_protocol",
    "register_approach",
    "view_approach_tree",
    "validate_environment",
    "diagnose_remote_host",
    "create_intent",
  ],
  EXECUTION: [
    // Focused: write code, run it, monitor it. No literature browsing.
    "write_file",
    "delete_file",
    "write_shared_utility",
    "clean_workspace",
    "run_experiment",
    "execute_remote",
    "run_experiment_sweep",
    "check_job",
    "wait_for_jobs",
    "cancel_job",
    "monitor_experiment",
    "validate_environment",
    "diagnose_remote_host",
    "show_evaluation_protocol",
    "extract_results",
    "collect_results",
    "save_lesson",
    "view_figures",
  ],
  ANALYSIS: [
    "write_file",
    "delete_file",
    "read_paper",
    "search_library",
    "query_insights",
    "log_finding",
    "save_lesson",
    "view_figures",
    "view_approach_tree",
    "record_result",
    "query_results",
    "record_claim",
    "attach_claim_evidence",
    "review_claim",
    "promote_claim_to_memory",
    "show_claim_ledger",
    "update_hypothesis",
    "reflect_on_failure",
    "adversarial_review",
    "dispatch_reviewer",
    "dispatch_reproducer",
    "dispatch_provocateur",
    "dispatch_visualizer",
    "show_evaluation_protocol",
    "collect_results",
    "design_creative_portfolio",
  ],
  DECISION: [
    "query_results",
    "show_evaluation_protocol",
    "show_claim_ledger",
    "record_claim",
    "update_hypothesis",
    "view_approach_tree",
    "complete_iteration",
  ],
  COMPLETE: [
    "view_figures",
    "query_results",
    "show_claim_ledger",
  ],
} as const;

/**
 * Returns the deduplicated union of cross-cutting tools and state-specific
 * tools for the given project state.
 */
export function getToolsForState(state: ProjectState): string[] {
  const stateSpecific = STATE_TOOLS[state];
  const combined = new Set<string>([...CROSS_CUTTING_TOOLS, ...stateSpecific]);
  return Array.from(combined);
}

/**
 * Returns whether a given tool name is available in the specified state.
 */
export function isToolAvailable(tool: string, state: ProjectState): boolean {
  return (
    (CROSS_CUTTING_TOOLS as readonly string[]).includes(tool) ||
    STATE_TOOLS[state].includes(tool)
  );
}
