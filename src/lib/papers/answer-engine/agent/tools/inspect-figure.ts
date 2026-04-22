import "server-only";

import { tool } from "ai";
import { z } from "zod";

import {
  buildFigureArtifact,
  citationForFigure,
  MAX_CITATION_SNIPPET_CHARS,
  parseHtmlTable,
  queryParsedTable,
  queryParsedTableRow,
  queryParsedTableValue,
  resolveFigureTarget,
  stripHtml,
  truncate,
} from "../../agent";
import type { AnswerCitation } from "../../metadata";

import { tokenizeQuery } from "../text-search";
import {
  missingPaperMessage,
  paperLabelFor,
  requirePaper,
  type ToolContext,
} from "./context";

export function inspectFigureTool(ctx: ToolContext) {
  return tool({
    description: [
      "Inspect one figure or table from a paper in detail.",
      "Modes:",
      "  preview  — table overview (columns + matched rows) or figure caption",
      "  row      — recover the best matching row from a table",
      "  value    — recover the best matching cell value from a table (row × column)",
      "  visual   — read the figure image directly via vision (use only for non-table figures when text evidence is insufficient)",
    ].join("\n"),
    inputSchema: z.object({
      paperId: z.string(),
      target: z
        .string()
        .min(1)
        .max(160)
        .describe("figure/table label or id (e.g. 'Table 4', 'Figure 2')"),
      mode: z
        .enum(["preview", "row", "value", "visual"])
        .optional()
        .default("preview"),
      query: z
        .string()
        .max(200)
        .optional()
        .describe("query to focus row/value extraction or visual matching"),
    }),
    execute: async ({ paperId, target, mode, query }) => {
      const paper = requirePaper(ctx, paperId);
      if (!paper) return missingPaperMessage(ctx, paperId);
      const label = paperLabelFor(ctx, paperId);

      const figures = ctx.figuresByPaperId.get(paperId) ?? [];
      const figure = resolveFigureTarget(figures, target);
      if (!figure) {
        ctx.onObservation({
          step: ctx.nextStep(),
          action: `Inspect "${target}" in ${label}`,
          detail: `No figure or table matched "${target}".`,
          phase: "inspect",
          status: "missing",
          source: "planner",
          tool: "inspect_figure",
          input: `${label}:${target}:${mode}`,
          outputPreview: `No target matched "${target}" in ${label}.`,
        });
        return `No figure or table matched "${target}" in ${label}. Call list_figures first to see valid targets.`;
      }

      const figureLabel = figure.figureLabel || figure.id;
      const isTable = figure.type === "table";

      if (mode === "visual") {
        if (isTable) {
          return `inspect_figure(mode="visual") is only for non-table figures. Use mode="preview", "row", or "value" on the extracted table instead.`;
        }
        if (!figure.imagePath) {
          ctx.onObservation({
            step: ctx.nextStep(),
            action: `Vision inspect ${figureLabel} in ${label}`,
            detail: `No image on disk for ${figureLabel}.`,
            phase: "inspect",
            status: "missing",
            source: "planner",
            tool: "inspect_figure",
            input: `${label}:${figureLabel}:visual`,
            outputPreview: `No image available for ${figureLabel}.`,
          });
          return `No image available for ${figureLabel} in ${label}.`;
        }

        // Dynamic import keeps vision logic isolated; v1 helper still owns it.
        const { inspectFigureWithVision } = await import("../../agent");
        const q = query ?? ctx.question;
        const searchTerms = tokenizeQuery(q).slice(0, 8);
        const visual = await inspectFigureWithVision({
          figure,
          question: q,
          searchTerms,
          provider: ctx.provider,
          modelId: ctx.modelId,
          proxyConfig: ctx.proxyConfig,
          userId: ctx.userId,
        });

        const figureCitation = citationForFigure(paper, figure);
        const figureIdx = ctx.onCitation(figureCitation);
        const labels: string[] = [`[S${figureIdx}]`];
        for (const match of visual.matches) {
          const c: AnswerCitation = {
            paperId: paper.id,
            paperTitle: paper.title,
            snippet: truncate(match.text, MAX_CITATION_SNIPPET_CHARS),
            sectionPath: figure.figureLabel,
            sourceKind: "artifact",
          };
          const idx = ctx.onCitation(c);
          labels.push(`[S${idx}]`);
        }
        ctx.onArtifact(
          buildFigureArtifact(figure, {
            figureQuery: q,
            textMatches: visual.matches,
          }),
        );

        ctx.onObservation({
          step: ctx.nextStep(),
          action: `Vision inspect ${figureLabel} in ${label}`,
          detail:
            visual.matches.length > 0
              ? visual.matches.map((m) => `- ${m.text}`).join("\n")
              : (visual.note ?? "No visual evidence recovered."),
          phase: "inspect",
          status: visual.matches.length > 0 ? "completed" : "missing",
          source: "planner",
          tool: "inspect_figure",
          input: `${label}:${figureLabel}:visual`,
          outputPreview:
            visual.matches.length > 0
              ? `${visual.matches.length} visual match${visual.matches.length === 1 ? "" : "es"} in ${figureLabel}.`
              : `No visual evidence recovered from ${figureLabel}.`,
          citationsAdded: 1 + visual.matches.length,
          artifactsAdded: 1,
        });

        if (visual.matches.length === 0) {
          return `Inspected ${figureLabel} visually; no spans matched the query. ${visual.note ?? ""}`.trim();
        }
        const lines = [`Vision evidence from ${figureLabel} in ${label}:`];
        visual.matches.forEach((match, i) => {
          const cite = labels[i + 1];
          lines.push(`${cite} ${truncate(match.text, 320)}`);
        });
        return lines.join("\n");
      }

      // Non-visual modes operate on the parsed table structure.
      if (!isTable) {
        // For plain figures, fall back to returning the caption + description.
        const citation = citationForFigure(paper, figure);
        const idx = ctx.onCitation(citation);
        ctx.onArtifact(
          buildFigureArtifact(figure, {
            figureQuery: query ?? ctx.question,
          }),
        );

        ctx.onObservation({
          step: ctx.nextStep(),
          action: `Inspect ${figureLabel} in ${label}`,
          detail:
            figure.captionText ??
            figure.description ??
            "No caption available.",
          phase: "inspect",
          status: "completed",
          source: "planner",
          tool: "inspect_figure",
          input: `${label}:${figureLabel}:${mode}`,
          outputPreview: `${figureLabel} opened for inspection.`,
          citationsAdded: 1,
          artifactsAdded: 1,
        });

        return [
          `${figureLabel} (${figure.type}) in ${label} — cite as [S${idx}]:`,
          figure.captionText
            ? `Caption: ${figure.captionText}`
            : "(no caption extracted)",
          figure.description
            ? `Description: ${truncate(stripHtml(figure.description), 600)}`
            : "",
          "",
          `To read the figure image directly, call inspect_figure again with mode="visual".`,
        ]
          .filter(Boolean)
          .join("\n");
      }

      // Table modes: preview | row | value
      const parsed = parseHtmlTable(figure.description);
      if (!parsed) {
        ctx.onObservation({
          step: ctx.nextStep(),
          action: `Inspect ${figureLabel} in ${label}`,
          detail: `Structured rows could not be extracted from ${figureLabel}.`,
          phase: "inspect",
          status: "missing",
          source: "planner",
          tool: "inspect_figure",
          input: `${label}:${figureLabel}:${mode}`,
          outputPreview: `${figureLabel}: structured rows unavailable.`,
        });
        return `${figureLabel} in ${label} has no parseable table structure. Try mode="visual" if this is actually a figure.`;
      }

      const effectiveQuery = query ?? ctx.question;
      const matches = queryParsedTable(parsed, effectiveQuery);
      const exactRow =
        mode === "row" || mode === "value"
          ? queryParsedTableRow(parsed, effectiveQuery)
          : null;
      const exactValue =
        mode === "value" ? queryParsedTableValue(parsed, effectiveQuery) : null;

      const figureCitation = citationForFigure(paper, figure);
      const labels: string[] = [`[S${ctx.onCitation(figureCitation)}]`];

      if (exactValue) {
        const c: AnswerCitation = {
          paperId: paper.id,
          paperTitle: paper.title,
          snippet: `${figureLabel} [${exactValue.rowLabel} × ${exactValue.columnLabel}]: ${exactValue.value}`,
          sectionPath: figure.figureLabel,
          sourceKind: "artifact",
        };
        labels.push(`[S${ctx.onCitation(c)}]`);
      } else if (exactRow) {
        const c: AnswerCitation = {
          paperId: paper.id,
          paperTitle: paper.title,
          snippet: `${figureLabel} row ${exactRow.rowIndex + 1}: ${exactRow.values.join(" | ")}`,
          sectionPath: figure.figureLabel,
          sourceKind: "artifact",
        };
        labels.push(`[S${ctx.onCitation(c)}]`);
      } else if (matches[0]) {
        const c: AnswerCitation = {
          paperId: paper.id,
          paperTitle: paper.title,
          snippet: `${figureLabel} row ${matches[0].rowIndex + 1}: ${matches[0].values.join(" | ")}`,
          sectionPath: figure.figureLabel,
          sourceKind: "artifact",
        };
        labels.push(`[S${ctx.onCitation(c)}]`);
      }

      ctx.onArtifact(
        buildFigureArtifact(figure, {
          tableQuery: effectiveQuery,
          exactRow,
          exactValue,
        }),
      );

      const detail = exactValue
        ? `${figureLabel}: ${exactValue.rowLabel} × ${exactValue.columnLabel} = ${exactValue.value}.`
        : exactRow
          ? `${figureLabel}: row ${exactRow.rowIndex + 1} matched (${exactRow.values.join(" | ")}).`
          : `${figureLabel}: ${parsed.rows.length} rows, ${matches.length} matched preview rows.`;

      ctx.onObservation({
        step: ctx.nextStep(),
        action: `Inspect ${figureLabel} in ${label} (${mode})`,
        detail,
        phase: "inspect",
        status: "completed",
        source: "planner",
        tool: "inspect_figure",
        input: `${label}:${figureLabel}:${mode}`,
        outputPreview: detail,
        citationsAdded: labels.length,
        artifactsAdded: 1,
      });

      const lines = [
        `${figureLabel} (${label}, mode=${mode}) — cite as ${labels.join(" ")}`,
        `Columns: ${parsed.columns.join(" | ")}`,
      ];
      if (exactValue) {
        lines.push(`Exact value: ${exactValue.rowLabel} × ${exactValue.columnLabel} = ${exactValue.value}`);
      } else if (exactRow) {
        lines.push(`Exact row: ${exactRow.values.join(" | ")}`);
      } else if (matches.length > 0) {
        lines.push(`Matched rows:`);
        for (const m of matches.slice(0, 4)) {
          lines.push(`  row ${m.rowIndex + 1}: ${m.values.join(" | ")}`);
        }
      } else {
        lines.push(`(no rows matched the query; preview only)`);
        for (const row of parsed.rows.slice(0, 3)) {
          lines.push(`  ${row.join(" | ")}`);
        }
      }
      return lines.join("\n");
    },
  });
}
