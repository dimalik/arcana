import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  streamText: vi.fn(),
  chatModel: vi.fn((modelId: string) => ({ kind: "chat-model", modelId })),
  responsesModel: vi.fn((modelId: string) => ({ kind: "responses-model", modelId })),
  anthropicModel: vi.fn((modelId: string) => ({ kind: "anthropic-model", modelId })),
  logLlmUsage: vi.fn(),
  prisma: {
    setting: {
      findUnique: vi.fn(),
    },
    paper: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    promptResult: {
      create: vi.fn(),
    },
    reference: {
      count: vi.fn(),
      findMany: vi.fn(),
    },
    mindPalaceRoom: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    insight: {
      create: vi.fn(),
    },
    paperRelation: {
      findMany: vi.fn(),
      create: vi.fn(),
    },
  },
  getUserContext: vi.fn(),
  buildUserContextPreamble: vi.fn(() => ""),
  getExistingTagNames: vi.fn(async () => []),
  getScoredTagHints: vi.fn(async () => ({ goodTags: [], overusedTags: [] })),
  resolveAndAssignTags: vi.fn(),
  refreshTagScores: vi.fn(),
  extractReferenceCandidates: vi.fn(),
  persistExtractedReferences: vi.fn(),
  grobidExtract: vi.fn(),
  createCitationMentions: vi.fn(),
  applyLegacyCitationContexts: vi.fn(),
  createRelationAssertion: vi.fn(),
  projectLegacyRelation: vi.fn(),
  getProxyConfig: vi.fn(),
  loadGrobidConfig: vi.fn(() => ({ serverUrl: "http://127.0.0.1:8070" })),
  checkGrobidHealth: vi.fn(),
  cleanJsonResponse: vi.fn((text: string) => text),
  createProcessingRun: vi.fn().mockResolvedValue({ id: "run-auto" }),
  finishProcessingRun: vi.fn(),
  setProcessingProjection: vi.fn(),
  startProcessingStep: vi.fn(),
  clearProcessingStep: vi.fn(),
  getLatestActiveRunsForPapers: vi.fn().mockResolvedValue(new Map([["paper-batch", "run-batch"]])),
}));

vi.mock("ai", () => ({
  streamText: hoisted.streamText,
}));

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn(() => ({
    chat: hoisted.chatModel,
    responses: hoisted.responsesModel,
  })),
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() => hoisted.anthropicModel),
}));

vi.mock("@/lib/usage", () => ({
  logLlmUsage: hoisted.logLlmUsage,
}));

vi.mock("../../usage", () => ({
  logLlmUsage: hoisted.logLlmUsage,
}));

vi.mock("@/lib/llm/provider", async () => {
  const actual = await vi.importActual<typeof import("../../llm/provider")>("../../llm/provider");
  return actual;
});

vi.mock("@/lib/prisma", () => ({
  prisma: hoisted.prisma,
}));

vi.mock("@/lib/llm/proxy-settings", () => ({
  getProxyConfig: hoisted.getProxyConfig,
}));

vi.mock("../../llm/proxy-settings", async () => {
  const actual = await vi.importActual<typeof import("../../llm/proxy-settings")>("../../llm/proxy-settings");
  return {
    ...actual,
    getProxyConfig: hoisted.getProxyConfig,
  };
});

vi.mock("@/lib/llm/prompts", () => ({
  buildPrompt: vi.fn((promptType: string, prompt: string) => ({
    system: `${promptType}-system`,
    prompt,
  })),
  buildDistillPrompt: vi.fn(() => ({
    system: "distill-system",
    prompt: "distill-prompt",
  })),
  cleanJsonResponse: hoisted.cleanJsonResponse,
}));

vi.mock("@/lib/llm/user-context", () => ({
  getUserContext: hoisted.getUserContext,
  buildUserContextPreamble: hoisted.buildUserContextPreamble,
}));

vi.mock("@/lib/references/extract-section", () => ({
  getBodyTextForContextExtraction: vi.fn((text: string) => text),
}));

vi.mock("@/lib/references/extraction", () => ({
  extractReferenceCandidates: hoisted.extractReferenceCandidates,
}));

vi.mock("@/lib/references/persist", () => ({
  persistExtractedReferences: hoisted.persistExtractedReferences,
}));

vi.mock("@/lib/references/batch-reference-extraction", () => ({
  runHybridReferenceExtractionForPapers: vi.fn(),
}));

vi.mock("@/lib/references/grobid/citation-mentions", () => ({
  GrobidCitationMentionExtractor: vi.fn().mockImplementation(() => ({
    extract: hoisted.grobidExtract,
  })),
}));

vi.mock("@/lib/references/grobid/config", () => ({
  loadGrobidConfig: hoisted.loadGrobidConfig,
}));

vi.mock("@/lib/references/grobid/health", () => ({
  checkGrobidHealth: hoisted.checkGrobidHealth,
}));

vi.mock("@/lib/references/extractors/llm", () => ({
  mapLlmReferencesToCandidates: vi.fn(),
}));

vi.mock("@/lib/citations/citation-mention-service", () => ({
  createCitationMentions: hoisted.createCitationMentions,
  applyLegacyCitationContexts: hoisted.applyLegacyCitationContexts,
}));

vi.mock("@/lib/tags/auto-tag", () => ({
  resolveAndAssignTags: hoisted.resolveAndAssignTags,
  getExistingTagNames: hoisted.getExistingTagNames,
  getScoredTagHints: hoisted.getScoredTagHints,
}));

vi.mock("@/lib/tags/cleanup", () => ({
  refreshTagScores: hoisted.refreshTagScores,
}));

vi.mock("@/lib/canonical/entity-service", () => ({
  collectIdentifiers: vi.fn(() => []),
  resolveOrCreateEntity: vi.fn(),
}));

vi.mock("@/lib/assertions/relation-assertion-service", () => ({
  createRelationAssertion: hoisted.createRelationAssertion,
}));

vi.mock("@/lib/assertions/legacy-projection", () => ({
  projectLegacyRelation: hoisted.projectLegacyRelation,
}));

vi.mock("@/lib/processing/runtime-ledger", () => ({
  createProcessingRun: hoisted.createProcessingRun,
  finishProcessingRun: hoisted.finishProcessingRun,
  setProcessingProjection: hoisted.setProcessingProjection,
  startProcessingStep: hoisted.startProcessingStep,
  clearProcessingStep: hoisted.clearProcessingStep,
  getLatestActiveRunsForPapers: hoisted.getLatestActiveRunsForPapers,
}));

import { runAutoProcessPipeline } from "../../llm/auto-process";
import { runCitationContextSidecarForPapers } from "../batch";
import {
  getLegacyLlmContextFallbackCountForTests,
  resetLegacyLlmContextFallbackCountForTests,
} from "../../llm/provider";

describe("processing LLM context adoption", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetLegacyLlmContextFallbackCountForTests();

    hoisted.getProxyConfig.mockResolvedValue({
      enabled: true,
      vendor: "gateway",
      baseUrl: "https://proxy.example",
      anthropicBaseUrl: "https://proxy.example/anthropic",
      apiKey: "",
      headerName: "x-proxy",
      headerValue: "token",
      modelId: "gpt-4o-mini",
      contextWindow: 128000,
      maxTokens: 4096,
      routes: [],
    });

    hoisted.streamText.mockImplementation(({ prompt }: { prompt: string }) => ({
      text: Promise.resolve(
        prompt.includes("citations")
          ? JSON.stringify([{ citation: "Vaswani et al., 2017", context: "Transformer context" }])
          : JSON.stringify({ tags: ["nlp"] }),
      ),
      usage: Promise.resolve({ inputTokens: 100, outputTokens: 20, totalTokens: 120 }),
    }));
  });

  it("keeps auto-process LLM calls on AsyncLocalStorage without legacy fallback", async () => {
    hoisted.prisma.setting.findUnique.mockResolvedValue(null);
    hoisted.prisma.paper.findUnique.mockResolvedValue({
      id: "paper-auto",
      userId: "user-1",
      title: "Paper Auto",
      abstract: "Abstract",
      authors: null,
      year: 2024,
      venue: null,
      doi: null,
      sourceType: "upload",
      arxivId: null,
      filePath: null,
      fullText: "Short full text for summarization and categorization.",
      entityId: "entity-1",
    });
    hoisted.prisma.paper.update.mockResolvedValue({});

    await runAutoProcessPipeline({
      paperId: "paper-auto",
      skipExtract: true,
      essentialOnly: true,
    });

    expect(getLegacyLlmContextFallbackCountForTests()).toBe(0);
    expect(hoisted.logLlmUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "processing_summarize",
        metadata: expect.objectContaining({
          runtime: "processing",
          source: "auto_process",
          paperId: "paper-auto",
          step: "summarize",
        }),
      }),
    );
    expect(hoisted.logLlmUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "processing_categorize",
        metadata: expect.objectContaining({
          runtime: "processing",
          source: "auto_process",
          paperId: "paper-auto",
          step: "categorize",
        }),
      }),
    );
  });

  it("keeps batch citation-context fallback on AsyncLocalStorage without legacy fallback", async () => {
    hoisted.prisma.paper.findMany.mockResolvedValue([
      {
        id: "paper-batch",
        fullText: "Body text with citations",
        userId: "user-2",
      },
    ]);
    hoisted.prisma.paper.findUnique.mockResolvedValue({ filePath: null });
    hoisted.prisma.reference.count.mockResolvedValue(1);
    hoisted.createCitationMentions.mockResolvedValue({ created: 1, unmatched: 0 });
    hoisted.applyLegacyCitationContexts.mockResolvedValue(1);

    const result = await runCitationContextSidecarForPapers(["paper-batch"], "gpt-4o-mini");

    expect(result).toEqual({
      grobidPapers: 0,
      llmFallbackPapers: 1,
      failedPapers: 0,
    });
    expect(getLegacyLlmContextFallbackCountForTests()).toBe(0);
    expect(hoisted.logLlmUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "processing_extractCitationContexts",
        metadata: expect.objectContaining({
          runtime: "processing",
          source: "batch",
          paperId: "paper-batch",
          step: "extractCitationContexts",
          fallback: "grobid_sidecar",
        }),
      }),
    );
  });
});
