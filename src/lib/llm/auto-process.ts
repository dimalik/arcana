import { prisma } from "@/lib/prisma";
import { generateLLMResponse, truncateText } from "./provider";
import { buildPrompt, cleanJsonResponse } from "./prompts";
import type { LLMProvider } from "./models";
import type { ProxyConfig } from "./proxy-settings";
import { getProxyConfig } from "./proxy-settings";
import { getTextForReferenceExtraction, getBodyTextForContextExtraction } from "@/lib/references/extract-section";
import { findBestMatch } from "@/lib/references/match";
import { matchCitationToReference } from "@/lib/references/match-citation";
import { resolveAndAssignTags, getExistingTagNames } from "@/lib/tags/auto-tag";

const STEP_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes per step
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 5_000; // 5s, 10s, 20s

/**
 * Check if an error is retryable (upstream 5xx, rate limit, network).
 */
function isRetryable(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  // AI SDK sets isRetryable on API call errors
  if (e.isRetryable === true) return true;
  // Retry on 5xx or 429
  const status = (e.statusCode ?? e.status) as number | undefined;
  if (status && (status >= 500 || status === 429)) return true;
  // Network errors
  const code = (e.code ?? "") as string;
  if (["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT"].includes(code)) return true;
  return false;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wrap a promise with a timeout. Rejects with a TimeoutError if exceeded.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout: ${label} exceeded ${ms}ms`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

/**
 * Retry a function with exponential backoff on retryable errors.
 * Respects an optional AbortSignal — won't retry if cancelled.
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (signal?.aborted) throw err;
      if (attempt < MAX_RETRIES && isRetryable(err)) {
        const backoff = RETRY_BASE_DELAY_MS * Math.pow(2, attempt);
        console.warn(`[auto-process] ${label} failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying in ${backoff}ms:`, (err as Error).message || err);
        await delay(backoff);
        if (signal?.aborted) throw err;
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

type ProcessingStep = "extracting_text" | "metadata" | "summarize" | "categorize" | "linking" | "references" | "contexts";

/**
 * Update the current processing step and timestamp in the DB.
 */
async function setStep(paperId: string, step: ProcessingStep | null) {
  await prisma.paper.update({
    where: { id: paperId },
    data: {
      processingStep: step,
      processingStartedAt: step ? new Date() : null,
    },
  });
}

/**
 * Pick the best available provider/model.
 * Priority: DB settings > proxy env > openai env > anthropic env
 * When provider is "proxy", loads and returns the full ProxyConfig.
 */
export async function getDefaultModel(): Promise<{ provider: LLMProvider; modelId: string; proxyConfig?: ProxyConfig }> {
  // Check DB settings first
  const [providerSetting, modelSetting] = await Promise.all([
    prisma.setting.findUnique({ where: { key: "default_provider" } }),
    prisma.setting.findUnique({ where: { key: "default_model" } }),
  ]);

  if (providerSetting?.value && modelSetting?.value) {
    const provider = providerSetting.value as LLMProvider;
    const modelId = modelSetting.value;
    if (provider === "proxy") {
      const proxyConfig = await getProxyConfig();
      return { provider, modelId, proxyConfig };
    }
    return { provider, modelId };
  }

  // Fall back to env-based detection
  if (process.env.LLM_PROXY_URL && process.env.LLM_PROXY_HEADER_VALUE) {
    const proxyConfig = await getProxyConfig();
    return { provider: "proxy", modelId: proxyConfig.modelId || "openai_direct_gpt52_flex", proxyConfig };
  }
  if (process.env.OPENAI_API_KEY) {
    return { provider: "openai", modelId: "gpt-4o-mini" };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { provider: "anthropic", modelId: "claude-haiku-4-5-20251001" };
  }
  throw new Error("No LLM provider configured");
}

/**
 * Resolve provider/model from request body or fall back to defaults.
 * Always loads ProxyConfig when provider is "proxy".
 */
export async function resolveModelConfig(body: { provider?: string; modelId?: string }): Promise<{
  provider: LLMProvider;
  modelId: string;
  proxyConfig?: ProxyConfig;
}> {
  if (body.provider && body.modelId) {
    const provider = body.provider as LLMProvider;
    if (provider === "proxy") {
      const proxyConfig = await getProxyConfig();
      return { provider, modelId: body.modelId, proxyConfig };
    }
    return { provider, modelId: body.modelId };
  }
  return getDefaultModel();
}

/**
 * Extract text from a PDF file and update the paper record.
 * Consolidates duplicated logic from import routes.
 */
export async function runTextExtraction(paperId: string): Promise<void> {
  const paper = await prisma.paper.findUnique({
    where: { id: paperId },
    select: { filePath: true, fullText: true },
  });

  if (!paper) throw new Error(`Paper not found: ${paperId}`);
  if (paper.fullText) return; // Already has text
  if (!paper.filePath) throw new Error(`No file path for paper: ${paperId}`);

  await setStep(paperId, "extracting_text");
  await prisma.paper.update({
    where: { id: paperId },
    data: { processingStatus: "EXTRACTING_TEXT" },
  });

  const { extractTextFromPdf } = await import("@/lib/pdf/parser");
  const text = await extractTextFromPdf(paper.filePath);

  await prisma.paper.update({
    where: { id: paperId },
    data: {
      fullText: text,
      processingStatus: "TEXT_EXTRACTED",
    },
  });
}

/**
 * Run the full auto-processing pipeline for a paper:
 * 1. Extract metadata (skip for ArXiv papers that already have metadata)
 * 2. Summarize
 * 3. Categorize + auto-tag
 * 4. Link related papers
 * 5. Extract references
 * 6. Extract citation contexts
 *
 * Each step updates processingStep + processingStartedAt for progress tracking.
 * Each LLM call has a 3-minute timeout — on timeout, logs error and continues.
 */
export async function runAutoProcessPipeline(opts: {
  paperId: string;
  skipExtract?: boolean;
  signal?: AbortSignal;
}) {
  const { paperId, skipExtract, signal } = opts;

  function checkCancelled() {
    if (signal?.aborted) {
      throw new Error(`Processing cancelled for ${paperId}`);
    }
  }

  let defaultModel: { provider: LLMProvider; modelId: string; proxyConfig?: ProxyConfig };
  try {
    defaultModel = await getDefaultModel();
  } catch (e) {
    console.error("[auto-process] No LLM provider available, skipping:", e);
    await prisma.paper.update({
      where: { id: paperId },
      data: { processingStatus: "FAILED", processingStep: null, processingStartedAt: null },
    });
    throw e;
  }

  const { provider, modelId, proxyConfig } = defaultModel;

  const paper = await prisma.paper.findUnique({ where: { id: paperId } });
  if (!paper) {
    throw new Error(`[auto-process] Paper not found: ${paperId}`);
  }

  const text = paper.fullText || paper.abstract || "";
  if (!text) {
    console.error("[auto-process] No text available for paper:", paperId);
    await prisma.paper.update({
      where: { id: paperId },
      data: { processingStatus: "FAILED", processingStep: null, processingStartedAt: null },
    });
    throw new Error(`No text available for paper: ${paperId}`);
  }

  const truncated = truncateText(text, modelId, proxyConfig);

  // Step 1: Extract metadata
  if (!skipExtract) {
    try {
      checkCancelled();
      await setStep(paperId, "metadata");
      console.log("[auto-process] Extracting metadata for", paperId);
      const { system, prompt } = buildPrompt("extract", truncated);
      const result = await withRetry(
        () => withTimeout(generateLLMResponse({ provider, modelId, system, prompt, maxTokens: 2000, proxyConfig }), STEP_TIMEOUT_MS, "metadata extraction"),
        "metadata extraction", signal,
      );

      await prisma.promptResult.create({
        data: {
          paperId,
          promptType: "extract",
          prompt: "Auto-extract metadata",
          result,
          provider,
          model: modelId,
        },
      });

      // Try to update paper fields from extracted metadata
      try {
        const cleaned = cleanJsonResponse(result);
        const parsed = JSON.parse(cleaned);
        const updateData: Record<string, unknown> = {};
        if (parsed.title) updateData.title = parsed.title;
        if (parsed.authors) updateData.authors = JSON.stringify(parsed.authors);
        if (parsed.year) updateData.year = parsed.year;
        if (parsed.venue) updateData.venue = parsed.venue;
        if (parsed.abstract) updateData.abstract = parsed.abstract;
        if (parsed.keyFindings)
          updateData.keyFindings = JSON.stringify(parsed.keyFindings);

        if (Object.keys(updateData).length > 0) {
          await prisma.paper.update({
            where: { id: paperId },
            data: updateData,
          });
        }
      } catch {
        // JSON parse failed — raw result still saved
      }
    } catch (e) {
      console.error("[auto-process] Extract failed:", e);
    }
  }

  // Step 2: Summarize
  try {
    checkCancelled();
    await setStep(paperId, "summarize");
    console.log("[auto-process] Summarizing", paperId);
    const { system, prompt } = buildPrompt("summarize", truncated);
    const result = await withRetry(
      () => withTimeout(generateLLMResponse({ provider, modelId, system, prompt, maxTokens: 2000, proxyConfig }), STEP_TIMEOUT_MS, "summarize"),
      "summarize", signal,
    );

    await prisma.promptResult.create({
      data: {
        paperId,
        promptType: "summarize",
        prompt: "Auto-summarize paper",
        result,
        provider,
        model: modelId,
      },
    });

    await prisma.paper.update({
      where: { id: paperId },
      data: { summary: result },
    });
  } catch (e) {
    console.error("[auto-process] Summarize failed:", e);
  }

  // Step 3: Categorize + auto-tag (with duplicate prevention)
  try {
    checkCancelled();
    await setStep(paperId, "categorize");
    console.log("[auto-process] Categorizing", paperId);
    const existingTags = await getExistingTagNames();
    const { system, prompt } = buildPrompt("categorize", truncated, undefined, { existingTags });
    const result = await withRetry(
      () => withTimeout(generateLLMResponse({ provider, modelId, system, prompt, maxTokens: 1000, proxyConfig }), STEP_TIMEOUT_MS, "categorize"),
      "categorize", signal,
    );

    await prisma.promptResult.create({
      data: {
        paperId,
        promptType: "categorize",
        prompt: "Auto-categorize paper",
        result,
        provider,
        model: modelId,
      },
    });

    // Auto-tag with fuzzy matching against existing tags
    try {
      const cleaned = cleanJsonResponse(result);
      const parsed = JSON.parse(cleaned);
      const tagNames = (parsed.tags || []) as string[];
      await resolveAndAssignTags(paperId, tagNames);
    } catch {
      // JSON parse failed
    }
  } catch (e) {
    console.error("[auto-process] Categorize failed:", e);
  }

  // Step 4: Link related papers
  try {
    const otherPapers = await prisma.paper.findMany({
      where: { id: { not: paperId } },
      select: {
        id: true,
        title: true,
        abstract: true,
        summary: true,
        categories: true,
      },
    });

    if (otherPapers.length > 0) {
      checkCancelled();
      await setStep(paperId, "linking");
      console.log("[auto-process] Linking related papers for", paperId);

      // Re-fetch paper to get summary/categories from prior steps
      const updatedPaper = await prisma.paper.findUnique({
        where: { id: paperId },
        select: {
          title: true,
          abstract: true,
          summary: true,
          categories: true,
        },
      });

      const newPaperInfo = [
        `Title: ${updatedPaper?.title || paper.title}`,
        updatedPaper?.abstract ? `Abstract: ${updatedPaper.abstract}` : "",
        updatedPaper?.summary
          ? `Summary: ${updatedPaper.summary.slice(0, 500)}`
          : "",
        updatedPaper?.categories
          ? `Categories: ${updatedPaper.categories}`
          : "",
      ]
        .filter(Boolean)
        .join("\n");

      const existingList = otherPapers
        .map((p) => {
          const parts = [`id: ${p.id}`, `title: ${p.title}`];
          if (p.abstract) parts.push(`abstract: ${p.abstract.slice(0, 200)}`);
          if (p.summary) parts.push(`summary: ${p.summary.slice(0, 200)}`);
          if (p.categories) parts.push(`categories: ${p.categories}`);
          return parts.join(" | ");
        })
        .join("\n");

      const linkPrompt = `NEW PAPER:\n${newPaperInfo}\n\n---\n\nEXISTING PAPERS IN LIBRARY:\n${existingList}`;

      const { system } = buildPrompt("linkPapers", "");
      const result = await withRetry(
        () => withTimeout(generateLLMResponse({ provider, modelId, system, prompt: linkPrompt, maxTokens: 2000, proxyConfig }), STEP_TIMEOUT_MS, "link papers"),
        "link papers", signal,
      );

      try {
        const cleaned = cleanJsonResponse(result);
        const relations = JSON.parse(cleaned) as Array<{
          targetPaperId: string;
          relationType: string;
          description?: string;
          confidence: number;
        }>;

        const validIds = new Set(otherPapers.map((p) => p.id));
        let created = 0;

        for (const rel of relations.slice(0, 20)) {
          if (!validIds.has(rel.targetPaperId)) continue;

          await prisma.paperRelation
            .create({
              data: {
                sourcePaperId: paperId,
                targetPaperId: rel.targetPaperId,
                relationType: rel.relationType,
                description: rel.description || null,
                confidence: Math.min(1, Math.max(0, rel.confidence || 0)),
                isAutoGenerated: true,
              },
            })
            .catch(() => {}); // Skip duplicates

          created++;
        }

        console.log(
          `[auto-process] Created ${created} paper relations for`,
          paperId
        );
      } catch {
        // JSON parse failed
      }
    }
  } catch (e) {
    console.error("[auto-process] Link related papers failed:", e);
  }

  // Step 5: Extract references
  if (paper.fullText) {
    try {
      checkCancelled();
      await setStep(paperId, "references");
      console.log("[auto-process] Extracting references for", paperId);
      const refText = getTextForReferenceExtraction(paper.fullText);
      const { system } = buildPrompt("extractReferences", "");
      const refPrompt = `Here is the reference/bibliography section of the paper:\n\n${refText}`;
      const refResult = await withRetry(
        () => withTimeout(generateLLMResponse({ provider, modelId, system, prompt: refPrompt, maxTokens: 8000, proxyConfig }), STEP_TIMEOUT_MS, "extract references"),
        "extract references", signal,
      );

      await prisma.promptResult.create({
        data: {
          paperId,
          promptType: "extractReferences",
          prompt: "Auto-extract references",
          result: refResult,
          provider,
          model: modelId,
        },
      });

      try {
        const cleaned = cleanJsonResponse(refResult);
        const refs = JSON.parse(cleaned) as Array<{
          index?: number;
          title: string;
          authors?: string[] | null;
          year?: number | null;
          venue?: string | null;
          doi?: string | null;
          rawCitation: string;
        }>;

        if (Array.isArray(refs) && refs.length > 0) {
          // Clear existing references for idempotency
          await prisma.reference.deleteMany({ where: { paperId } });

          // Fetch library papers for matching
          const libraryPapers = await prisma.paper.findMany({
            where: { id: { not: paperId } },
            select: { id: true, title: true },
          });

          const cappedRefs = refs.slice(0, 200);
          let matchCount = 0;

          for (const ref of cappedRefs) {
            if (!ref.title) continue;

            const match = findBestMatch(ref.title, libraryPapers);

            await prisma.reference.create({
              data: {
                paperId,
                title: ref.title,
                authors: ref.authors ? JSON.stringify(ref.authors) : null,
                year: ref.year ?? null,
                venue: ref.venue ?? null,
                doi: ref.doi ?? null,
                rawCitation: ref.rawCitation || ref.title,
                referenceIndex: ref.index ?? null,
                matchedPaperId: match?.paperId ?? null,
                matchConfidence: match?.confidence ?? null,
              },
            });

            // Create "cites" relation for matches
            if (match) {
              matchCount++;
              await prisma.paperRelation
                .create({
                  data: {
                    sourcePaperId: paperId,
                    targetPaperId: match.paperId,
                    relationType: "cites",
                    description: `Cited in references as: "${ref.title}"`,
                    confidence: match.confidence,
                    isAutoGenerated: true,
                  },
                })
                .catch(() => {}); // Skip duplicates
            }
          }

          console.log(
            `[auto-process] Extracted ${cappedRefs.length} references, ${matchCount} matched to library for`,
            paperId
          );
        }
      } catch {
        // JSON parse failed — raw result still saved
      }
    } catch (e) {
      console.error("[auto-process] Extract references failed:", e);
    }
  }

  // Step 6: Extract citation contexts from body text
  if (paper.fullText) {
    try {
      // Check that references exist for this paper
      const existingRefs = await prisma.reference.findMany({
        where: { paperId },
        select: { id: true, title: true, authors: true, year: true, referenceIndex: true },
      });

      if (existingRefs.length > 0) {
        const bodyText = getBodyTextForContextExtraction(paper.fullText);
        if (bodyText) {
          checkCancelled();
          await setStep(paperId, "contexts");
          console.log("[auto-process] Extracting citation contexts for", paperId);
          const { system } = buildPrompt("extractCitationContexts", "");
          const ctxPrompt = `Here is the body text of the paper:\n\n${bodyText}`;
          const ctxResult = await withRetry(
            () => withTimeout(generateLLMResponse({ provider, modelId, system, prompt: ctxPrompt, maxTokens: 4000, proxyConfig }), STEP_TIMEOUT_MS, "extract citation contexts"),
            "extract citation contexts", signal,
          );

          try {
            const cleaned = cleanJsonResponse(ctxResult);
            const contexts = JSON.parse(cleaned) as Array<{
              citation: string;
              context: string;
            }>;

            if (Array.isArray(contexts) && contexts.length > 0) {
              // Group contexts by matched reference ID
              const contextsByRef = new Map<string, string[]>();

              for (const ctx of contexts) {
                if (!ctx.citation || !ctx.context) continue;
                const refId = matchCitationToReference(ctx.citation, existingRefs);
                if (!refId) continue;

                const existing = contextsByRef.get(refId) || [];
                if (!existing.includes(ctx.context)) {
                  existing.push(ctx.context);
                }
                contextsByRef.set(refId, existing);
              }

              // Update references with merged contexts
              let updated = 0;
              const entries = Array.from(contextsByRef.entries());
              for (const [refId, ctxList] of entries) {
                await prisma.reference.update({
                  where: { id: refId },
                  data: { citationContext: ctxList.join("; ") },
                });
                updated++;
              }

              console.log(
                `[auto-process] Matched citation contexts to ${updated}/${existingRefs.length} references for`,
                paperId
              );
            }
          } catch {
            // JSON parse failed
          }
        }
      }
    } catch (e) {
      console.error("[auto-process] Extract citation contexts failed:", e);
    }
  }

  // Mark completed — clear step tracking
  await prisma.paper.update({
    where: { id: paperId },
    data: {
      processingStatus: "COMPLETED",
      processingStep: null,
      processingStartedAt: null,
    },
  });

  console.log("[auto-process] Pipeline completed for", paperId);
}
