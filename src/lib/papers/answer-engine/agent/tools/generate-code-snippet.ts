import "server-only";

import { tool } from "ai";
import { z } from "zod";

import {
  buildCodeArtifact,
  generateCodeSnippetArtifact,
} from "../../agent";

import {
  missingPaperMessage,
  paperLabelFor,
  requirePaper,
  type ToolContext,
} from "./context";

export function generateCodeSnippetTool(ctx: ToolContext) {
  return tool({
    description:
      "Generate a CODE_SNIPPET artifact derived from paper evidence already gathered. Use only when the user asked for code or a derived implementation. Runs a secondary LLM call scoped to the paper; does not invent facts.",
    inputSchema: z.object({
      paperId: z.string(),
      language: z
        .string()
        .max(40)
        .optional()
        .describe("optional preferred language (e.g. 'python', 'typescript')"),
      note: z
        .string()
        .max(200)
        .optional()
        .describe("optional hint about what the snippet should implement"),
    }),
    execute: async ({ paperId, language, note }) => {
      const paper = requirePaper(ctx, paperId);
      if (!paper) return missingPaperMessage(ctx, paperId);
      const label = paperLabelFor(ctx, paperId);

      // Accumulated evidence is built from nothing retrievable from ctx directly;
      // the v1 generator wants citations/artifacts/observations. Since those are
      // owned by the loop closure, we pass a minimal "so far" shape and let the
      // generator re-prompt based on the user question + selected text + any
      // hint the planner supplied.
      const prompt = note ? `${ctx.question}\n\nPlanner note: ${note}` : ctx.question;

      const payload = await generateCodeSnippetArtifact({
        paper,
        question: prompt,
        selectedText: ctx.selectedText,
        citations: [],
        artifacts: [],
        observations: [],
        provider: ctx.provider,
        modelId: ctx.modelId,
        proxyConfig: ctx.proxyConfig,
        userId: ctx.userId,
      });

      if (!payload) {
        ctx.onObservation({
          step: ctx.nextStep(),
          action: `Generate code snippet for ${label}`,
          detail: "Code generator returned no code.",
          phase: "synthesize",
          status: "missing",
          source: "planner",
          tool: "generate_code_snippet",
          input: `${label}:${language ?? "auto"}`,
          outputPreview: `No code produced for ${label}.`,
        });
        return `Code generation did not produce a usable snippet for ${label}.`;
      }

      ctx.onArtifact(buildCodeArtifact(payload));
      ctx.onObservation({
        step: ctx.nextStep(),
        action: `Generate code snippet for ${label}`,
        detail: `${payload.filename}: ${payload.summary}`,
        phase: "synthesize",
        status: "completed",
        source: "planner",
        tool: "generate_code_snippet",
        input: `${label}:${language ?? "auto"}`,
        outputPreview: `${payload.filename} is ready.`,
        artifactsAdded: 1,
      });

      return `Produced code artifact "${payload.filename}" (${payload.language}): ${payload.summary}. The artifact card will render for the user; reference it in your answer plan.`;
    },
  });
}
