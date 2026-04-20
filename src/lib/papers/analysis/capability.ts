import { prisma } from "../../prisma";
import type { LLMProvider } from "../../llm/models";
import {
  PAPER_ANALYSIS_LLM_OPERATIONS,
  withPaperLlmContext,
} from "../../llm/paper-llm-context";

import { extractClaimsForPaper } from "./claim-extraction";

export type PaperAnalysisCapability = "claims";

export async function runPaperAnalysisCapability(params: {
  capability: PaperAnalysisCapability;
  paperId: string;
  text: string;
  provider: LLMProvider;
  modelId: string;
  proxyConfig?: Parameters<typeof extractClaimsForPaper>[0]["proxyConfig"];
  userId?: string;
  force?: boolean;
}) {
  switch (params.capability) {
    case "claims":
      return withPaperLlmContext(
        {
          operation: PAPER_ANALYSIS_LLM_OPERATIONS.EXTRACT_CLAIMS,
          paperId: params.paperId,
          userId: params.userId,
          runtime: "interactive",
          source: "papers.analysis.claims",
        },
        () =>
          extractClaimsForPaper({
            db: prisma,
            paperId: params.paperId,
            text: params.text,
            provider: params.provider,
            modelId: params.modelId,
            proxyConfig: params.proxyConfig,
            force: params.force,
          }),
      );
  }
}
