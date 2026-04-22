import "server-only";

import { generateText, hasToolCall, stepCountIs } from "ai";
import type { PaperFigureView } from "@/lib/figures/read-model";
import {
  PAPER_INTERACTIVE_LLM_OPERATIONS,
  withPaperLlmContext,
} from "@/lib/llm/paper-llm-context";
import { getModel } from "@/lib/llm/provider";
import type { LLMProvider } from "@/lib/llm/models";
import type { ProxyConfig } from "@/lib/llm/proxy-settings";
import { prisma } from "@/lib/prisma";

import {
  buildSectionSnapshots,
  dedupeArtifacts,
  dedupeCitations,
  loadPaperFigures,
  type PaperAgentPaperContext,
} from "../agent";
import type { PaperAnswerIntent } from "../metadata";
import type { PaperClaimView } from "../../analysis/store";
import { getLatestCompletedPaperClaimRun } from "../../analysis/store";

import { buildSystemPrompt } from "./system-prompt";
import { buildToolSet } from "./tools";
import type { ToolContext } from "./tools/context";
import {
  AGENT_MAX_TURNS,
  type AgentObservation,
  type AnswerCitation,
  type PaperAgentArtifactDraft,
  type PreparedPaperAgentEvidenceV2,
  type SummarySectionName,
} from "./types";

const PAPER_CONTEXT_SELECT = {
  id: true,
  title: true,
  year: true,
  abstract: true,
  summary: true,
  keyFindings: true,
  fullText: true,
} as const;

export interface RunPaperAnswerAgentParams {
  paperIds: string[];
  primaryPaperId: string;
  question: string;
  selectedText: string | null;
  intentHint: PaperAnswerIntent;
  provider: LLMProvider;
  modelId: string;
  proxyConfig?: ProxyConfig | null;
  userId?: string;
}

async function loadChatPaperMap(
  paperIds: string[],
): Promise<Map<string, PaperAgentPaperContext>> {
  if (paperIds.length === 0) return new Map();

  const rows = await prisma.paper.findMany({
    where: { id: { in: paperIds } },
    select: PAPER_CONTEXT_SELECT,
  });

  const claimsByPaperId = new Map<string, PaperClaimView[]>();
  await Promise.all(
    rows.map(async (paper) => {
      const run = await getLatestCompletedPaperClaimRun(prisma, paper.id);
      claimsByPaperId.set(paper.id, run?.claims ?? []);
    }),
  );

  const map = new Map<string, PaperAgentPaperContext>();
  for (const paper of rows) {
    map.set(paper.id, {
      ...paper,
      claims: claimsByPaperId.get(paper.id) ?? [],
    });
  }
  return map;
}

export async function runPaperAnswerAgent(
  params: RunPaperAnswerAgentParams,
): Promise<PreparedPaperAgentEvidenceV2> {
  const citations: AnswerCitation[] = [];
  const artifacts: PaperAgentArtifactDraft[] = [];
  const observations: AgentObservation[] = [];
  let answerPlan: string | null = null;
  let stepCounter = 0;

  const papers = await loadChatPaperMap(params.paperIds);
  if (!papers.has(params.primaryPaperId)) {
    throw new Error(
      `Primary paper ${params.primaryPaperId} is not attached to the conversation.`,
    );
  }

  const paperIds = params.paperIds.filter((id) => papers.has(id));
  const paperLabels = new Map<string, string>();
  paperIds.forEach((id, index) => paperLabels.set(id, `P${index + 1}`));

  const sectionsByPaperId = new Map<string, Record<SummarySectionName, string>>();
  const figuresByPaperId = new Map<string, PaperFigureView[]>();
  for (const [id, paper] of Array.from(papers.entries())) {
    sectionsByPaperId.set(id, buildSectionSnapshots(paper));
    figuresByPaperId.set(id, await loadPaperFigures(id));
  }

  const ctx: ToolContext = {
    papers,
    paperIds,
    paperLabels,
    sectionsByPaperId,
    figuresByPaperId,
    primaryPaperId: params.primaryPaperId,
    question: params.question,
    selectedText: params.selectedText,
    provider: params.provider,
    modelId: params.modelId,
    proxyConfig: params.proxyConfig,
    userId: params.userId,
    onCitation: (citation) => {
      citations.push(citation);
      return citations.length;
    },
    onArtifact: (artifact) => {
      artifacts.push(artifact);
    },
    onObservation: (observation) => {
      observations.push(observation);
    },
    onFinish: (plan) => {
      answerPlan = plan;
    },
    nextStep: () => ++stepCounter,
  };

  const toolSet = buildToolSet(ctx);
  const model = await getModel(
    params.provider,
    params.modelId,
    params.proxyConfig ?? undefined,
  );

  const systemPrompt = buildSystemPrompt({
    papers,
    paperIds,
    paperLabels,
    sectionsByPaperId,
    figuresByPaperId,
    primaryPaperId: params.primaryPaperId,
    intentHint: params.intentHint,
    selectedText: params.selectedText,
  });

  await withPaperLlmContext(
    {
      operation: PAPER_INTERACTIVE_LLM_OPERATIONS.CHAT_AGENT_PLAN,
      paperId: params.primaryPaperId,
      userId: params.userId,
      runtime: "interactive",
      source: "papers.answer_engine.agent.v2",
      metadata: {
        intent: params.intentHint,
        paperCount: paperIds.length,
      },
    },
    async () => {
      await generateText({
        model,
        system: systemPrompt,
        prompt: params.question,
        tools: toolSet,
        stopWhen: [stepCountIs(AGENT_MAX_TURNS), hasToolCall("finish")],
      });
    },
  );

  return {
    citations: dedupeCitations(citations).slice(0, 8),
    artifacts: dedupeArtifacts(artifacts),
    actions: observations,
    answerPlan,
  };
}
