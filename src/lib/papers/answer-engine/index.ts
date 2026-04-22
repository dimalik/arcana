import "server-only";

import type { ConversationArtifactKind } from "@/generated/prisma/client";
import type { LLMProvider } from "@/lib/llm/models";
import type { ProxyConfig } from "@/lib/llm/proxy-settings";
import { SYSTEM_PROMPTS } from "@/lib/llm/prompts";
import { prisma } from "@/lib/prisma";

import { runPaperAnswerAgent } from "./agent/loop";
import {
  type AgentActionSummary,
  type AnswerCitation,
  type ChatMessageMetadata,
  type PaperAnswerIntent,
} from "./metadata";
import { classifyPaperAnswerIntent } from "./intent";

export { normalizeChatHistory } from "./chat-history";
export {
  parseChatMessageMetadata,
  serializeChatMessageMetadata,
  type AnswerCitation,
  type ChatMessageMetadata,
  type PaperAnswerIntent,
} from "./metadata";
export { classifyPaperAnswerIntent } from "./intent";
export {
  createConversationArtifact,
  type ConversationArtifactView,
} from "../analysis/store";

export interface ConversationArtifactDraft {
  kind: ConversationArtifactKind;
  title: string;
  payloadJson: string;
}

export interface PreparedPaperAnswer {
  intent: PaperAnswerIntent;
  systemPrompt: string;
  citations: AnswerCitation[];
  artifacts: ConversationArtifactDraft[];
  agentActions?: AgentActionSummary[];
}

interface PreparePaperAnswerParams {
  paperId: string;
  question: string;
  provider: LLMProvider;
  modelId: string;
  proxyConfig?: ProxyConfig | null;
  userId?: string;
  conversationId?: string;
}

// ---------------------------------------------------------------------------
// Conversation context loader (primary paper + attached papers + selection)
// ---------------------------------------------------------------------------

interface ConversationContext {
  selectedText: string | null;
  additionalPaperIds: string[];
}

async function loadConversationContext(
  conversationId: string | undefined,
): Promise<ConversationContext> {
  if (!conversationId) {
    return { selectedText: null, additionalPaperIds: [] };
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: {
      selectedText: true,
      additionalPapers: {
        select: { paper: { select: { id: true } } },
      },
    },
  });

  if (!conversation) {
    return { selectedText: null, additionalPaperIds: [] };
  }

  return {
    selectedText: conversation.selectedText,
    additionalPaperIds: conversation.additionalPapers.map(
      ({ paper }) => paper.id,
    ),
  };
}

// ---------------------------------------------------------------------------
// Prompt builder for the phase-B streaming answer
// ---------------------------------------------------------------------------

function uniqueCitations(citations: AnswerCitation[]): AnswerCitation[] {
  const seen = new Set<string>();
  return citations.filter((citation) => {
    const key = [
      citation.paperId,
      citation.sourceKind,
      citation.sectionPath ?? "",
      citation.snippet,
    ].join("::");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function formatCitationForPrompt(
  citation: AnswerCitation,
  index: number,
): string {
  const section = citation.sectionPath ? ` / ${citation.sectionPath}` : "";
  return `[S${index + 1}] ${citation.paperTitle}${section}\n${citation.snippet}`;
}

function buildPrompt(params: {
  paperTitle: string;
  question: string;
  intent: PaperAnswerIntent;
  selectedText: string | null;
  citations: AnswerCitation[];
  artifacts: ConversationArtifactDraft[];
  answerPlan?: string | null;
}): string {
  const hasTableArtifact = params.artifacts.some(
    (artifact) => artifact.kind === "TABLE_CARD",
  );
  const sourceBlock =
    params.citations.length > 0
      ? params.citations.map(formatCitationForPrompt).join("\n\n")
      : "No retrieved sources were available.";
  const artifactBlock =
    params.artifacts.length > 0
      ? params.artifacts
          .map(
            (artifact, index) =>
              `Artifact ${index + 1} (${artifact.kind}): ${artifact.title}\n${artifact.payloadJson}`,
          )
          .join("\n\n")
      : "No structured artifact is attached.";
  const selectedTextBlock = params.selectedText
    ? `Selected passage from the conversation:\n${params.selectedText}\n\n`
    : "";
  const answerPlanBlock = params.answerPlan
    ? `\nPlanner note (follow as guidance, not verbatim):\n${params.answerPlan}\n`
    : "";
  const hasCodeArtifact = params.artifacts.some(
    (artifact) => artifact.kind === "CODE_SNIPPET",
  );
  const codeInlineRule = hasCodeArtifact
    ? "- A CODE_SNIPPET artifact is attached. **Reproduce its `code` inline as a fenced markdown block** at the natural place in your answer, using the artifact's `language` on the fence (e.g. ```tex, ```python). Place the code between your introduction and your follow-up notes — do not dump it at the end. Do not write raw JSON from the artifact payload; just the code itself. Prefix the first line of the code block with a comment containing the artifact's filename (e.g. `% artifact-2026-04-21.tex` for LaTeX) when the language supports line comments.\n"
    : "";
  const intentSpecificRules =
    params.intent === "generated_artifact"
      ? "- If you provide code, present it as a derived implementation sketch unless the evidence explicitly supports exact code.\n- Call out any assumptions or missing implementation details.\n"
      : params.intent === "figures" || params.intent === "tables"
        ? "- If a relevant figure or table artifact is attached, anchor the answer in that artifact before generalizing.\n"
        : params.intent === "results"
          ? `- Prioritize numeric outcomes, ablations, and result tables over broad summary language.\n${hasTableArtifact ? "- A matching table artifact is attached. If it contains exactRow or exactValue, answer from that structured fact first; otherwise answer from its matched rows and visible columns before using summary text.\n" : ""}`
          : "";

  return `${SYSTEM_PROMPTS.chat}

You are answering a paper-focused question with a curated evidence packet, not the raw full text.

Rules:
- Use only the retrieved sources and attached structured artifacts below.
- Ignore any general-knowledge allowance from the base chat prompt for this answer.
- Do not use outside knowledge to fill paper-specific gaps.
- If the evidence is insufficient, say so plainly.
- Never write phrases like "likely", "probably", "the paper likely covers", or "based on general knowledge".
- If a requested detail is not in the evidence packet, say that exact detail is missing from the retrieved evidence and stop there.
- Cite supporting evidence inline with the source tags like [S1], [S2].
- If a structured artifact is attached (figures, tables, claim lists, etc.), summarize it instead of reproducing raw JSON. (Exception: code artifacts — see the code-inline rule below.)
- Keep the answer grounded in the paper(s), then add explanation.
${codeInlineRule}${intentSpecificRules}

Primary paper: "${params.paperTitle}"
Intent: ${params.intent}

${selectedTextBlock}User question:
${params.question}

Retrieved sources:
${sourceBlock}

Structured artifacts:
${artifactBlock}${answerPlanBlock}`;
}

// ---------------------------------------------------------------------------
// Public entry point — phase A (model-driven tool loop) + phase-B prompt build
// ---------------------------------------------------------------------------

export async function preparePaperAnswer(
  params: PreparePaperAnswerParams,
): Promise<PreparedPaperAnswer> {
  const conversationContext = await loadConversationContext(
    params.conversationId,
  );
  const intent = classifyPaperAnswerIntent({
    question: params.question,
    additionalPaperCount: conversationContext.additionalPaperIds.length,
  });

  const paperIds = Array.from(
    new Set([params.paperId, ...conversationContext.additionalPaperIds]),
  );

  const evidence = await runPaperAnswerAgent({
    paperIds,
    primaryPaperId: params.paperId,
    question: params.question,
    selectedText: conversationContext.selectedText,
    intentHint: intent,
    provider: params.provider,
    modelId: params.modelId,
    proxyConfig: params.proxyConfig,
    userId: params.userId,
  });

  const primary = await prisma.paper.findUnique({
    where: { id: params.paperId },
    select: { id: true, title: true },
  });
  const paperTitle = primary?.title ?? "this paper";

  const citations: AnswerCitation[] = [];
  if (conversationContext.selectedText) {
    citations.push({
      paperId: params.paperId,
      paperTitle,
      snippet: conversationContext.selectedText,
      sectionPath: null,
      sourceKind: "selection",
    });
  }
  citations.push(...evidence.citations);

  const unique = uniqueCitations(citations).slice(0, 8);

  return {
    intent,
    citations: unique,
    artifacts: evidence.artifacts,
    agentActions: evidence.actions,
    systemPrompt: buildPrompt({
      paperTitle,
      question: params.question,
      intent,
      selectedText: conversationContext.selectedText,
      citations: unique,
      artifacts: evidence.artifacts,
      answerPlan: evidence.answerPlan,
    }),
  };
}

export function buildChatMessageMetadata(params: {
  intent: PaperAnswerIntent;
  citations: AnswerCitation[];
  agentActions?: AgentActionSummary[];
  artifacts?: Array<{
    id?: string;
    kind: string;
    title: string;
    payloadJson: string;
  }>;
}): ChatMessageMetadata {
  return {
    intent: params.intent,
    citations: params.citations,
    ...(params.agentActions?.length
      ? { agentActions: params.agentActions }
      : {}),
    ...(params.artifacts?.length ? { artifacts: params.artifacts } : {}),
  };
}
