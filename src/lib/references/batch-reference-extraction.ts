import { getProxyConfig } from "../llm/proxy-settings";
import { withLlmContext } from "../llm/provider";
import { prisma } from "../prisma";
import { getLatestActiveRunsForPapers } from "../processing/runtime-ledger";
import { extractReferenceCandidates } from "./extraction";
import { persistExtractedReferences } from "./persist";

export async function runHybridReferenceExtractionForPapers(
  paperIds: string[],
  modelId: string,
): Promise<{
  persistedPapers: number;
  grobidPapers: number;
  llmFallbackPapers: number;
  failedPapers: number;
}> {
  const proxyConfig = await getBatchReferenceProxyConfig();
  const papers = await prisma.paper.findMany({
    where: { id: { in: paperIds } },
    select: {
      id: true,
      userId: true,
      entityId: true,
      filePath: true,
      fullText: true,
    },
  });
  const activeRunIds = await getLatestActiveRunsForPapers(
    papers.map((paper) => paper.id),
  );

  let persistedPapers = 0;
  let grobidPapers = 0;
  let llmFallbackPapers = 0;
  let failedPapers = 0;

  for (const paper of papers) {
    if (!paper.fullText) continue;

    try {
      const extracted = await withLlmContext(
        {
          operation: "processing_extractReferences",
          userId: paper.userId ?? undefined,
          metadata: {
            runtime: "processing",
            source: "batch",
            paperId: paper.id,
            step: "extractReferences",
            ...(activeRunIds.get(paper.id)
              ? { processingRunId: activeRunIds.get(paper.id) }
              : {}),
          },
        },
        () =>
          extractReferenceCandidates({
            paperId: paper.id,
            filePath: paper.filePath,
            fullText: paper.fullText ?? "",
            provider: "proxy",
            modelId,
            proxyConfig,
          }),
      );
      const attemptSummary = extracted.attempts
        .map((attempt) => {
          const parts = [
            attempt.method,
            attempt.status,
            `${attempt.candidateCount} refs`,
          ];
          if (attempt.preflightResult) parts.push(`preflight=${attempt.preflightResult}`);
          if (attempt.pageCount) parts.push(`pages=${attempt.pageCount}`);
          if (attempt.errorSummary) parts.push(`error=${attempt.errorSummary}`);
          return parts.join(" ");
        })
        .join(" | ");

      if (extracted.llmRawResponse) {
        await prisma.promptResult.create({
          data: {
            paperId: paper.id,
            promptType: "extractReferences",
            prompt: "Auto-extract references (batch hybrid)",
            result: extracted.llmRawResponse,
            provider: "proxy",
            model: modelId,
          },
        });
      }

      if (extracted.candidates.length === 0) {
        console.warn(
          `[batch] No references extracted for ${paper.id}${
            extracted.fallbackReason ? ` after fallback: ${extracted.fallbackReason}` : ""
          }${attemptSummary ? ` [${attemptSummary}]` : ""}`,
        );
        failedPapers += 1;
        continue;
      }

      await persistExtractedReferences({
        paperId: paper.id,
        paperUserId: paper.userId,
        sourceEntityId: paper.entityId,
        references: extracted.candidates,
        provenance:
          extracted.method === "grobid_tei" ? "grobid_tei" : "llm_extraction",
        extractorVersion: extracted.extractorVersion,
      });

      persistedPapers += 1;
      if (extracted.method === "grobid_tei") {
        grobidPapers += 1;
      } else {
        llmFallbackPapers += 1;
      }
      console.log(
        `[batch] References for ${paper.id}: ${extracted.method} (${extracted.candidates.length} candidates)${
          extracted.fallbackReason ? ` after fallback: ${extracted.fallbackReason}` : ""
        }${attemptSummary ? ` [${attemptSummary}]` : ""}`,
      );
    } catch (error) {
      failedPapers += 1;
      console.error(
        `[batch] Hybrid reference extraction failed for ${paper.id}:`,
        error,
      );
    }
  }

  return {
    persistedPapers,
    grobidPapers,
    llmFallbackPapers,
    failedPapers,
  };
}

async function getBatchReferenceProxyConfig() {
  const proxyConfig = await getProxyConfig();
  if (!proxyConfig.enabled || !proxyConfig.anthropicBaseUrl) {
    throw new Error(
      "Anthropic proxy not configured — batch reference extraction requires the Anthropic proxy",
    );
  }

  return proxyConfig;
}
