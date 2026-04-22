import "server-only";

import { tool } from "ai";
import { z } from "zod";

import type { ToolContext } from "./context";

export function finishTool(ctx: ToolContext) {
  return tool({
    description:
      "Stop the retrieval loop. Provide a short answerPlan (one or two sentences) describing what the streaming answer layer should tell the user. Do not write the full answer here — just the plan.",
    inputSchema: z.object({
      answerPlan: z
        .string()
        .min(1)
        .max(600)
        .describe(
          "Brief guidance for the streaming answer layer, citing [S1]/[S2] labels from prior tool results.",
        ),
    }),
    execute: async ({ answerPlan }) => {
      ctx.onFinish(answerPlan);
      ctx.onObservation({
        step: ctx.nextStep(),
        action: "Finish answer",
        detail: answerPlan,
        phase: "synthesize",
        status: "completed",
        source: "planner",
        tool: "finish",
        outputPreview: answerPlan,
      });
      return "Loop will terminate after this call.";
    },
  });
}
