import "server-only";

import type { PaperFigureView } from "@/lib/figures/read-model";

import type { PaperAnswerIntent } from "../metadata";
import type { PaperAgentPaperContext, SummarySectionName } from "./types";

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars - 1).trimEnd()}…`;
}

function availableSections(
  sections: Record<SummarySectionName, string>,
): string {
  const names: SummarySectionName[] = ["overview", "methodology", "results"];
  return names
    .filter((name) => Boolean(sections[name]?.trim()))
    .join(", ") || "(none extracted)";
}

function figureSummary(figures: PaperFigureView[]): string {
  if (figures.length === 0) return "0";
  const tables = figures.filter((f) => f.type === "table").length;
  return `${figures.length} total, ${tables} table${tables === 1 ? "" : "s"}`;
}

export interface BuildSystemPromptParams {
  papers: Map<string, PaperAgentPaperContext>;
  paperIds: string[];
  paperLabels: Map<string, string>;
  sectionsByPaperId: Map<string, Record<SummarySectionName, string>>;
  figuresByPaperId: Map<string, PaperFigureView[]>;
  primaryPaperId: string;
  intentHint: PaperAnswerIntent;
  selectedText: string | null;
}

export function buildSystemPrompt(params: BuildSystemPromptParams): string {
  const paperLines = params.paperIds.map((id) => {
    const paper = params.papers.get(id);
    const label = params.paperLabels.get(id) ?? id;
    const primaryMarker = id === params.primaryPaperId ? " (primary)" : "";
    const title = paper?.title ?? id;
    const year = paper?.year ? ` (${paper.year})` : "";
    const sections = availableSections(
      params.sectionsByPaperId.get(id) ?? { overview: "", methodology: "", results: "" },
    );
    const figures = figureSummary(params.figuresByPaperId.get(id) ?? []);
    const claimCount = paper?.claims.length ?? 0;
    return [
      `[${label}]${primaryMarker} "${title}"${year}  id: ${id}`,
      `    sections: ${sections}  |  figures: ${figures}  |  claims: ${claimCount}`,
    ].join("\n");
  });

  const selectedBlock = params.selectedText
    ? `\nSelected passage from the UI (belongs to the primary paper):\n"""\n${truncate(
        params.selectedText,
        800,
      )}\n"""\n`
    : "";

  return `You are a research-paper chat agent. Answer the user's question about the attached paper(s) using the tools below.

Attached papers:
${paperLines.join("\n")}

Intent hint: ${params.intentHint}
${selectedBlock}
Tools at your disposal (see their input schemas):
- read_section: load a curated section from one paper
- search_passages: find spans matching a query in one paper
- search_claims: find grounded, rhetorically-tagged claims in one paper
- list_figures: enumerate figures and tables for one paper
- inspect_figure: inspect one figure or table in detail; use mode "preview" for a table overview, "row" to recover a specific row, "value" to recover a specific cell, or "visual" to read the figure image directly
- generate_code_snippet: produce a CODE_SNIPPET artifact derived from paper evidence
- finish: stop and hand an answerPlan string back to the streaming answer layer

Rules:
- Every tool takes a paperId. Pick the paper id from the attached list above.
- Use only tool outputs as evidence. Do not rely on outside knowledge of the paper.
- Each tool result includes [S1], [S2], … source labels. Cite those labels in your final answerPlan.
- Do not repeat the same tool call with the same arguments; if a tool returns no match, try a different angle or paper.
- When you have enough evidence, call finish with a short answerPlan describing what to tell the user. Do not write a full essay there — the streaming answer layer will compose the final reply using your gathered evidence plus the plan.
- Cross-paper structured analysis (contradictions, gaps, timelines, methodology tables as typed artifacts) is NOT in scope for chat. If the user asks for those, do the best prose answer you can from single-paper tool outputs across the attached papers and note the limitation.`;
}
