/**
 * Batch processing for papers using the Anthropic Messages Batch API.
 *
 * When processing many papers, batch mode is cheaper (50% discount) and
 * avoids rate limits. Results come back asynchronously (typically 1-4 hours).
 *
 * Phases handle step dependencies:
 *   Phase 1: extract + summarize + extractReferences (independent, only need fullText)
 *   Phase 2: categorize + linking + citationContexts + distill (need Phase 1 results)
 *   Phase 3: contradictions (needs linking results from Phase 2)
 */

import { prisma } from "@/lib/prisma";
import { v4 as uuidv4 } from "uuid";
import { getProxyConfig, type ProxyConfig } from "@/lib/llm/proxy-settings";
import { getDefaultModel } from "@/lib/llm/auto-process";
import { truncateText, MAX_PAPER_CHARS } from "@/lib/llm/provider";
import { buildPrompt, buildDistillPrompt, cleanJsonResponse } from "@/lib/llm/prompts";
import { getUserContext, buildUserContextPreamble } from "@/lib/llm/user-context";
import { getTextForReferenceExtraction, getBodyTextForContextExtraction } from "@/lib/references/extract-section";
import { findBestMatch } from "@/lib/references/match";
import { matchCitationToReference } from "@/lib/references/match-citation";
import { resolveAndAssignTags, getExistingTagNames, getScoredTagHints } from "@/lib/tags/auto-tag";
import { refreshTagScores } from "@/lib/tags/cleanup";

// ── Types ──────────────────────────────────────────────────────────

interface BatchRequest {
  custom_id: string;
  params: {
    model: string;
    max_tokens: number;
    system: string;
    messages: { role: "user"; content: string }[];
  };
}

interface BatchResult {
  custom_id: string;
  result: {
    type: "succeeded" | "errored" | "canceled";
    message?: {
      content: { type: string; text: string }[];
      usage: { input_tokens: number; output_tokens: number };
    };
    error?: { type: string; message: string };
  };
}

type StepType = "extract" | "summarize" | "extractReferences" |
  "categorize" | "linkPapers" | "extractCitationContexts" | "distillInsights" |
  "detectContradictions";

/**
 * Strip unpaired surrogates and other chars that break JSON serialization.
 */
function sanitizeText(text: string): string {
  // Remove lone surrogates (U+D800–U+DFFF) that aren't properly paired
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD");
}

// ── Constants ──────────────────────────────────────────────────────

// Estimated seconds per LLM call (used for threshold calculation)
const SECS_PER_CALL = 20;
const MAX_CONCURRENT = 3;
// If sequential processing would take longer than this (seconds), prefer batch
const BATCH_THRESHOLD_SECS = 2 * 60 * 60; // 2 hours

// ── Threshold Logic ────────────────────────────────────────────────

/**
 * Decide whether to use batch processing based on estimated sequential time.
 * Returns { useBatch, estimatedSeqMinutes, paperCount }.
 */
export function shouldUseBatch(
  paperCount: number,
  stepsPerPaper: number = 8,
): { useBatch: boolean; estimatedSeqMins: number } {
  const totalCalls = paperCount * stepsPerPaper;
  const seqSeconds = (totalCalls * SECS_PER_CALL) / MAX_CONCURRENT;
  return {
    useBatch: seqSeconds > BATCH_THRESHOLD_SECS,
    estimatedSeqMins: Math.round(seqSeconds / 60),
  };
}

// ── Anthropic Batch API Client ─────────────────────────────────────

async function getAnthropicBatchConfig(): Promise<{
  baseUrl: string;
  headers: Record<string, string>;
  modelId: string;
  proxyConfig: ProxyConfig;
}> {
  const proxyConfig = await getProxyConfig();
  if (!proxyConfig.enabled || !proxyConfig.anthropicBaseUrl) {
    throw new Error("Anthropic proxy not configured — batch processing requires the Anthropic API");
  }

  // Pick a Claude model from the proxy config
  const models = proxyConfig.modelId.split(",").map(s => s.trim());
  const claudeModel = models.find(m => m.startsWith("claude")) || "claude-haiku-4-5";

  return {
    baseUrl: proxyConfig.anthropicBaseUrl,
    headers: {
      [proxyConfig.headerName]: proxyConfig.headerValue,
      "X-LLM-Proxy-Target-URL": "https://api.anthropic.com",
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    modelId: claudeModel,
    proxyConfig,
  };
}

async function submitBatch(requests: BatchRequest[], config: Awaited<ReturnType<typeof getAnthropicBatchConfig>>): Promise<string> {
  // Sanitize all text content to prevent broken JSON from surrogate chars
  const sanitized = requests.map(r => ({
    ...r,
    params: {
      ...r.params,
      system: sanitizeText(r.params.system),
      messages: r.params.messages.map(m => ({ ...m, content: sanitizeText(m.content) })),
    },
  }));

  // Retry on transient gateway errors (502, 503, 429)
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(`${config.baseUrl}/messages/batches`, {
      method: "POST",
      headers: config.headers,
      body: JSON.stringify({ requests: sanitized }),
      signal: AbortSignal.timeout(60_000),
    });

    if (res.ok) {
      const data = await res.json() as { id: string };
      return data.id;
    }

    const body = await res.text();
    const retryable = res.status === 502 || res.status === 503 || res.status === 429;
    if (!retryable || attempt === MAX_RETRIES) {
      throw new Error(`Batch API error ${res.status}: ${body}`);
    }

    // Exponential backoff: 5s, 15s, 45s
    const delay = 5000 * Math.pow(3, attempt);
    console.warn(`[batch] Transient ${res.status} on attempt ${attempt + 1}, retrying in ${delay / 1000}s...`);
    await new Promise(r => setTimeout(r, delay));
  }

  throw new Error("Unreachable");
}

export async function checkBatchApiStatus(anthropicBatchId: string): Promise<{
  status: string;
  requestCounts: { processing: number; succeeded: number; errored: number; canceled: number; expired: number };
}> {
  const config = await getAnthropicBatchConfig();
  const res = await fetch(`${config.baseUrl}/messages/batches/${anthropicBatchId}`, {
    headers: config.headers,
    signal: AbortSignal.timeout(15_000),
  });

  if (!res.ok) {
    throw new Error(`Batch status check failed: ${res.status}`);
  }

  // Anthropic API uses snake_case: processing_status, request_counts
  const data = await res.json() as {
    processing_status: string;
    request_counts: { processing: number; succeeded: number; errored: number; canceled: number; expired: number };
  };

  return {
    status: data.processing_status,
    requestCounts: data.request_counts,
  };
}

async function downloadBatchResults(anthropicBatchId: string): Promise<BatchResult[]> {
  const config = await getAnthropicBatchConfig();
  const res = await fetch(`${config.baseUrl}/messages/batches/${anthropicBatchId}/results`, {
    headers: config.headers,
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    throw new Error(`Batch results download failed: ${res.status}`);
  }

  // Response is JSONL (one JSON object per line)
  const text = await res.text();

  // Save raw JSONL to disk as backup before processing into DB
  try {
    const fs = await import("fs/promises");
    const path = await import("path");
    const dir = path.join(process.cwd(), "prisma", "backups", "batch-results");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${anthropicBatchId}.jsonl`), text);
  } catch {}

  return text.trim().split("\n").map(line => JSON.parse(line) as BatchResult);
}

// ── Prompt Builders (per step, per paper) ──────────────────────────

function buildExtractRequest(paperId: string, truncatedText: string, modelId: string): BatchRequest {
  const { system, prompt } = buildPrompt("extract", truncatedText);
  return {
    custom_id: `${paperId}--extract`,
    params: { model: modelId, max_tokens: 2000, system, messages: [{ role: "user", content: prompt }] },
  };
}

function buildSummarizeRequest(paperId: string, truncatedText: string, modelId: string, preamble: string): BatchRequest {
  const { system, prompt } = buildPrompt("summarize", truncatedText, undefined, { userContextPreamble: preamble });
  return {
    custom_id: `${paperId}--summarize`,
    params: { model: modelId, max_tokens: 4096, system, messages: [{ role: "user", content: prompt }] },
  };
}

function buildExtractReferencesRequest(paperId: string, refText: string, modelId: string): BatchRequest {
  const { system } = buildPrompt("extractReferences", "");
  const prompt = `Here is the reference/bibliography section of the paper:\n\n${refText}`;
  return {
    custom_id: `${paperId}--extractReferences`,
    params: { model: modelId, max_tokens: 8000, system, messages: [{ role: "user", content: prompt }] },
  };
}

function buildCategorizeRequest(paperId: string, truncatedText: string, modelId: string, goodTags: string[], overusedTags: string[]): BatchRequest {
  const { system, prompt } = buildPrompt("categorize", truncatedText, undefined, {
    existingTags: goodTags,
    overusedTags,
  });
  return {
    custom_id: `${paperId}--categorize`,
    params: { model: modelId, max_tokens: 1000, system, messages: [{ role: "user", content: prompt }] },
  };
}

function buildLinkingRequest(
  paperId: string,
  paperInfo: string,
  existingPapersList: string,
  modelId: string,
): BatchRequest {
  const { system } = buildPrompt("linkPapers", "");
  const prompt = `NEW PAPER:\n${paperInfo}\n\n---\n\nEXISTING PAPERS IN LIBRARY:\n${existingPapersList}`;
  return {
    custom_id: `${paperId}--linkPapers`,
    params: { model: modelId, max_tokens: 2000, system, messages: [{ role: "user", content: prompt }] },
  };
}

function buildCitationContextsRequest(paperId: string, bodyText: string, modelId: string): BatchRequest {
  const { system } = buildPrompt("extractCitationContexts", "");
  return {
    custom_id: `${paperId}--extractCitationContexts`,
    params: { model: modelId, max_tokens: 4000, system, messages: [{ role: "user", content: bodyText }] },
  };
}

function buildDistillRequest(paperId: string, truncatedText: string, modelId: string, roomNames: string[]): BatchRequest {
  const { system, prompt } = buildDistillPrompt(truncatedText, roomNames);
  return {
    custom_id: `${paperId}--distillInsights`,
    params: { model: modelId, max_tokens: 4000, system, messages: [{ role: "user", content: prompt }] },
  };
}

function buildContradictionsRequest(
  paperId: string,
  paperInfo: string,
  relatedList: string,
  modelId: string,
): BatchRequest {
  const { system } = buildPrompt("detectContradictions", "");
  const prompt = `NEW PAPER:\n${paperInfo}\n\n---\n\nRELATED PAPERS:\n${relatedList}`;
  return {
    custom_id: `${paperId}--detectContradictions`,
    params: { model: modelId, max_tokens: 3000, system, messages: [{ role: "user", content: prompt }] },
  };
}

// ── Phase Builders ─────────────────────────────────────────────────

async function buildPhase1Requests(
  paperIds: string[],
  modelId: string,
  proxyConfig: ProxyConfig,
): Promise<{ requests: BatchRequest[]; skippedForChunking: string[] }> {
  const requests: BatchRequest[] = [];
  const skippedForChunking: string[] = [];

  const papers = await prisma.paper.findMany({
    where: { id: { in: paperIds } },
    select: { id: true, fullText: true, abstract: true, sourceType: true, userId: true, summary: true, keyFindings: true },
  });

  // Get user context once (same user for all papers)
  let userContextPreamble = "";
  const firstUser = papers.find(p => p.userId)?.userId;
  if (firstUser) {
    const ctx = await getUserContext(firstUser);
    userContextPreamble = buildUserContextPreamble(ctx);
  }

  for (const paper of papers) {
    // Use fullText if available, otherwise fall back to abstract
    const text = paper.fullText || paper.abstract;
    if (!text) continue;

    const truncated = truncateText(text, modelId, proxyConfig);

    // Extract metadata (skip for ArXiv/OpenReview that already have it)
    if (paper.fullText && paper.sourceType !== "ARXIV" && paper.sourceType !== "OPENREVIEW" && !paper.keyFindings) {
      requests.push(buildExtractRequest(paper.id, truncated, modelId));
    }

    // Summarize — use truncated text for all papers (batch discount is worth the truncation)
    if (!paper.summary) {
      requests.push(buildSummarizeRequest(paper.id, truncated, modelId, userContextPreamble));
    }

    // Extract references (only if we have full text)
    if (paper.fullText) {
      const refText = getTextForReferenceExtraction(paper.fullText);
      if (refText) {
        requests.push(buildExtractReferencesRequest(paper.id, refText, modelId));
      }
    }
  }

  return { requests, skippedForChunking };
}

async function buildPhase2Requests(
  paperIds: string[],
  modelId: string,
  proxyConfig: ProxyConfig,
): Promise<BatchRequest[]> {
  const requests: BatchRequest[] = [];

  const papers = await prisma.paper.findMany({
    where: { id: { in: paperIds } },
    select: { id: true, title: true, abstract: true, summary: true, categories: true, fullText: true },
  });

  // Shared context for categorize
  const existingTags = await getExistingTagNames();
  const { goodTags, overusedTags } = await getScoredTagHints();
  const tagsForPrompt = goodTags.length > 0 ? goodTags : existingTags;

  // Shared context for linking — all papers in library
  const allPapers = await prisma.paper.findMany({
    where: { id: { notIn: paperIds } }, // Exclude batch papers from existing list
    select: { id: true, title: true, abstract: true, summary: true, categories: true },
  });

  const existingPapersList = allPapers.map(p => {
    const parts = [`id: ${p.id}`, `title: ${p.title}`];
    if (p.abstract) parts.push(`abstract: ${p.abstract.slice(0, 200)}`);
    if (p.summary) parts.push(`summary: ${p.summary.slice(0, 200)}`);
    if (p.categories) parts.push(`categories: ${p.categories}`);
    return parts.join(" | ");
  }).join("\n");

  // Also include batch papers (with their now-available summaries) in the linking context
  const batchPapersForContext = papers.map(p => {
    const parts = [`id: ${p.id}`, `title: ${p.title}`];
    if (p.abstract) parts.push(`abstract: ${p.abstract?.slice(0, 200)}`);
    if (p.summary) parts.push(`summary: ${p.summary?.slice(0, 200)}`);
    if (p.categories) parts.push(`categories: ${p.categories}`);
    return parts.join(" | ");
  }).join("\n");

  const fullExistingList = existingPapersList + "\n" + batchPapersForContext;

  // Existing Mind Palace rooms for distill
  const existingRooms = await prisma.mindPalaceRoom.findMany({ select: { name: true } });
  const roomNames = existingRooms.map(r => r.name);

  for (const paper of papers) {
    const text = paper.fullText || paper.abstract;
    if (!text) continue;
    const truncated = truncateText(text, modelId, proxyConfig);

    // Categorize
    requests.push(buildCategorizeRequest(paper.id, truncated, modelId, tagsForPrompt, overusedTags));

    // Linking
    const paperInfo = [
      `Title: ${paper.title}`,
      paper.abstract ? `Abstract: ${paper.abstract}` : "",
      paper.summary ? `Summary: ${paper.summary.slice(0, 500)}` : "",
      paper.categories ? `Categories: ${paper.categories}` : "",
    ].filter(Boolean).join("\n");
    requests.push(buildLinkingRequest(paper.id, paperInfo, fullExistingList, modelId));

    // Citation contexts (needs references from Phase 1, and full text)
    if (paper.fullText) {
      const refs = await prisma.reference.findMany({
        where: { paperId: paper.id },
        select: { id: true },
      });
      if (refs.length > 0) {
        const bodyText = getBodyTextForContextExtraction(paper.fullText);
        if (bodyText) {
          requests.push(buildCitationContextsRequest(paper.id, bodyText, modelId));
        }
      }
    }

    // Distill insights
    requests.push(buildDistillRequest(paper.id, truncated, modelId, roomNames));
  }

  return requests;
}

async function buildPhase3Requests(
  paperIds: string[],
  modelId: string,
): Promise<BatchRequest[]> {
  const requests: BatchRequest[] = [];

  for (const paperId of paperIds) {
    // Get this paper's relations from Phase 2 linking
    const relations = await prisma.paperRelation.findMany({
      where: { sourcePaperId: paperId, relationType: { not: "cites" } },
      orderBy: { confidence: "desc" },
      take: 10,
      select: { targetPaperId: true },
    });

    if (relations.length === 0) continue;

    const relatedPaperIds = relations.map(r => r.targetPaperId);
    const relatedPapers = await prisma.paper.findMany({
      where: { id: { in: relatedPaperIds } },
      select: { id: true, title: true, abstract: true, summary: true, keyFindings: true },
    });

    const paper = await prisma.paper.findUnique({
      where: { id: paperId },
      select: { title: true, abstract: true, summary: true, keyFindings: true },
    });

    if (!paper) continue;

    const paperInfo = [
      `Title: ${paper.title}`,
      paper.abstract ? `Abstract: ${paper.abstract}` : "",
      paper.summary ? `Summary: ${paper.summary.slice(0, 1000)}` : "",
      paper.keyFindings ? `Key Findings: ${paper.keyFindings}` : "",
    ].filter(Boolean).join("\n");

    const relatedList = relatedPapers.map(p => {
      const parts = [`id: ${p.id}`, `title: ${p.title}`];
      if (p.abstract) parts.push(`abstract: ${p.abstract.slice(0, 300)}`);
      if (p.summary) parts.push(`summary: ${p.summary.slice(0, 300)}`);
      if (p.keyFindings) parts.push(`keyFindings: ${p.keyFindings}`);
      return parts.join(" | ");
    }).join("\n");

    requests.push(buildContradictionsRequest(paperId, paperInfo, relatedList, modelId));
  }

  return requests;
}

// ── Result Processors ──────────────────────────────────────────────

function getResultText(result: BatchResult): string | null {
  if (result.result.type !== "succeeded" || !result.result.message) return null;
  const textBlock = result.result.message.content.find(c => c.type === "text");
  return textBlock?.text || null;
}

async function processExtractResult(paperId: string, text: string, modelId: string) {
  await prisma.promptResult.create({
    data: { paperId, promptType: "extract", prompt: "Auto-extract metadata (batch)", result: text, provider: "proxy", model: modelId },
  });

  try {
    const cleaned = cleanJsonResponse(text);
    const parsed = JSON.parse(cleaned);
    const updateData: Record<string, unknown> = {};
    if (parsed.title) updateData.title = parsed.title;
    if (parsed.authors) updateData.authors = JSON.stringify(parsed.authors);
    if (parsed.year) updateData.year = parsed.year;
    if (parsed.venue) updateData.venue = parsed.venue;
    if (parsed.abstract) updateData.abstract = parsed.abstract;
    if (parsed.keyFindings) updateData.keyFindings = JSON.stringify(parsed.keyFindings);
    if (Object.keys(updateData).length > 0) {
      await prisma.paper.update({ where: { id: paperId }, data: updateData });
    }
  } catch { /* JSON parse failed */ }
}

async function processSummarizeResult(paperId: string, text: string, modelId: string) {
  await prisma.promptResult.create({
    data: { paperId, promptType: "summarize", prompt: "Auto-summarize paper (batch)", result: text, provider: "proxy", model: modelId },
  });
  await prisma.paper.update({ where: { id: paperId }, data: { summary: text } });
}

async function processExtractReferencesResult(paperId: string, text: string, modelId: string) {
  await prisma.promptResult.create({
    data: { paperId, promptType: "extractReferences", prompt: "Auto-extract references (batch)", result: text, provider: "proxy", model: modelId },
  });

  try {
    const cleaned = cleanJsonResponse(text);
    const refs = JSON.parse(cleaned) as Array<{
      index?: number; title: string; authors?: string[] | null;
      year?: number | null; venue?: string | null; doi?: string | null; rawCitation: string;
    }>;

    if (!Array.isArray(refs) || refs.length === 0) return;

    await prisma.reference.deleteMany({ where: { paperId } });
    const libraryPapers = await prisma.paper.findMany({
      where: { id: { not: paperId } },
      select: { id: true, title: true },
    });

    for (const ref of refs.slice(0, 200)) {
      if (!ref.title) continue;
      const match = findBestMatch(ref.title, libraryPapers);
      await prisma.reference.create({
        data: {
          paperId, title: ref.title,
          authors: ref.authors ? JSON.stringify(ref.authors) : null,
          year: ref.year ?? null, venue: ref.venue ?? null, doi: ref.doi ?? null,
          rawCitation: ref.rawCitation || ref.title, referenceIndex: ref.index ?? null,
          matchedPaperId: match?.paperId ?? null, matchConfidence: match?.confidence ?? null,
        },
      });
      if (match) {
        await prisma.paperRelation.create({
          data: {
            sourcePaperId: paperId, targetPaperId: match.paperId,
            relationType: "cites", description: `Cited as: "${ref.title}"`,
            confidence: match.confidence, isAutoGenerated: true,
          },
        }).catch(() => {});
      }
    }
  } catch { /* JSON parse failed */ }
}

async function processCategorizeResult(paperId: string, text: string, modelId: string) {
  await prisma.promptResult.create({
    data: { paperId, promptType: "categorize", prompt: "Auto-categorize (batch)", result: text, provider: "proxy", model: modelId },
  });

  try {
    const cleaned = cleanJsonResponse(text);
    const parsed = JSON.parse(cleaned);
    const tagNames = (parsed.tags || []) as string[];
    await resolveAndAssignTags(paperId, tagNames);
  } catch { /* JSON parse failed */ }
}

async function processLinkingResult(paperId: string, text: string, modelId: string) {
  try {
    const cleaned = cleanJsonResponse(text);
    const relations = JSON.parse(cleaned) as Array<{
      targetPaperId: string; relationType: string; description?: string; confidence: number;
    }>;

    // Validate target IDs exist
    const targetIds = relations.map(r => r.targetPaperId);
    const valid = await prisma.paper.findMany({
      where: { id: { in: targetIds } },
      select: { id: true },
    });
    const validIds = new Set(valid.map(p => p.id));

    for (const rel of relations.slice(0, 20)) {
      if (!validIds.has(rel.targetPaperId)) continue;
      await prisma.paperRelation.create({
        data: {
          sourcePaperId: paperId, targetPaperId: rel.targetPaperId,
          relationType: rel.relationType, description: rel.description || null,
          confidence: Math.min(1, Math.max(0, rel.confidence || 0)),
          isAutoGenerated: true,
        },
      }).catch(() => {});
    }
  } catch { /* JSON parse failed */ }
}

async function processCitationContextsResult(paperId: string, text: string) {
  try {
    const cleaned = cleanJsonResponse(text);
    const contexts = JSON.parse(cleaned) as Array<{ citation: string; context: string }>;
    if (!Array.isArray(contexts) || contexts.length === 0) return;

    const existingRefs = await prisma.reference.findMany({
      where: { paperId },
      select: { id: true, title: true, authors: true, year: true, referenceIndex: true },
    });

    const contextsByRef = new Map<string, string[]>();
    for (const ctx of contexts) {
      if (!ctx.citation || !ctx.context) continue;
      const refId = matchCitationToReference(ctx.citation, existingRefs);
      if (!refId) continue;
      const existing = contextsByRef.get(refId) || [];
      if (!existing.includes(ctx.context)) existing.push(ctx.context);
      contextsByRef.set(refId, existing);
    }

    const entries = Array.from(contextsByRef.entries());
    for (const [refId, ctxList] of entries) {
      await prisma.reference.update({
        where: { id: refId },
        data: { citationContext: ctxList.join("; ") },
      });
    }
  } catch { /* JSON parse failed */ }
}

async function processDistillResult(paperId: string, text: string, modelId: string) {
  await prisma.promptResult.create({
    data: { paperId, promptType: "distill", prompt: "Auto-distill insights (batch)", result: text, provider: "proxy", model: modelId },
  });

  try {
    const cleaned = cleanJsonResponse(text);
    const parsed = JSON.parse(cleaned) as {
      insights: Array<{ learning: string; significance: string; applications?: string; roomSuggestion: string }>;
    };

    if (!Array.isArray(parsed.insights)) return;

    for (const insight of parsed.insights.slice(0, 10)) {
      if (!insight.learning || !insight.significance) continue;
      const roomName = insight.roomSuggestion || "General";
      let room = await prisma.mindPalaceRoom.findUnique({ where: { name: roomName } });
      if (!room) {
        room = await prisma.mindPalaceRoom.create({ data: { name: roomName, isAutoGenerated: true } });
      }
      await prisma.insight.create({
        data: {
          roomId: room.id, paperId,
          learning: insight.learning, significance: insight.significance,
          applications: insight.applications || null, isAutoGenerated: true,
        },
      });
    }
  } catch { /* JSON parse failed */ }
}

async function processContradictionsResult(paperId: string, text: string, modelId: string) {
  await prisma.promptResult.create({
    data: { paperId, promptType: "detectContradictions", prompt: "Auto-detect contradictions (batch)", result: text, provider: "proxy", model: modelId },
  });
}

// ── Main Entry Points ──────────────────────────────────────────────

/**
 * Create and submit a batch processing job for the given papers.
 * Returns the groupId for tracking all phases.
 */
export async function createBatchJob(paperIds: string[]): Promise<{
  groupId: string;
  phase1BatchId: string;
  requestCount: number;
  skippedForChunking: string[];
}> {
  const config = await getAnthropicBatchConfig();
  const groupId = uuidv4();

  // Build Phase 1 requests
  const { requests, skippedForChunking } = await buildPhase1Requests(paperIds, config.modelId, config.proxyConfig);

  if (requests.length === 0) {
    throw new Error("No batch requests to submit — papers may already be processed or have no text");
  }

  console.log(`[batch] Submitting Phase 1 batch: ${requests.length} requests for ${paperIds.length} papers`);

  // Submit to Anthropic
  const anthropicBatchId = await submitBatch(requests, config);

  // Record in DB
  const stepTypes = Array.from(new Set(requests.map(r => r.custom_id.split("--")[1])));
  await prisma.processingBatch.create({
    data: {
      groupId,
      anthropicBatchId,
      phase: 1,
      status: "SUBMITTED",
      modelId: config.modelId,
      paperIds: JSON.stringify(paperIds),
      stepTypes: JSON.stringify(stepTypes),
      requestCount: requests.length,
    },
  });

  // Mark papers as batch-processing
  await prisma.paper.updateMany({
    where: { id: { in: paperIds } },
    data: { processingStatus: "BATCH_PROCESSING", processingStep: "batch-phase-1" },
  });

  return { groupId, phase1BatchId: anthropicBatchId, requestCount: requests.length, skippedForChunking };
}

/**
 * Check status of a batch and process results if complete.
 * Auto-submits next phase when current phase finishes.
 */
export async function pollBatch(batchDbId: string): Promise<{
  status: string;
  phase: number;
  completed: number;
  failed: number;
  total: number;
  nextPhaseSubmitted?: boolean;
}> {
  const batch = await prisma.processingBatch.findUnique({ where: { id: batchDbId } });
  if (!batch || !batch.anthropicBatchId) {
    throw new Error("Batch not found");
  }

  if (batch.status === "COMPLETED" || batch.status === "FAILED") {
    return {
      status: batch.status,
      phase: batch.phase,
      completed: batch.completedCount,
      failed: batch.failedCount,
      total: batch.requestCount,
    };
  }

  // Check Anthropic API
  const apiStatus = await checkBatchApiStatus(batch.anthropicBatchId);
  const counts = apiStatus.requestCounts;

  if (apiStatus.status === "ended") {
    // Process results
    console.log(`[batch] Phase ${batch.phase} ended. Processing results...`);
    const results = await downloadBatchResults(batch.anthropicBatchId);
    const paperIds = JSON.parse(batch.paperIds) as string[];

    let succeeded = 0;
    let failed = 0;

    for (const result of results) {
      const [paperId, stepType] = result.custom_id.split("--") as [string, StepType];
      const text = getResultText(result);

      if (!text) {
        failed++;
        console.error(`[batch] Failed: ${result.custom_id} — ${result.result.error?.message || "no output"}`);
        continue;
      }

      try {
        switch (stepType) {
          case "extract": await processExtractResult(paperId, text, batch.modelId); break;
          case "summarize": await processSummarizeResult(paperId, text, batch.modelId); break;
          case "extractReferences": await processExtractReferencesResult(paperId, text, batch.modelId); break;
          case "categorize": await processCategorizeResult(paperId, text, batch.modelId); break;
          case "linkPapers": await processLinkingResult(paperId, text, batch.modelId); break;
          case "extractCitationContexts": await processCitationContextsResult(paperId, text); break;
          case "distillInsights": await processDistillResult(paperId, text, batch.modelId); break;
          case "detectContradictions": await processContradictionsResult(paperId, text, batch.modelId); break;
        }
        succeeded++;
      } catch (e) {
        failed++;
        console.error(`[batch] Error processing ${result.custom_id}:`, e);
      }
    }

    // Refresh tag scores after categorize results
    if (batch.phase === 2) {
      try { await refreshTagScores(); } catch { /* ignore */ }
    }

    // Update batch record
    await prisma.processingBatch.update({
      where: { id: batchDbId },
      data: {
        status: "COMPLETED",
        completedCount: succeeded,
        failedCount: failed,
        completedAt: new Date(),
      },
    });

    // Auto-submit next phase
    let nextPhaseSubmitted = false;
    if (batch.phase < 3) {
      try {
        await submitNextPhase(batch.groupId, batch.phase + 1, paperIds, batch.modelId);
        nextPhaseSubmitted = true;
      } catch (e) {
        console.error(`[batch] Failed to submit phase ${batch.phase + 1}:`, e);
      }
    } else {
      // All phases done — mark papers as COMPLETED
      await prisma.paper.updateMany({
        where: { id: { in: paperIds } },
        data: { processingStatus: "COMPLETED", processingStep: null, processingStartedAt: null },
      });
      console.log(`[batch] All phases complete for group ${batch.groupId}. ${paperIds.length} papers marked COMPLETED.`);
    }

    return { status: "COMPLETED", phase: batch.phase, completed: succeeded, failed, total: results.length, nextPhaseSubmitted };
  }

  // Still processing — update counts
  await prisma.processingBatch.update({
    where: { id: batchDbId },
    data: {
      status: "PROCESSING",
      completedCount: counts.succeeded,
      failedCount: counts.errored,
    },
  });

  return {
    status: "PROCESSING",
    phase: batch.phase,
    completed: counts.succeeded,
    failed: counts.errored,
    total: batch.requestCount,
  };
}

export async function submitNextPhase(groupId: string, phase: number, paperIds: string[], modelId: string) {
  const config = await getAnthropicBatchConfig();

  let requests: BatchRequest[];
  if (phase === 2) {
    requests = await buildPhase2Requests(paperIds, modelId, config.proxyConfig);
  } else if (phase === 3) {
    requests = await buildPhase3Requests(paperIds, modelId);
  } else {
    return;
  }

  if (requests.length === 0) {
    console.log(`[batch] No requests for phase ${phase}, skipping`);
    // If phase 2 is empty, try phase 3; if phase 3 is empty, mark done
    if (phase === 2) {
      await submitNextPhase(groupId, 3, paperIds, modelId);
    } else {
      await prisma.paper.updateMany({
        where: { id: { in: paperIds } },
        data: { processingStatus: "COMPLETED", processingStep: null, processingStartedAt: null },
      });
    }
    return;
  }

  // Chunk large request sets to avoid proxy payload limits (502/413)
  const MAX_REQUESTS_PER_BATCH = 300;
  const chunks: BatchRequest[][] = [];
  for (let i = 0; i < requests.length; i += MAX_REQUESTS_PER_BATCH) {
    chunks.push(requests.slice(i, i + MAX_REQUESTS_PER_BATCH));
  }

  console.log(`[batch] Submitting Phase ${phase}: ${requests.length} requests in ${chunks.length} chunk(s)`);

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    if (ci > 0) {
      // Small delay between chunks to avoid rate limits
      await new Promise(r => setTimeout(r, 5000));
    }

    const anthropicBatchId = await submitBatch(chunk, config);
    const stepTypes = Array.from(new Set(chunk.map(r => r.custom_id.split("--")[1])));
    await prisma.processingBatch.create({
      data: {
        groupId,
        anthropicBatchId,
        phase,
        status: "SUBMITTED",
        modelId,
        paperIds: JSON.stringify(paperIds),
        stepTypes: JSON.stringify(stepTypes),
        requestCount: chunk.length,
      },
    });

    console.log(`[batch] Phase ${phase} chunk ${ci + 1}/${chunks.length}: ${anthropicBatchId} (${chunk.length} requests)`);
  }

  // Update paper step indicator
  await prisma.paper.updateMany({
    where: { id: { in: paperIds } },
    data: { processingStep: `batch-phase-${phase}` },
  });
}

/**
 * Get all batches for a group.
 */
export async function getBatchGroup(groupId: string) {
  return prisma.processingBatch.findMany({
    where: { groupId },
    orderBy: { phase: "asc" },
  });
}

/**
 * Get all active (non-terminal) batches.
 */
export async function getActiveBatches() {
  return prisma.processingBatch.findMany({
    where: { status: { in: ["SUBMITTED", "PROCESSING", "BUILDING"] } },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * Poll all active batches and process any completed ones.
 * Call this periodically (e.g., every 5 minutes).
 */
export async function pollAllActiveBatches(): Promise<{ checked: number; completed: number }> {
  const active = await getActiveBatches();
  let completed = 0;

  for (const batch of active) {
    try {
      const result = await pollBatch(batch.id);
      if (result.status === "COMPLETED") completed++;
    } catch (e) {
      console.error(`[batch] Poll error for ${batch.id}:`, e);
    }
  }

  // After batch completions, run tag maintenance if threshold reached
  if (completed > 0) {
    import("@/lib/tags/maintenance").then(({ maybeRunTagMaintenance }) => {
      maybeRunTagMaintenance().catch(() => {});
    }).catch(() => {});
  }

  return { checked: active.length, completed };
}
