export type NotebookEntryKind = "finding" | "hypothesis" | "decision" | "question" | "breakthrough";

const PLAN_PATTERNS = [
  /^SESSION\s+\d+\s+PLAN\b/im,
  /^RESEARCH\s+PLAN\b/im,
  /\bSITUATION ASSESSMENT:\b/im,
  /\bCRITICAL ASSESSMENT\b/im,
  /\bWHAT A REVIEWER WOULD CRITICIZE\b/im,
  /\bFIXES NEEDED:\b/im,
];

export function isPlanningNotebookEntry(content: string | null | undefined) {
  const normalized = (content || "").replace(/\r/g, "").trim();
  if (!normalized) return false;
  return PLAN_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function getNotebookLogType(kind: NotebookEntryKind, content: string) {
  if (kind === "finding") return "observation";
  if (kind === "hypothesis") return "agent_suggestion";
  if (kind === "breakthrough") return "breakthrough";
  if (kind === "question") return "question";
  return isPlanningNotebookEntry(content) ? "planning_note" : "decision";
}

export function shouldHideResearchLogFromTimeline(entry: { type: string; content: string }) {
  if (entry.type === "agent_suggestion" || entry.type === "agent_reasoning" || entry.type === "agent_tool_call" || entry.type === "help_request" || entry.type === "planning_note") {
    return true;
  }
  if (entry.content.startsWith("[")) return true;
  if (entry.type === "decision" && isPlanningNotebookEntry(entry.content)) return true;
  return false;
}
