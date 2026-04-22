import "server-only";

import { tool } from "ai";
import { z } from "zod";

import { filterFigures, truncate } from "../../agent";

import {
  missingPaperMessage,
  paperLabelFor,
  requirePaper,
  type ToolContext,
} from "./context";

export function listFiguresTool(ctx: ToolContext) {
  return tool({
    description:
      "List figures and/or tables available in one attached paper. Use this before inspect_figure so you know what targets exist.",
    inputSchema: z.object({
      paperId: z.string(),
      kind: z.enum(["figure", "table", "any"]).optional().default("any"),
      query: z
        .string()
        .max(160)
        .optional()
        .describe("optional free-text filter on labels/captions"),
      limit: z.number().int().min(1).max(12).optional().default(6),
    }),
    execute: async ({ paperId, kind, query, limit }) => {
      const paper = requirePaper(ctx, paperId);
      if (!paper) return missingPaperMessage(ctx, paperId);
      const label = paperLabelFor(ctx, paperId);

      const figures = ctx.figuresByPaperId.get(paperId) ?? [];
      if (figures.length === 0) {
        ctx.onObservation({
          step: ctx.nextStep(),
          action: `List figures for ${label}`,
          detail: `No figures or tables are indexed for ${label}.`,
          phase: "retrieve",
          status: "missing",
          source: "planner",
          tool: "list_figures",
          input: `${label}:${kind}:${query ?? ""}`,
          outputPreview: `No figures indexed for ${label}.`,
        });
        return `No figures or tables are indexed for ${label}.`;
      }

      const filtered = filterFigures(figures, kind ?? "any", query).slice(
        0,
        limit ?? 6,
      );

      if (filtered.length === 0) {
        ctx.onObservation({
          step: ctx.nextStep(),
          action: `List figures for ${label}`,
          detail: `No figures matched kind=${kind} query="${query ?? ""}" for ${label}.`,
          phase: "retrieve",
          status: "missing",
          source: "planner",
          tool: "list_figures",
          input: `${label}:${kind}:${query ?? ""}`,
          outputPreview: `No matching figures/tables for ${label}.`,
        });
        return `No figures matched for ${label} with kind=${kind}, query="${query ?? ""}".`;
      }

      const lines = [`Figures/tables in ${label}:`];
      for (const figure of filtered) {
        const identifier = figure.figureLabel || figure.id;
        const page = figure.pdfPage ? `, p.${figure.pdfPage}` : "";
        const caption = figure.captionText
          ? ` — ${truncate(figure.captionText, 140)}`
          : "";
        lines.push(`- ${identifier} (${figure.type}${page})${caption}`);
      }
      lines.push("");
      lines.push(
        `Use inspect_figure with target=<label or id> to look at one in detail.`,
      );

      ctx.onObservation({
        step: ctx.nextStep(),
        action: `List figures for ${label}`,
        detail: lines.slice(1, -2).join("\n"),
        phase: "retrieve",
        status: "completed",
        source: "planner",
        tool: "list_figures",
        input: `${label}:${kind}:${query ?? ""}`,
        outputPreview: `${filtered.length} candidate ${kind === "any" ? "artifacts" : `${kind}s`} in ${label}.`,
      });

      return lines.join("\n");
    },
  });
}
