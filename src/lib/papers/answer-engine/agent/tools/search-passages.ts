import "server-only";

import { tool } from "ai";
import { z } from "zod";

import {
  MAX_CITATION_SNIPPET_CHARS,
  truncate,
} from "../../agent";
import type { AnswerCitation } from "../../metadata";

import { findQueryMatches } from "../text-search";
import {
  missingPaperMessage,
  paperLabelFor,
  requirePaper,
  type ToolContext,
} from "./context";

export function searchPassagesTool(ctx: ToolContext) {
  return tool({
    description:
      "Search for exact spans in one attached paper that match a query. Use this to recover specific evidence (numbers, method names, dataset names) rather than loading a whole section.",
    inputSchema: z.object({
      paperId: z.string(),
      query: z.string().min(2).max(200),
      scope: z
        .enum(["full_text", "results"])
        .optional()
        .default("full_text")
        .describe("where to search; 'results' is narrower and faster"),
      limit: z.number().int().min(1).max(5).optional().default(3),
    }),
    execute: async ({ paperId, query, scope, limit }) => {
      const paper = requirePaper(ctx, paperId);
      if (!paper) return missingPaperMessage(ctx, paperId);
      const label = paperLabelFor(ctx, paperId);

      const text =
        scope === "results"
          ? ctx.sectionsByPaperId.get(paperId)?.results ?? ""
          : paper.fullText ?? "";

      if (!text.trim()) {
        ctx.onObservation({
          step: ctx.nextStep(),
          action: `Search passages in ${label}`,
          detail: `Scope '${scope}' has no text for ${label}.`,
          phase: "retrieve",
          status: "missing",
          source: "planner",
          tool: "search_passages",
          input: `${label}:${scope}:${query}`,
          outputPreview: `No text in '${scope}' scope for ${label}.`,
        });
        return `No text available in '${scope}' scope for ${label}.`;
      }

      const matches = findQueryMatches(text, query, limit ?? 3);
      if (matches.length === 0) {
        ctx.onObservation({
          step: ctx.nextStep(),
          action: `Search passages in ${label}`,
          detail: `No passages matched "${query}" in ${scope}.`,
          phase: "retrieve",
          status: "missing",
          source: "planner",
          tool: "search_passages",
          input: `${label}:${scope}:${query}`,
          outputPreview: `No passages matched "${query}" in ${label}:${scope}.`,
        });
        return `No passages matched "${query}" in ${label}:${scope}. Try another query or a different paper.`;
      }

      const lines: string[] = [
        `Found ${matches.length} passage${matches.length === 1 ? "" : "s"} in ${label}:${scope}:`,
        "",
      ];
      const addedLabels: string[] = [];
      for (const match of matches) {
        const citation: AnswerCitation = {
          paperId: paper.id,
          paperTitle: paper.title,
          snippet: truncate(match.text, MAX_CITATION_SNIPPET_CHARS),
          sectionPath: scope === "results" ? "results" : "full_text",
          sourceKind: "artifact",
        };
        const idx = ctx.onCitation(citation);
        addedLabels.push(`[S${idx}]`);
        lines.push(`[S${idx}] ${truncate(match.text, 360)}`);
        lines.push("");
      }

      ctx.onObservation({
        step: ctx.nextStep(),
        action: `Search passages in ${label}`,
        detail: matches.map((m) => `- ${m.text}`).join("\n"),
        phase: "retrieve",
        status: "completed",
        source: "planner",
        tool: "search_passages",
        input: `${label}:${scope}:${query}`,
        outputPreview: `${matches.length} passage${matches.length === 1 ? "" : "s"} matched "${query}" in ${label}:${scope}.`,
        citationsAdded: matches.length,
      });

      lines.push(`Cite these passages using the labels above: ${addedLabels.join(" ")}.`);
      return lines.join("\n");
    },
  });
}
