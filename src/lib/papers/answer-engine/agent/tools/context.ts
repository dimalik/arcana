import "server-only";

import type { PaperFigureView } from "@/lib/figures/read-model";
import type { LLMProvider } from "@/lib/llm/models";
import type { ProxyConfig } from "@/lib/llm/proxy-settings";

import type {
  AgentObservation,
  AnswerCitation,
  PaperAgentArtifactDraft,
  PaperAgentPaperContext,
  SummarySectionName,
} from "../types";

/**
 * One shared context object threaded into every tool's `execute`.
 * Tools call the `on*` side-effect hooks to accumulate evidence; the
 * loop closure owns the arrays. Tools return a plain string payload
 * to the model.
 */
export interface ToolContext {
  /** All papers attached to the conversation, keyed by id. */
  papers: Map<string, PaperAgentPaperContext>;
  /** Ids in attachment order; also drives the `[P1]`, `[P2]` labels. */
  paperIds: string[];
  /** Paper id → short label for the model (`P1`, `P2`, …). */
  paperLabels: Map<string, string>;
  /** Pre-computed section snapshots per paper. */
  sectionsByPaperId: Map<string, Record<SummarySectionName, string>>;
  /** Pre-loaded figure inventory per paper. */
  figuresByPaperId: Map<string, PaperFigureView[]>;

  /** Identify the primary paper (the one the UI opened chat on). */
  primaryPaperId: string;

  question: string;
  selectedText: string | null;

  provider: LLMProvider;
  modelId: string;
  proxyConfig?: ProxyConfig | null;
  userId?: string;

  /** Record a new citation and return its 1-based index so the tool can cite it. */
  onCitation: (citation: AnswerCitation) => number;
  onArtifact: (artifact: PaperAgentArtifactDraft) => void;
  onObservation: (observation: AgentObservation) => void;
  /** Called when the model invokes `finish`. */
  onFinish: (answerPlan: string) => void;

  /** Monotonic step counter used for observation ordering. */
  nextStep: () => number;
}

export function paperLabelFor(ctx: ToolContext, paperId: string): string {
  return ctx.paperLabels.get(paperId) ?? paperId;
}

export function requirePaper(
  ctx: ToolContext,
  paperId: string,
): PaperAgentPaperContext | null {
  return ctx.papers.get(paperId) ?? null;
}

export function missingPaperMessage(
  ctx: ToolContext,
  paperId: string,
): string {
  const attached = ctx.paperIds
    .map((id) => `${ctx.paperLabels.get(id) ?? id} (id: ${id})`)
    .join(", ");
  return `No paper with id "${paperId}" is attached to this conversation. Attached papers: ${attached}.`;
}
