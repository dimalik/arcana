import "server-only";

import { tool } from "ai";
import { z } from "zod";

import {
  citationForSection,
  MAX_CITATION_SNIPPET_CHARS,
  truncate,
} from "../../agent";

import {
  missingPaperMessage,
  paperLabelFor,
  requirePaper,
  type ToolContext,
} from "./context";

export function readSectionTool(ctx: ToolContext) {
  return tool({
    description:
      "Load a curated section (overview, methodology, or results) of one attached paper. Use this for bulk section content; use search_passages for targeted spans.",
    inputSchema: z.object({
      paperId: z.string().describe("id of one of the attached papers"),
      section: z
        .enum(["overview", "methodology", "results"])
        .describe("which section to load"),
    }),
    execute: async ({ paperId, section }) => {
      const paper = requirePaper(ctx, paperId);
      if (!paper) return missingPaperMessage(ctx, paperId);

      const sections = ctx.sectionsByPaperId.get(paperId);
      const text = sections?.[section] ?? "";
      const label = paperLabelFor(ctx, paperId);

      if (!text.trim()) {
        ctx.onObservation({
          step: ctx.nextStep(),
          action: `Read ${section} section of ${label}`,
          detail: `${section} section is not available in extracted paper text.`,
          phase: "retrieve",
          status: "missing",
          source: "planner",
          tool: "read_section",
          input: `${label}:${section}`,
          outputPreview: `${section} section unavailable for ${label}.`,
        });
        return `The '${section}' section is not available for ${label}. Try another section, another paper, or search_passages.`;
      }

      const citation = citationForSection(paper, section, text);
      const citationIndex = ctx.onCitation(citation);

      ctx.onObservation({
        step: ctx.nextStep(),
        action: `Read ${section} section of ${label}`,
        detail: truncate(text, 600),
        phase: "retrieve",
        status: "completed",
        source: "planner",
        tool: "read_section",
        input: `${label}:${section}`,
        outputPreview: `Loaded ${section} evidence for ${label}.`,
        citationsAdded: 1,
      });

      return [
        `Section '${section}' of ${label} loaded (cite as [S${citationIndex}]):`,
        "",
        truncate(text, 1800),
        "",
        `[S${citationIndex}] ${paper.title}${section ? ` / ${section}` : ""}`,
        truncate(citation.snippet, MAX_CITATION_SNIPPET_CHARS),
      ].join("\n");
    },
  });
}
