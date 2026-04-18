import { prisma } from "@/lib/prisma";
import {
  generateLLMResponse,
  generateStructuredObject,
  truncateText,
  MAX_PAPER_CHARS,
  withLlmContext,
} from "./provider";
import { buildPrompt, buildDistillPrompt } from "./prompts";
import type { LLMProvider } from "./models";
import type { ProxyConfig } from "./proxy-settings";
import { getProxyConfig } from "./proxy-settings";
import { getBodyTextForContextExtraction } from "@/lib/references/extract-section";
import { GrobidCitationMentionExtractor } from "@/lib/references/grobid/citation-mentions";
import { extractReferenceCandidates } from "@/lib/references/extraction";
import { persistExtractedReferences } from "@/lib/references/persist";
import { resolveAndAssignTags, getExistingTagNames, getScoredTagHints } from "@/lib/tags/auto-tag";
import { refreshTagScores } from "@/lib/tags/cleanup";
import { getUserContext, buildUserContextPreamble } from "@/lib/llm/user-context";
import { collectIdentifiers, resolveOrCreateEntity } from "@/lib/canonical/entity-service";
import {
  applyLegacyCitationContexts,
  createCitationMentions,
  type CitationMentionInput,
} from "@/lib/citations/citation-mention-service";
import { createRelationAssertion } from "@/lib/assertions/relation-assertion-service";
import { projectLegacyRelation } from "@/lib/assertions/legacy-projection";
import type { ZodTypeAny } from "zod";
import {
  clearProcessingStep,
  createProcessingRun,
  finishProcessingRun,
  setProcessingProjection,
  startProcessingStep,
} from "@/lib/processing/runtime-ledger";
import {
  categorizeRuntimeOutputSchema,
  detectContradictionsRuntimeOutputSchema,
  distillRuntimeOutputSchema,
  extractCitationContextsRuntimeOutputSchema,
  extractRuntimeOutputSchema,
  linkPapersRuntimeOutputSchema,
} from "./runtime-output-schemas";


type ProcessingStep = "extracting_text" | "metadata" | "summarize" | "categorize" | "linking" | "contradictions" | "references" | "contexts" | "distill";
type ProcessingLlmStep =
  | "extract"
  | "summarize"
  | "categorize"
  | "linkPapers"
  | "detectContradictions"
  | "extractReferences"
  | "extractCitationContexts"
  | "distill";

/**
 * Update the current processing step and timestamp in the DB.
 */
async function setStep(
  paperId: string,
  step: ProcessingStep | null,
  options?: {
    processingStatus: string;
    processingRunId?: string;
  },
) {
  if (options?.processingRunId && step) {
    await startProcessingStep({
      paperId,
      processingRunId: options.processingRunId,
      step,
      processingStatus: options.processingStatus,
      metadata: {
        source: "auto_process",
      },
    });
    return;
  }

  await setProcessingProjection(paperId, {
    processingStatus: options?.processingStatus ?? "PENDING",
    processingStep: step,
    processingStartedAt: step ? new Date() : null,
  });
}

async function runProcessingLlmCall(
  context: {
    paperId: string;
    userId?: string | null;
    step: ProcessingLlmStep;
    processingRunId?: string;
    metadata?: Record<string, unknown>;
  },
  params: Parameters<typeof generateLLMResponse>[0],
): Promise<string> {
  return withLlmContext(
    {
      operation: `processing_${context.step}`,
      userId: context.userId ?? undefined,
      metadata: {
        runtime: "processing",
        source: "auto_process",
        paperId: context.paperId,
        step: context.step,
        ...(context.processingRunId
          ? { processingRunId: context.processingRunId }
          : {}),
        ...context.metadata,
      },
    },
    () => generateLLMResponse(params),
  );
}

async function runProcessingStructuredCall<TSchema extends ZodTypeAny>(
  context: {
    paperId: string;
    userId?: string | null;
    step:
      | "extract"
      | "categorize"
      | "linkPapers"
      | "detectContradictions"
      | "extractCitationContexts"
      | "distill";
    processingRunId?: string;
    metadata?: Record<string, unknown>;
  },
  params: Omit<
    Parameters<typeof generateStructuredObject<TSchema>>[0],
    "schemaName" | "schema"
  > & {
    schemaName: Parameters<typeof generateStructuredObject<TSchema>>[0]["schemaName"];
    schema: TSchema;
  },
): Promise<{ object: TSchema["_output"]; resultText: string }> {
  return withLlmContext(
    {
      operation: `processing_${context.step}`,
      userId: context.userId ?? undefined,
      metadata: {
        runtime: "processing",
        source: "auto_process",
        paperId: context.paperId,
        step: context.step,
        ...(context.processingRunId
          ? { processingRunId: context.processingRunId }
          : {}),
        ...context.metadata,
      },
    },
    () => generateStructuredObject(params),
  );
}

async function tryAssignEntity(paper: {
  id: string;
  title: string;
  authors: string | null;
  year: number | null;
  venue: string | null;
  abstract: string | null;
  doi: string | null;
  arxivId: string | null;
  entityId: string | null;
}) {
  if (paper.entityId) return;

  const identifiers = collectIdentifiers(paper, "llm_extraction");
  if (identifiers.length === 0) return;

  const result = await resolveOrCreateEntity({
    title: paper.title,
    authors: paper.authors,
    year: paper.year,
    venue: paper.venue,
    abstract: paper.abstract,
    identifiers,
    source: "llm_extraction",
  });

  try {
    await prisma.paper.update({
      where: { id: paper.id },
      data: { entityId: result.entityId },
    });
  } catch (error) {
    const isPrismaUniqueError =
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "P2002";

    if (!isPrismaUniqueError) {
      throw error;
    }

    console.warn(
      `[auto-process] Skipping entity assignment for duplicate paper ${paper.id}; entity ${result.entityId} is already linked elsewhere`
    );
  }
}

/**
 * Pick the best available provider/model.
 * Priority: DB settings > proxy env > openai env > anthropic env
 * When provider is "proxy", loads and returns the full ProxyConfig.
 */
/**
 * Model tiers for different tasks. Opus for critical reasoning, Sonnet for everything else.
 */
export type ModelTier = "reasoning" | "standard";

const TIER_DEFAULTS: Record<ModelTier, string> = {
  reasoning: "claude-opus-4-6",
  standard: "claude-sonnet-4-6",
};

const TIER_DB_KEYS: Record<ModelTier, string> = {
  reasoning: "tier_reasoning_model",
  standard: "tier_standard_model",
};

/**
 * Get a model for a specific capability tier.
 * - "reasoning": Opus — for the main research agent, adversarial reviewer, synthesizer, architect
 * - "standard": Sonnet — for scouts, paper processing, query expansion, analyst
 *
 * Reads user-configured tier models from DB settings, falls back to defaults.
 * Only applies tier models when using proxy provider (direct API keys may not have Opus access).
 */
export async function getModelForTier(tier: ModelTier): Promise<{ provider: LLMProvider; modelId: string; proxyConfig?: ProxyConfig }> {
  const defaults = await getDefaultModel();

  // Only upgrade if using proxy (direct API keys may not have Opus access)
  if (defaults.provider !== "proxy") return defaults;

  // Check DB for user-configured tier model
  const setting = await prisma.setting.findUnique({ where: { key: TIER_DB_KEYS[tier] } }).catch(() => null);
  const targetModel = setting?.value || TIER_DEFAULTS[tier];

  return { ...defaults, modelId: targetModel };
}

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

  // Fall back: check proxy, then DB/env keys
  const proxyConfig = await getProxyConfig();
  if (proxyConfig.enabled && proxyConfig.modelId) {
    const firstModel = proxyConfig.modelId.split(",").map(s => s.trim()).filter(Boolean)[0] || "gpt-4o";
    return { provider: "proxy", modelId: firstModel, proxyConfig };
  }

  const { getApiKey } = await import("./api-keys");
  const openaiKey = await getApiKey("openai");
  if (openaiKey) {
    return { provider: "openai", modelId: "gpt-4o-mini" };
  }
  const anthropicKey = await getApiKey("anthropic");
  if (anthropicKey) {
    return { provider: "anthropic", modelId: "claude-haiku-4-5-20251001" };
  }
  throw new Error("No LLM provider configured. Add an API key in Settings → LLM.");
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
export async function runTextExtraction(
  paperId: string,
  options?: { processingRunId?: string },
): Promise<void> {
  const paper = await prisma.paper.findUnique({
    where: { id: paperId },
    select: { filePath: true, fullText: true },
  });

  if (!paper) throw new Error(`Paper not found: ${paperId}`);
  if (paper.fullText) return; // Already has text
  if (!paper.filePath) throw new Error(`No file path for paper: ${paperId}`);

  if (!options?.processingRunId) {
    await setStep(paperId, "extracting_text", {
      processingStatus: "EXTRACTING_TEXT",
    });
  }

  const { extractTextFromPdf } = await import("@/lib/pdf/parser");
  const text = await extractTextFromPdf(paper.filePath);

  await prisma.paper.update({
    where: { id: paperId },
    data: {
      fullText: text,
    },
  });

  if (options?.processingRunId) {
    await clearProcessingStep({
      paperId,
      processingRunId: options.processingRunId,
      processingStatus: "TEXT_EXTRACTED",
    });
    return;
  }

  await setProcessingProjection(paperId, {
    processingStatus: "TEXT_EXTRACTED",
    processingStep: null,
    processingStartedAt: null,
  });
}

/**
 * Summarize a paper using chunked map-reduce when the text exceeds
 * MAX_PAPER_CHARS. This sends the ENTIRE paper to the model in
 * overlapping segments, then synthesizes the results.
 *
 * Map: extract detailed notes from each chunk (methods, results, equations, tables).
 * Reduce: synthesize all notes into the final structured review.
 */
async function chunkedSummarize(params: {
  paperId: string;
  userId?: string | null;
  fullText: string;
  provider: LLMProvider;
  modelId: string;
  proxyConfig?: ProxyConfig;
  signal?: AbortSignal;
  userContextPreamble?: string;
  processingRunId?: string;
}): Promise<string> {
  const {
    paperId,
    userId,
    fullText,
    provider,
    modelId,
    proxyConfig,
    signal,
    userContextPreamble,
    processingRunId,
  } = params;
  const chunkSize = MAX_PAPER_CHARS;
  const overlap = 2000;

  // Small enough for a single call — use the normal path
  if (fullText.length <= chunkSize) {
    const { system, prompt } = buildPrompt("summarize", fullText, undefined, { userContextPreamble });
    return runProcessingLlmCall(
      {
        paperId,
        userId,
        step: "summarize",
        processingRunId,
        metadata: { substep: "single_pass" },
      },
      { provider, modelId, system, prompt, proxyConfig },
    );
  }

  // Split into overlapping chunks
  const chunks: string[] = [];
  for (let start = 0; start < fullText.length; start += chunkSize - overlap) {
    chunks.push(fullText.slice(start, Math.min(start + chunkSize, fullText.length)));
    if (start + chunkSize >= fullText.length) break;
  }

  console.log(`[auto-process] Chunked summarize: ${fullText.length} chars → ${chunks.length} chunks of ~${chunkSize} chars`);

  // Map phase: extract structured notes from each chunk
  const MAP_SYSTEM = `You are a research paper analyst. Extract ALL important information from this section of a research paper. Include:
- Key claims, findings, and contributions
- Methodology details (models, algorithms, datasets, hyperparameters)
- Mathematical formulations (reproduce key equations in LaTeX with $..$ or $$..$$)
- Experimental results with specific numbers (accuracy, F1, speedup, p-values, etc.)
- Tables of results (reproduce in markdown)
- Ablation study findings
- Limitations and future work mentioned

Be thorough and specific — include every number, model name, and dataset name you find. Do not summarize or editorialize, just extract the information.`;

  const chunkNotes: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    if (signal?.aborted) throw new Error("Cancelled");

    console.log(`[auto-process] Processing chunk ${i + 1}/${chunks.length} (${chunks[i].length} chars)`);
    const notes = await runProcessingLlmCall(
      {
        paperId,
        userId,
        step: "summarize",
        processingRunId,
        metadata: {
          substep: "map",
          chunkIndex: i + 1,
          chunkCount: chunks.length,
        },
      },
      {
        provider,
        modelId,
        system: MAP_SYSTEM,
        prompt: `This is section ${i + 1} of ${chunks.length} from the paper:\n\n${chunks[i]}`,
        maxTokens: 1500,
        proxyConfig,
      },
    );
    chunkNotes.push(`## Section ${i + 1} of ${chunks.length}\n\n${notes}`);
  }

  // Reduce phase: if combined notes are too large, condense in batches first
  let combined = chunkNotes.join("\n\n---\n\n");

  if (combined.length > chunkSize) {
    console.log(`[auto-process] Notes too large (${combined.length} chars), condensing in batches first`);
    const condensed: string[] = [];
    for (let i = 0; i < chunkNotes.length; i += 3) {
      if (signal?.aborted) throw new Error("Cancelled");
      const batch = chunkNotes.slice(i, i + 3).join("\n\n---\n\n");
      const summary = await runProcessingLlmCall(
        {
          paperId,
          userId,
          step: "summarize",
          processingRunId,
          metadata: {
            substep: "condense",
            chunkBatchStart: i + 1,
            chunkBatchEnd: Math.min(i + 3, chunkNotes.length),
          },
        },
        {
          provider,
          modelId,
          system: "You are a research paper analyst. Condense these extracted notes into a shorter but complete summary. Keep ALL specific numbers, equations, model names, dataset names, and key findings. Remove redundancy but preserve detail.",
          prompt: batch,
          maxTokens: 1500,
          proxyConfig,
        },
      );
      condensed.push(summary);
    }
    combined = condensed.join("\n\n---\n\n");
    console.log(`[auto-process] Condensed to ${combined.length} chars`);
  }

  // Final synthesis
  console.log(`[auto-process] Synthesizing final summary from ${combined.length} chars of notes`);
  const { system } = buildPrompt("summarize", "", undefined, { userContextPreamble });

  return runProcessingLlmCall(
    {
      paperId,
      userId,
      step: "summarize",
      processingRunId,
      metadata: { substep: "synthesize" },
    },
    {
      provider,
      modelId,
      system,
      prompt: `Below are detailed notes extracted from all sections of a research paper. Using these notes, produce your full structured review.\n\n${combined}`,
      proxyConfig,
    },
  );
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
 * Each LLM call has a timeout — on timeout, logs error and continues.
 */
export async function runAutoProcessPipeline(opts: {
  paperId: string;
  skipExtract?: boolean;
  signal?: AbortSignal;
  /** When true, only run essential steps (metadata + summarize + categorize) and skip
   *  cross-paper linking, references, contradictions, contexts, and distill.
   *  The deferred steps run later via runDeferredSteps(). */
  essentialOnly?: boolean;
  /** When true, skip essential steps and only run deferred steps (linking, contradictions,
   *  references, contexts, distill). Used when picking up NEEDS_DEFERRED papers. */
  deferredOnly?: boolean;
  processingRunId?: string;
  trigger?: string;
}) {
  const {
    paperId,
    skipExtract,
    signal,
    essentialOnly,
    deferredOnly,
    trigger,
  } = opts;
  let { processingRunId } = opts;

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
    if (processingRunId) {
      await finishProcessingRun({
        paperId,
        processingRunId,
        processingStatus: "FAILED",
        runStatus: "FAILED",
        activeStepStatus: "FAILED",
        error: e instanceof Error ? e.message : String(e),
      }).catch(() => {});
    } else {
      await setProcessingProjection(paperId, {
        processingStatus: "FAILED",
        processingStep: null,
        processingStartedAt: null,
      });
    }
    throw e;
  }

  const { provider, modelId, proxyConfig } = defaultModel;
  const paperSelect = {
    id: true,
    userId: true,
    title: true,
    abstract: true,
    authors: true,
    year: true,
    venue: true,
    doi: true,
    sourceType: true,
    arxivId: true,
    filePath: true,
    fullText: true,
    entityId: true,
    processingStatus: true,
  } as const;

  const initialPaper = await prisma.paper.findUnique({
    where: { id: paperId },
    select: paperSelect,
  });
  if (!initialPaper) {
    throw new Error(`[auto-process] Paper not found: ${paperId}`);
  }
  let paper = initialPaper;

  const ownsRunLifecycle = !processingRunId;
  if (ownsRunLifecycle) {
    const createdRun = await createProcessingRun({
      paperId,
      trigger: trigger ?? (deferredOnly ? "deferred" : "direct"),
      processingStatus: paper.processingStatus,
      metadata: {
        source: deferredOnly ? "deferred" : "auto_process",
      },
    });
    processingRunId = createdRun.id;
  }

  const baseProcessingStatus = paper.processingStatus;

  const text = paper.fullText || paper.abstract || "";
  if (!text) {
    console.error("[auto-process] No text available for paper:", paperId);
    if (processingRunId) {
      await finishProcessingRun({
        paperId,
        processingRunId,
        processingStatus: "FAILED",
        runStatus: "FAILED",
        activeStepStatus: "FAILED",
        error: "No text available for paper",
      }).catch(() => {});
    } else {
      await setProcessingProjection(paperId, {
        processingStatus: "FAILED",
        processingStep: null,
        processingStartedAt: null,
      });
    }
    throw new Error(`No text available for paper: ${paperId}`);
  }

  const truncated = truncateText(text, modelId, proxyConfig);
  console.log(`[auto-process] Paper ${paperId}: text=${text.length}chars → truncated=${truncated.length}chars, model=${modelId}`);

  // Fetch user context for personalized prompts
  let userContextPreamble = "";
  if (paper.userId) {
    const userCtx = await getUserContext(paper.userId);
    userContextPreamble = buildUserContextPreamble(userCtx);
  }

  if (!deferredOnly) {
    try {
      await tryAssignEntity(paper);
      paper = (await prisma.paper.findUnique({
        where: { id: paperId },
        select: paperSelect,
      })) ?? paper;
    } catch (e) {
      console.error("[auto-process] Initial entity assignment failed for", paperId, ":", e);
    }
  }

  // Steps 1-3: Essential steps (metadata, summarize, categorize)
  // Skipped when running deferred-only (paper already has these)
  if (deferredOnly) {
    console.log("[auto-process] Running deferred steps only for", paperId);
  }

  // Step 1: Extract metadata
  if (!skipExtract && !deferredOnly) {
    try {
      checkCancelled();
      await setStep(paperId, "metadata", {
        processingStatus: baseProcessingStatus,
        processingRunId,
      });
      console.log("[auto-process] Extracting metadata for", paperId);
      const { system, prompt } = buildPrompt("extract", truncated);
      const { object: parsed, resultText } = await runProcessingStructuredCall(
        { paperId, userId: paper.userId, step: "extract", processingRunId },
        {
          provider,
          modelId,
          system,
          prompt,
          schemaName: "extract",
          schema: extractRuntimeOutputSchema,
          maxTokens: 2000,
          proxyConfig,
        },
      );

      await prisma.promptResult.create({
        data: {
          paperId,
          promptType: "extract",
          prompt: "Auto-extract metadata",
          result: resultText,
          provider,
          model: modelId,
        },
      });

      const updateData: Record<string, unknown> = {};
      if (parsed.title) updateData.title = parsed.title;
      if (parsed.authors) updateData.authors = JSON.stringify(parsed.authors);
      if (parsed.year) updateData.year = parsed.year;
      if (parsed.venue) updateData.venue = parsed.venue;
      if (parsed.doi && !paper.doi) updateData.doi = parsed.doi;
      if (parsed.arxivId && !paper.arxivId) updateData.arxivId = parsed.arxivId;
      if (parsed.abstract) updateData.abstract = parsed.abstract;
      if (parsed.keyFindings)
        updateData.keyFindings = JSON.stringify(parsed.keyFindings);

      if (Object.keys(updateData).length > 0) {
        await prisma.paper.update({
          where: { id: paperId },
          data: updateData,
        });
        paper = (await prisma.paper.findUnique({
          where: { id: paperId },
          select: paperSelect,
        })) ?? paper;
      }
    } catch (e) {
      console.error("[auto-process] Extract failed for", paperId, ":", e instanceof Error ? e.message : e);
    }
  }

  if (!deferredOnly) {
    try {
      await tryAssignEntity(paper);
      paper = (await prisma.paper.findUnique({
        where: { id: paperId },
        select: paperSelect,
      })) ?? paper;
    } catch (e) {
      console.error("[auto-process] Post-metadata entity assignment failed for", paperId, ":", e);
    }
  }

  // Step 2: Summarize (uses chunked map-reduce for long papers)
  if (!deferredOnly) try {
    checkCancelled();
    await setStep(paperId, "summarize", {
      processingStatus: baseProcessingStatus,
      processingRunId,
    });
    console.log("[auto-process] Summarizing", paperId);
    const result = await chunkedSummarize({
      paperId,
      userId: paper.userId,
      fullText: text,
      provider,
      modelId,
      proxyConfig,
      signal,
      userContextPreamble,
      processingRunId,
    });

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
    console.error("[auto-process] Summarize failed for", paperId, ":", e instanceof Error ? e.message : e);
  }

  // Step 3: Categorize + auto-tag (with duplicate prevention + score-aware hints)
  if (!deferredOnly) try {
    checkCancelled();
    await setStep(paperId, "categorize", {
      processingStatus: baseProcessingStatus,
      processingRunId,
    });
    console.log("[auto-process] Categorizing", paperId);
    const existingTags = await getExistingTagNames();
    const { goodTags, overusedTags } = await getScoredTagHints();
      const { system, prompt } = buildPrompt("categorize", truncated, undefined, {
        existingTags: goodTags.length > 0 ? goodTags : existingTags,
        overusedTags,
      });
      const { object: parsed, resultText } = await runProcessingStructuredCall(
        { paperId, userId: paper.userId, step: "categorize", processingRunId },
        {
          provider,
          modelId,
          system,
          prompt,
          schemaName: "categorize",
          schema: categorizeRuntimeOutputSchema,
          maxTokens: 1000,
          proxyConfig,
        },
      );

    await prisma.promptResult.create({
      data: {
        paperId,
        promptType: "categorize",
        prompt: "Auto-categorize paper",
        result: resultText,
        provider,
        model: modelId,
      },
    });

    const tagNames = (parsed.tags || []) as string[];
    await resolveAndAssignTags(paperId, tagNames);

    // Refresh scores after new tags are assigned
    try {
      await refreshTagScores();
    } catch (e) {
      console.error("[auto-process] Score refresh failed:", e instanceof Error ? e.message : e);
    }
  } catch (e) {
    console.error("[auto-process] Categorize failed for", paperId, ":", e instanceof Error ? e.message : e);
  }

  // If essentialOnly mode, mark as NEEDS_DEFERRED and stop here.
  // Deferred steps (linking, contradictions, references, contexts, distill) run later
  // when the queue drains via runDeferredSteps().
  if (essentialOnly) {
    if (processingRunId) {
      await finishProcessingRun({
        paperId,
        processingRunId,
        processingStatus: "NEEDS_DEFERRED",
        runStatus: "COMPLETED",
      });
    } else {
      await setProcessingProjection(paperId, {
        processingStatus: "NEEDS_DEFERRED",
        processingStep: null,
        processingStartedAt: null,
      });
    }
    console.log("[auto-process] Essential pipeline completed for", paperId, "(deferred steps pending)");
    return { finalProcessingStatus: "NEEDS_DEFERRED" as const };
  }

  // Step 4: Link related papers
  try {
    const otherPapers = await prisma.paper.findMany({
      where: {
        id: { not: paperId },
        ...(paper.userId ? { userId: paper.userId } : {}),
      },
      select: {
        id: true,
        title: true,
        abstract: true,
        summary: true,
        categories: true,
        entityId: true,
      },
    });

    if (otherPapers.length > 0) {
      checkCancelled();
      await setStep(paperId, "linking", {
        processingStatus: baseProcessingStatus,
        processingRunId,
      });
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
      const { object: relations } = await runProcessingStructuredCall(
        { paperId, userId: paper.userId, step: "linkPapers", processingRunId },
        {
          provider,
          modelId,
          system,
          prompt: linkPrompt,
          schemaName: "linkPapers",
          schema: linkPapersRuntimeOutputSchema,
          maxTokens: 2000,
          proxyConfig,
        },
      );

      const validIds = new Set(otherPapers.map((p) => p.id));
      let created = 0;

      for (const rel of relations.slice(0, 20)) {
        if (!validIds.has(rel.targetPaperId)) continue;

        const targetPaper = otherPapers.find((candidate) => candidate.id === rel.targetPaperId);
        const clampedConfidence = Math.min(1, Math.max(0, rel.confidence || 0));

        await prisma.paperRelation.create({
          data: {
            sourcePaperId: paperId,
            targetPaperId: rel.targetPaperId,
            relationType: rel.relationType,
            description: rel.description || null,
            confidence: clampedConfidence,
            isAutoGenerated: true,
          },
        }).catch(() => {});

        if (paper.entityId && targetPaper?.entityId) {
          try {
            await createRelationAssertion({
              sourceEntityId: paper.entityId,
              targetEntityId: targetPaper.entityId,
              sourcePaperId: paperId,
              relationType: rel.relationType,
              description: rel.description || null,
              confidence: clampedConfidence,
              provenance: "llm_semantic",
              extractorVersion: "v1",
            });
            await projectLegacyRelation(
              paperId,
              rel.targetPaperId,
              paper.entityId,
              targetPaper.entityId
            );
          } catch {
            // Non-fatal
          }
        }

        created++;
      }

      console.log(
        `[auto-process] Created ${created} paper relations for`,
        paperId
      );
    }
  } catch (e) {
    console.error("[auto-process] Link related papers failed:", e);
  }

  // Step 5: Detect contradictions with related papers
  try {
    const relations = await prisma.paperRelation.findMany({
      where: { sourcePaperId: paperId, relationType: { not: "cites" } },
      orderBy: { confidence: "desc" },
      take: 10,
      select: { targetPaperId: true },
    });

    if (relations.length > 0) {
      checkCancelled();
      await setStep(paperId, "contradictions", {
        processingStatus: baseProcessingStatus,
        processingRunId,
      });
      console.log("[auto-process] Detecting contradictions for", paperId);

      const relatedPaperIds = relations.map((r) => r.targetPaperId);
      const relatedPapers = await prisma.paper.findMany({
        where: { id: { in: relatedPaperIds } },
        select: { id: true, title: true, abstract: true, summary: true, keyFindings: true },
      });

      // Re-fetch paper for latest summary/keyFindings
      const updatedPaper = await prisma.paper.findUnique({
        where: { id: paperId },
        select: { title: true, abstract: true, summary: true, keyFindings: true },
      });

      const newPaperInfo = [
        `Title: ${updatedPaper?.title || paper.title}`,
        updatedPaper?.abstract ? `Abstract: ${updatedPaper.abstract}` : "",
        updatedPaper?.summary ? `Summary: ${updatedPaper.summary.slice(0, 1000)}` : "",
        updatedPaper?.keyFindings ? `Key Findings: ${updatedPaper.keyFindings}` : "",
      ].filter(Boolean).join("\n");

      const relatedList = relatedPapers.map((p) => {
        const parts = [`id: ${p.id}`, `title: ${p.title}`];
        if (p.abstract) parts.push(`abstract: ${p.abstract.slice(0, 300)}`);
        if (p.summary) parts.push(`summary: ${p.summary.slice(0, 300)}`);
        if (p.keyFindings) parts.push(`keyFindings: ${p.keyFindings}`);
        return parts.join(" | ");
      }).join("\n");

      const contradictionPrompt = `NEW PAPER:\n${newPaperInfo}\n\n---\n\nRELATED PAPERS:\n${relatedList}`;
      const { system } = buildPrompt("detectContradictions", "");
      const { resultText } = await runProcessingStructuredCall(
        {
          paperId,
          userId: paper.userId,
          step: "detectContradictions",
          processingRunId,
        },
        {
          provider,
          modelId,
          system,
          prompt: contradictionPrompt,
          schemaName: "detectContradictions",
          schema: detectContradictionsRuntimeOutputSchema,
          maxTokens: 3000,
          proxyConfig,
        },
      );

      await prisma.promptResult.create({
        data: {
          paperId,
          promptType: "detectContradictions",
          prompt: "Auto-detect contradictions",
          result: resultText,
          provider,
          model: modelId,
        },
      });

      console.log("[auto-process] Contradiction detection completed for", paperId);
    }
  } catch (e) {
    console.error("[auto-process] Contradiction detection failed:", e);
  }

  // Step 6: Extract references
  if (paper.fullText) {
    try {
      checkCancelled();
      await setStep(paperId, "references", {
        processingStatus: baseProcessingStatus,
        processingRunId,
      });
      console.log("[auto-process] Extracting references for", paperId);
      const extractedReferences = await withLlmContext(
        {
          operation: "processing_extractReferences",
          userId: paper.userId ?? undefined,
          metadata: {
            runtime: "processing",
            source: "auto_process",
            paperId,
            step: "extractReferences",
            ...(processingRunId ? { processingRunId } : {}),
          },
        },
        () =>
          extractReferenceCandidates({
            paperId,
            filePath: paper.filePath ?? null,
            fullText: paper.fullText ?? "",
            provider,
            modelId,
            proxyConfig,
          }),
      );

      if (extractedReferences.llmRawResponse) {
        await prisma.promptResult.create({
          data: {
            paperId,
            promptType: "extractReferences",
            prompt: "Auto-extract references",
            result: extractedReferences.llmRawResponse,
            provider,
            model: modelId,
          },
        });
      }

        const refs = extractedReferences.candidates;
        if (Array.isArray(refs) && refs.length > 0) {
          const attemptSummary = extractedReferences.attempts
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
          console.log(
            `[auto-process] Reference extraction used ${extractedReferences.method} (${refs.length} candidates)${
              extractedReferences.fallbackReason
                ? ` after fallback: ${extractedReferences.fallbackReason}`
                : ""
            }${attemptSummary ? ` [${attemptSummary}]` : ""}`,
          );

          const persisted = await persistExtractedReferences({
            paperId,
            paperUserId: paper.userId,
            sourceEntityId: paper.entityId,
            references: refs,
            provenance:
              extractedReferences.method === "grobid_tei"
                ? "grobid_tei"
                : "llm_extraction",
            extractorVersion: extractedReferences.extractorVersion,
          });
          console.log(
            `[auto-process] Extracted ${persisted.storedReferences} references, ${persisted.promotedPaperEdges} promoted paper edges, ${persisted.titleHintMatches} title hints for`,
            paperId
          );
        }
    } catch (e) {
      console.error("[auto-process] Extract references failed:", e);
    }
  }

  // Step 6: Extract citation contexts from body text
  if (paper.fullText || paper.filePath) {
    try {
      // Check that references exist for this paper
      const existingRefs = await prisma.reference.findMany({
        where: { paperId },
        select: { id: true, title: true, authors: true, year: true, referenceIndex: true },
      });

      if (existingRefs.length > 0) {
        checkCancelled();
        await setStep(paperId, "contexts", {
          processingStatus: baseProcessingStatus,
          processingRunId,
        });
        console.log("[auto-process] Extracting citation contexts for", paperId);

        let mentionInputs: CitationMentionInput[] = [];
        let provenance = "llm_extraction";
        let extractorVersion = "v1";

        if (paper.filePath) {
          const grobidMentions = await new GrobidCitationMentionExtractor().extract(
            paper.filePath,
          );
          if (grobidMentions.mentions.length > 0) {
            mentionInputs = grobidMentions.mentions;
            provenance = "grobid_fulltext";
            extractorVersion = "grobid_fulltext_v1";
            console.log(
              `[auto-process] Parsed ${mentionInputs.length} structural citation mentions via GROBID for`,
              paperId,
            );
          } else if (grobidMentions.errorSummary) {
            console.warn(
              "[auto-process] GROBID citation mention extraction fell back to LLM",
              {
                paperId,
                reason: grobidMentions.errorSummary,
                preflight: grobidMentions.preflight?.result ?? null,
              },
            );
          }
        }

        if (mentionInputs.length === 0 && paper.fullText) {
          const bodyText = getBodyTextForContextExtraction(paper.fullText);
          if (bodyText) {
            const { system } = buildPrompt("extractCitationContexts", "");
            const ctxPrompt = `Here is the body text of the paper:\n\n${bodyText}`;
            const { object: contexts } = await runProcessingStructuredCall(
              {
                paperId,
                userId: paper.userId,
                step: "extractCitationContexts",
                processingRunId,
              },
              {
                provider,
                modelId,
                system,
                prompt: ctxPrompt,
                schemaName: "extractCitationContexts",
                schema: extractCitationContextsRuntimeOutputSchema,
                maxTokens: 4000,
                proxyConfig,
              },
            );

            if (Array.isArray(contexts) && contexts.length > 0) {
              mentionInputs = contexts
                .filter((ctx) => ctx.citation && ctx.context)
                .map((ctx) => ({
                  citationText: ctx.citation,
                  excerpt: ctx.context,
                }));
            }
          }
        }

        if (mentionInputs.length > 0) {
          await createCitationMentions(
            paperId,
            mentionInputs,
            extractorVersion,
            provenance,
          );

          const updated = await applyLegacyCitationContexts(
            paperId,
            mentionInputs,
          );
          console.log(
            `[auto-process] Matched citation contexts to ${updated}/${existingRefs.length} references for`,
            paperId,
          );
        }
      }
    } catch (e) {
      console.error("[auto-process] Extract citation contexts failed:", e);
    }
  }

  // Step: Distill insights for Mind Palace
  try {
    checkCancelled();
    await setStep(paperId, "distill", {
      processingStatus: baseProcessingStatus,
      processingRunId,
    });
    console.log("[auto-process] Distilling insights for", paperId);

    const existingRooms = await prisma.mindPalaceRoom.findMany({
      select: { name: true },
    });
    const roomNames = existingRooms.map((r) => r.name);

    const { system: distillSystem, prompt: distillPrompt } = buildDistillPrompt(truncated, roomNames);
    const { object: parsed, resultText: distillResult } =
      await runProcessingStructuredCall(
      { paperId, userId: paper.userId, step: "distill", processingRunId },
      {
        provider,
        modelId,
        system: distillSystem,
        prompt: distillPrompt,
        schemaName: "distill",
        schema: distillRuntimeOutputSchema,
        maxTokens: 4000,
        proxyConfig,
      },
    );

    await prisma.promptResult.create({
      data: {
        paperId,
        promptType: "distill",
        prompt: "Auto-distill insights",
        result: distillResult,
        provider,
        model: modelId,
      },
    });

    if (Array.isArray(parsed.insights)) {
      let created = 0;
      for (const insight of parsed.insights.slice(0, 10)) {
        if (!insight.learning || !insight.significance) continue;

        const roomName = insight.roomSuggestion || "General";
        let room = await prisma.mindPalaceRoom.findUnique({
          where: { name: roomName },
        });
        if (!room) {
          room = await prisma.mindPalaceRoom.create({
            data: { name: roomName, isAutoGenerated: true },
          });
        }

        await prisma.insight.create({
          data: {
            roomId: room.id,
            paperId,
            learning: insight.learning,
            significance: insight.significance,
            applications: insight.applications || null,
            isAutoGenerated: true,
          },
        });
        created++;
      }
      console.log(`[auto-process] Created ${created} insights for`, paperId);
    }
  } catch (e) {
    console.error("[auto-process] Distill insights failed:", e);
  }

  if (processingRunId) {
    await finishProcessingRun({
      paperId,
      processingRunId,
      processingStatus: "COMPLETED",
      runStatus: "COMPLETED",
    });
  } else {
    await setProcessingProjection(paperId, {
      processingStatus: "COMPLETED",
      processingStep: null,
      processingStartedAt: null,
    });
  }

  console.log("[auto-process] Pipeline completed for", paperId);
  return { finalProcessingStatus: "COMPLETED" as const };
}

/**
 * Find papers that completed essential-only processing (NEEDS_DEFERRED)
 * and run the remaining steps (linking, contradictions, references, distill).
 * Called automatically when the processing queue drains.
 */
export async function runDeferredSteps(): Promise<number> {
  let totalCompleted = 0;

  // Process in batches until no more NEEDS_DEFERRED papers remain
  while (true) {
    const papers = await prisma.paper.findMany({
      where: { processingStatus: "NEEDS_DEFERRED" },
      select: { id: true, sourceType: true },
      take: 10,
    });

    if (papers.length === 0) break;

    console.log(`[auto-process] Running deferred steps for ${papers.length} papers (${totalCompleted} done so far)`);

    for (const paper of papers) {
      try {
        const skipExtract = paper.sourceType === "ARXIV" || paper.sourceType === "OPENREVIEW";
        const run = await createProcessingRun({
          paperId: paper.id,
          trigger: "deferred",
          processingStatus: "NEEDS_DEFERRED",
          metadata: {
            source: "deferred",
          },
        });
        await runAutoProcessPipeline({
          paperId: paper.id,
          skipExtract,
          deferredOnly: true,
          processingRunId: run.id,
          trigger: "deferred",
        });
        totalCompleted++;
      } catch (e) {
        console.error(`[auto-process] Deferred processing failed for ${paper.id}:`, e);
        // Mark as failed so we don't loop forever
        const activeRun = await prisma.processingRun.findFirst({
          where: {
            paperId: paper.id,
            status: "RUNNING",
          },
          orderBy: { startedAt: "desc" },
          select: { id: true },
        }).catch(() => null);

        if (activeRun) {
          await finishProcessingRun({
            paperId: paper.id,
            processingRunId: activeRun.id,
            processingStatus: "FAILED",
            runStatus: "FAILED",
            activeStepStatus: "FAILED",
            error: e instanceof Error ? e.message : String(e),
          }).catch(() => {});
        } else {
          await setProcessingProjection(paper.id, {
            processingStatus: "FAILED",
            processingStep: null,
            processingStartedAt: null,
          }).catch(() => {});
        }
      }
    }
  }

  return totalCompleted;
}
