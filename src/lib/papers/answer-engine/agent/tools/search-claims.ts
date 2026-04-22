import "server-only";

import { tool } from "ai";
import { z } from "zod";

import {
  citationForClaim,
  rankClaimsForQuery,
  truncate,
} from "../../agent";

import {
  missingPaperMessage,
  paperLabelFor,
  requirePaper,
  type ToolContext,
} from "./context";

export function searchClaimsTool(ctx: ToolContext) {
  return tool({
    description:
      "Search for extracted claims from one attached paper ranked by relevance to a query. Each claim carries a rhetorical role (method, result, limitation, ...) and is grounded in a source excerpt.",
    inputSchema: z.object({
      paperId: z.string(),
      query: z.string().min(2).max(200),
      limit: z.number().int().min(1).max(8).optional().default(4),
    }),
    execute: async ({ paperId, query, limit }) => {
      const paper = requirePaper(ctx, paperId);
      if (!paper) return missingPaperMessage(ctx, paperId);
      const label = paperLabelFor(ctx, paperId);

      if (paper.claims.length === 0) {
        ctx.onObservation({
          step: ctx.nextStep(),
          action: `Search claims in ${label}`,
          detail: `No claims have been extracted yet for ${label}.`,
          phase: "retrieve",
          status: "missing",
          source: "planner",
          tool: "search_claims",
          input: `${label}:${query}`,
          outputPreview: `No claims extracted for ${label}.`,
        });
        return `No claims have been extracted for ${label} yet. Try read_section or search_passages instead.`;
      }

      const ranked = rankClaimsForQuery(paper.claims, query, limit ?? 4);
      if (ranked.length === 0) {
        ctx.onObservation({
          step: ctx.nextStep(),
          action: `Search claims in ${label}`,
          detail: `No claims matched "${query}" for ${label}.`,
          phase: "retrieve",
          status: "missing",
          source: "planner",
          tool: "search_claims",
          input: `${label}:${query}`,
          outputPreview: `No claims matched "${query}" for ${label}.`,
        });
        return `No claims in ${label} matched "${query}".`;
      }

      const lines = [
        `Found ${ranked.length} claim${ranked.length === 1 ? "" : "s"} in ${label}:`,
        "",
      ];
      for (const claim of ranked) {
        const citation = citationForClaim(paper, claim);
        const idx = ctx.onCitation(citation);
        const roleTag = `${claim.rhetoricalRole}/${claim.facet}`;
        lines.push(
          `[S${idx}] (${roleTag}) ${truncate(claim.text, 300)}${claim.sectionPath ? ` — ${claim.sectionPath}` : ""}`,
        );
        if (claim.sourceExcerpt && claim.sourceExcerpt !== claim.text) {
          lines.push(`    excerpt: ${truncate(claim.sourceExcerpt, 240)}`);
        }
      }

      ctx.onObservation({
        step: ctx.nextStep(),
        action: `Search claims in ${label}`,
        detail: ranked.map((c) => `- ${c.text}`).join("\n"),
        phase: "retrieve",
        status: "completed",
        source: "planner",
        tool: "search_claims",
        input: `${label}:${query}`,
        outputPreview: `${ranked.length} grounded claim${ranked.length === 1 ? "" : "s"} matched for ${label}.`,
        citationsAdded: ranked.length,
      });

      return lines.join("\n");
    },
  });
}
